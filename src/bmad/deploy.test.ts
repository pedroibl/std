// Story 2.7 acceptance suite — `deploy` (FR-17) and the six-posture fixture harness (BM-9).
//
// THIS STORY BUILDS ALMOST NOTHING AND PROVES EVERYTHING ALREADY BUILT, and the suite is shaped that way.
// `deploy` adds no rule, no per-repo step, no shelled argv and no ledger field over `update` — the whole
// composition is `runBmadDeploy` delegating to `runBmadUpdate`. So the cases below spend almost no effort
// on the command and almost all of it on two things:
//
//   1. THE COMPOSITION IS STRUCTURAL, NOT A PROMISE. `deploy.ts` is grep-gated (below, executed — not
//      left as a runbook step) so a fourth near-copy of the per-repo flow cannot be added to it quietly,
//      and its shelled argv is asserted byte-identical to `update`'s so a re-authored one is caught even
//      if it somehow passed the grep.
//   2. THE SIX REAL ESTATE POSTURES. The rest of the epic was proven against the happy path plus targeted
//      fixtures; this suite runs the whole family across tracked / gitignored / no-upstream / dirty /
//      feature-branch / source-only at once, which is the only place their interactions show up.
//
// THE INHERITED DATA-LOSS HAZARD IS WHY (1) MATTERS AT ALL. `bmad install --action update` treats
// `--modules` as the set that should EXIST, so a leg naming fewer built-ins than a repo carries DELETES
// the rest — measured against the real 6.10.0 binary in Story 2.5. `update` closes that by PROBING each
// repo's disk. `deploy` composes the same leg, so a delegation that lost the probed set would delete a
// built-in module from every repo in the estate at once. That is the worst failure available to this
// command, and the byte-identity case is what stands between here and there — which is why it is run in
// both directions, with a deliberately-wrong leg proving the assertion can go red.
//
// LAYERS: cases 1–10 are HERMETIC (no real `bmad`) and ALWAYS run — every AC has at least one hermetic
// case, so no claim's only evidence is a test that skips. Cases 11–12 are LIVE and skip without a binary.
//
// IDENTITY-FREE (D4): every path is `os.tmpdir()`-derived and every repo name is generic. The
// `check:no-consumer-ids` gate skips `*.test.ts`, so this is discipline rather than gate-driven — and the
// harness this file drives is NOT exempt, which is why it is checked here too.

import { afterAll, describe, expect, jest, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { git as realGit } from "../git/index";
import { spawnCapture } from "../proc/index";
import { batchExit, runBatch } from "./batch";
import { verifyRepo } from "./bmad-verify";
import {
  ALL_POSTURES,
  FIXTURE_FEATURE_BRANCH,
  FIXTURE_IDENTITY,
  type FixtureEstate,
  type FixturePosture,
  type FixtureRepoOpts,
  fixtureGit,
  makeEstateModule,
  makeFixtureEstate,
  makeFixtureRepo,
  makeScratchRepo,
  removeTempTree,
  resolveBmadBin,
  resolveEstateModule,
} from "./bmad.test-helpers";
import { runBmadDeploy } from "./deploy";
import type { BmadDeps, InstallLeg, RepoResult } from "./deps";
import { pushGate } from "./git-safety";
import type { BmadRepo } from "./manifest";
import { DEFAULT_SKILLS, parseBmadOpts } from "./opts";
import { skillTreeDigest } from "./pipeline";
import { runBmadUpdate } from "./update";

/**
 * Every case here builds real git repos and (in the live layer) shells a real installer. bun's 5s
 * default is a performance assertion in disguise; a timeout is a HANG guard. Same reasoning, and the
 * same ceiling, as `git-safety.test.ts`.
 */
jest.setTimeout(300_000);

const SELECTED = [...DEFAULT_SKILLS];
const CLAUDE_SKILLS = join(".claude", "skills");
const AGENTS_SKILLS = join(".agents", "skills");

/**
 * The git config key for a commit email — ASSEMBLED AT RUNTIME, never spelled literally in this file.
 *
 * AC11's gate below counts the files under `src/bmad/` that DECLARE a fixture identity, and it must
 * count this one honestly. Writing the key literally here would make `deploy.test.ts` a permanent second
 * hit, forcing the gate to exempt itself by name — after which a genuine second declaration added to
 * this file would go unnoticed, which is the fork hazard AC11 exists to catch.
 */
const EMAIL_KEY = ["user", "email"].join(".");

/** The estate the hermetic layer installs from — synthetic, never the package's own shipped payload. */
const FIXTURE_MODULE = makeEstateModule({ skills: SELECTED });

const scratch = mkdtempSync(join(tmpdir(), "bmad-deploy-"));
afterAll(() => {
  removeTempTree(scratch);
  removeTempTree(FIXTURE_MODULE);
});

let seq = 0;
function fresh(prefix: string): string {
  const dir = join(scratch, `${prefix}-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function put(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf-8");
}

/** Write a `[[repos]]` TOML the real `loadManifest` will parse — no hand-built `BmadRepo[]` shortcut. */
function writeManifest(entries: readonly BmadRepo[]): string {
  const body = entries
    .map((e) => {
      const rows = [
        `path = ${JSON.stringify(e.path)}`,
        `claudeTracked = ${e.claudeTracked}`,
        `hasUpstream = ${e.hasUpstream}`,
      ];
      if (e.name !== undefined) rows.push(`name = ${JSON.stringify(e.name)}`);
      if (e.role !== undefined) rows.push(`role = ${JSON.stringify(e.role)}`);
      return `[[repos]]\n${rows.join("\n")}\n`;
    })
    .join("\n");
  const path = join(scratch, `estate-${seq++}.toml`);
  writeFileSync(path, body, "utf-8");
  return path;
}

// ── the rig ───────────────────────────────────────────────────────────────────────────────────────

interface Spy {
  /** Every subprocess, in order. */
  exec: { cmd: string; args: string[] }[];
  /** Every `deps.git` call, with its repo — needed because a per-repo claim cannot be made on argv alone. */
  git: { repo: string; args: string[] }[];
  /** Every fs WRITE the family made (the installer's own writes do not go through the seam). */
  writes: { kind: string; path: string }[];
  /**
   * ONE ordered timeline across `exec` and the fs writes. Two separate arrays cannot answer "was the
   * backup taken BEFORE the installer ran", which is the FR-7 reversibility claim.
   */
  events: string[];
  print: string[];
  logged: string[];
  json: unknown[];
}

interface RigOpts {
  /** Replace the subprocess result entirely, keyed on the invocation. `undefined` ⇒ the default. */
  execStub?: (cmd: string, args: string[]) => { stdout: string; stderr: string; code: number } | undefined;
  moduleRoot?: string;
  bmadBin?: string;
  /**
   * `true` ⇒ `deps.exec` shells EVERYTHING for real, including the installer — the live layer.
   *
   * ⚠ THE DEFAULT (`false`) FAKES THE INSTALLER, AND A "LIVE" CASE THAT FORGOT THIS FLAG IS A FALSE
   * GREEN OF THE WORST KIND: it reports a real install having shelled nothing, and its assertions pass
   * against a fixture that was pre-rendered at seed time. Caught here once already. The live cases pair
   * this flag with a fixture seeded with NO Surfaces, so the trees exist afterwards only if a real
   * binary wrote them — belt and braces, because the flag alone is a thing a future edit can drop.
   */
  live?: boolean;
}

interface Rig {
  deps: BmadDeps;
  spy: Spy;
  stateHome: string;
}

/**
 * A fully-wired seam over REAL temp trees. Only `bmad` is faked.
 *
 * The reads (`exists`, `readIfExists`, `listDirs`) and `git` are REAL: the built-in probe stats real
 * directories, the guard walks a real module, the digest reads real bytes and the git spine drives real
 * git against real repos. A recorded-call-only fake would let every one of those pass while doing
 * nothing — which is the class of false green this whole epic keeps producing.
 *
 * `diff` goes to the REAL `spawnCapture` for the same reason: a stubbed-green verification would let
 * every `ok` below be asserted over a comparison that never happened.
 */
function rig(manifestPath: string, opts: RigOpts = {}): Rig {
  const spy: Spy = { exec: [], git: [], writes: [], events: [], print: [], logged: [], json: [] };
  const stateHome = fresh("state");
  const moduleRoot = opts.moduleRoot ?? FIXTURE_MODULE;
  const bmadBin = opts.bmadBin ?? "bmad-under-test";

  const record = (kind: string, path: string): void => {
    spy.writes.push({ kind, path });
    spy.events.push(`write:${kind}:${path}`);
  };

  const deps: BmadDeps = {
    exec: async (cmd, args, o) => {
      spy.exec.push({ cmd, args });
      spy.events.push(`exec:${cmd}:${args.join(" ")}`);
      if (cmd === "diff") return spawnCapture(cmd, args, o);
      // The live layer: no fake anywhere in the chain. A generous timeout — a real `bmad install`
      // resolves and renders a module tree, which is seconds, not milliseconds.
      if (opts.live === true) return spawnCapture(cmd, args, { ...o, timeout: 120_000 });

      const stubbed = opts.execStub?.(cmd, args);
      if (stubbed !== undefined) return stubbed;

      // A SUCCESSFUL install renders both Surfaces from its `--custom-source`, standing in for the
      // EXTERNAL installer's writes. Deliberately a plain `cpSync` and not a `deps.fs` call: routing it
      // through the seam would make `spy.writes` report bmad-manager as having copied into the repo.
      // Gated on the source flag because the built-in leg carries none and renders nothing — which is
      // what the real binary does, measured in 2.5.
      const target = valueOf(args, "--directory") ?? "";
      const source = valueOf(args, "--custom-source") ?? "";
      if (target !== "" && source !== "") {
        for (const skill of readdirSync(join(source, "skills"))) {
          for (const surface of [CLAUDE_SKILLS, AGENTS_SKILLS]) {
            cpSync(join(source, "skills", skill), join(target, surface, skill), { recursive: true });
          }
        }
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    // RECORDS, THEN RUNS THE REAL WRAPPER (2.4's pattern) — a single run both does the work and exposes
    // exactly what it asked git to do.
    git: (repo, args) => {
      spy.git.push({ repo, args });
      return realGit(repo, args);
    },
    fs: {
      readIfExists: (p) => {
        try {
          return readFileSync(p, "utf-8");
        } catch {
          return null;
        }
      },
      exists: (p) => existsSync(p),
      ensureDir: (dir) => {
        record("ensureDir", dir);
        mkdirSync(dir, { recursive: true });
      },
      atomicWrite: (p, content) => {
        record("atomicWrite", p);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content, "utf-8");
      },
      cpDir: (src, dest) => {
        record("cpDir", dest);
        cpSync(src, dest, { recursive: true });
      },
      listDirs: (root) => {
        try {
          return readdirSync(root, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort();
        } catch {
          return [];
        }
      },
    },
    report: {
      lines: () => {
        const buf: string[] = [];
        return { p: (l = "") => void buf.push(l), toString: () => buf.join("\n") };
      },
      jsonOutput: (d) => JSON.stringify(d, null, 2),
      emitJson: (d) => void spy.json.push(d),
      log: (m) => void spy.logged.push(m),
      print: (m) => void spy.print.push(m),
    },
    // FIXED (BM-8). The staging dir and every `backupPath` embed `deps.clock()`, so two runs are only
    // comparable — which is the whole of the byte-identity case — under one fixed clock.
    clock: () => "T0",
    bmadBin,
    manifestPath,
    estateModulePath: moduleRoot,
    backupRoot: join(stateHome, "backups"),
  };

  return { deps, spy, stateHome };
}

/** The value following `flag`, or `undefined`. */
function valueOf(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv[i + 1];
}

/** Every `bmad` invocation the run shelled, in order — the verification `diff` calls excluded. */
function bmadCalls(spy: Spy, bin = "bmad-under-test"): string[][] {
  return spy.exec.filter((e) => e.cmd === bin).map((e) => e.args);
}

/** Every `diff` invocation, in order. */
function diffCalls(spy: Spy): string[][] {
  return spy.exec.filter((e) => e.cmd === "diff").map((e) => e.args);
}

/** The `deps.git` argv issued against one repo. */
function gitFor(spy: Spy, repo: string): string[][] {
  return spy.git.filter((c) => c.repo === repo).map((c) => c.args);
}

/** The ledger rows a `--json` run emitted. */
function rowsOf(spy: Spy): RepoResult[] {
  return (spy.json[0] as { repos: RepoResult[] } | undefined)?.repos ?? [];
}

/** Build the standard hermetic estate: all six postures, seeded from the synthetic module. */
async function hermeticEstate(
  postures: readonly FixturePosture[] = ALL_POSTURES,
  perRepo: (posture: FixturePosture, i: number) => Partial<FixtureRepoOpts> = () => ({}),
): Promise<FixtureEstate> {
  return makeFixtureEstate(postures, (posture, i) => ({
    moduleRoot: FIXTURE_MODULE,
    skills: SELECTED,
    // Small, because 503 real files × 6 postures × a dozen cases is minutes of pure fixture IO. The
    // FR-11 case that actually needs the real count asks for it explicitly.
    dirtyCount: 5,
    ...perRepo(posture, i),
  }));
}

/** The repo names `selectRepos` will keep from an estate — the Manifest minus `role:'source-only'`. */
function selectedNames(estate: FixtureEstate): string[] {
  return estate.manifest.filter((r) => r.role !== "source-only").map((r) => r.name as string);
}

// ══ CASE 1 — AC1: the `--repos` refusal ═══════════════════════════════════════════════════════════

describe("AC1 — deploy is estate-wide by construction and REFUSES --repos", () => {
  // EVERY SPELLING, because the guard is three predicates and each covers the others' blind spot. A
  // two-guard version passes for `--repos alpha` and silently deploys estate-wide for `--repos=`.
  test("CASE 1 — every --repos spelling ⇒ exit 2, and nothing is read, shelled, written or committed", async () => {
    const estate = await hermeticEstate();
    try {
      const manifestPath = writeManifest(estate.manifest);
      for (const argv of [
        ["--repos", "alpha"],
        ["--repos", "alpha", "--apply"],
        ["--repos", "alpha", "--apply", "--push"],
        ["--repos"], // bare — `flagValue` reads past the end, so only `hasFlag` sees it
        ["--repos="], // empty equals — `flagValue` returns "", which the selector normalises away
        ["--repos=alpha", "--apply"],
      ]) {
        const { deps, spy } = rig(manifestPath);
        expect(await runBmadDeploy(argv, deps)).toBe(2);
        // Refused BEFORE anything happened — not after a batch that merely declined to act.
        expect(spy.exec).toHaveLength(0);
        expect(spy.git).toHaveLength(0);
        expect(spy.writes).toHaveLength(0);
        expect(spy.print).toHaveLength(0);
        expect(spy.json).toHaveLength(0);
        // Named, and it names the alternative — a bare "not accepted" leaves the operator nowhere.
        expect(spy.logged.join("\n")).toContain("--repos is not accepted");
        expect(spy.logged.join("\n")).toContain("std bmad update --repos");
      }
    } finally {
      await estate.cleanup();
    }
  });

  // THE OTHER HALF, and the one a "just drop the flag on the floor" regression would sail through:
  // refusing is only correct if deploy WITHOUT `--repos` is still the whole default set.
  test("CASE 2 — without --repos, deploy runs the DEFAULT set and source-only never reaches the batch", async () => {
    const estate = await hermeticEstate();
    try {
      const { deps, spy } = rig(writeManifest(estate.manifest));
      expect(await runBmadDeploy(["--apply", "--json"], deps)).toBe(0);

      const rows = rowsOf(spy);
      expect(rows.map((r) => r.repo)).toEqual(selectedNames(estate));
      expect(rows.map((r) => r.repo)).not.toContain("source-only");
      // AC6#6 — excluded from the default set AND never touched: no invocation names its directory.
      const sourceOnly = estate.repos.find((r) => r.posture === "source-only")!;
      expect(bmadCalls(spy).some((a) => a.includes(sourceOnly.dir))).toBe(false);
      expect(gitFor(spy, sourceOnly.dir)).toHaveLength(0);
    } finally {
      await estate.cleanup();
    }
  });
});

// ══ CASE 3 — AC9(i): the SM-3 cardinality claim, hermetically ═════════════════════════════════════

describe("AC9(i) — the 9-target dry-run cardinality (SM-3 half (i), the automatable half)", () => {
  // The real hand-derived 9-target PLAN exists nowhere machine-readable — every reference in the
  // planning tree is prose — so "compare against the plan" is unexecutable. What IS executable, and what
  // SM-3's number actually asserts, is the CARDINALITY and the exclusion. Proved over a synthetic
  // 10-entry manifest with identity-free names and no real directories at all.
  test("CASE 3 — a 10-entry manifest (9 target + 1 source-only) plans EXACTLY 9, each with a full plan", async () => {
    const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota"];
    const entries: BmadRepo[] = [
      ...names.map((n) => ({
        path: join(scratch, "synthetic", n),
        tools: ["claude-code"],
        claudeTracked: true,
        hasUpstream: true,
        name: n,
      })),
      {
        path: join(scratch, "synthetic", "nested-src"),
        tools: ["claude-code"],
        claudeTracked: false,
        hasUpstream: false,
        name: "nested-src",
        role: "source-only" as const,
      },
    ];
    expect(entries).toHaveLength(10);

    // Dry run, and no directory exists — `deps.fs.exists` answers `false` and `git` fails soft to `""`,
    // which is exactly what a plan-only run needs. No fixture repos are built for this case at all.
    const { deps, spy } = rig(writeManifest(entries));
    expect(await runBmadDeploy(["--json"], deps)).toBe(0);

    const rows = rowsOf(spy);
    expect(rows).toHaveLength(9);
    expect(rows.map((r) => r.repo)).toEqual(names);
    expect(rows.map((r) => r.repo)).not.toContain("nested-src");
    for (const r of rows) {
      // A fully-populated INTENT on every row (BM-14) — a plan of nine empty projections is not a plan.
      expect(r.planned.installArgv.length).toBeGreaterThan(0);
      expect(r.planned.backupPath).toContain("T0");
      expect(r.planned.wouldPush).toBe(false);
    }
    // Dry run: nothing shelled, nothing written.
    expect(spy.exec).toHaveLength(0);
    expect(spy.writes).toHaveLength(0);
  });
});

// ══ CASE 4 — AC3: argv byte-identity vs `update` ══════════════════════════════════════════════════

describe("AC3 — deploy issues argv BYTE-IDENTICAL to update (the delegation regression guard)", () => {
  // GREEN BY CONSTRUCTION TODAY, and stated as such: with the delegation in place this cannot fail now.
  // Its job is to fail LATER, the moment someone gives `deploy` an invocation of its own — which is the
  // change that would silently drop the probed built-in set and delete a module estate-wide.
  test("CASE 4 — same estate, same flags, ONE fixed clock ⇒ identical ordered exec calls", async () => {
    // Built-ins vary PER REPO, deliberately. If every fixture carried the same set, a hardcoded
    // `--modules core,bmm` would match the probe everywhere and this case could not tell a correct
    // per-repo probe from a lucky constant.
    const estate = await hermeticEstate(["tracked", "no-upstream", "dirty"], (posture) => ({
      builtins: posture === "tracked" ? ["core", "bmm"] : ["core"],
    }));
    try {
      // ONE rig, so both runs share a manifest, a module, a state home and a clock. Two rigs would
      // differ in their staging path for a reason that has nothing to do with the claim.
      const manifestPath = writeManifest(estate.manifest);
      const { deps, spy } = rig(manifestPath);

      await runBmadDeploy(["--apply"], deps);
      const deployCalls = spy.exec.map((e) => ({ cmd: e.cmd, args: e.args }));
      spy.exec.length = 0;

      await runBmadUpdate(["--apply"], deps);
      const updateCalls = spy.exec.map((e) => ({ cmd: e.cmd, args: e.args }));

      expect(deployCalls.length).toBeGreaterThan(0);
      expect(JSON.stringify(deployCalls)).toBe(JSON.stringify(updateCalls));

      // The claim above is only worth anything if the argv it compares carries the PROBED set. Assert
      // it directly: the repo holding two built-ins must be told about both, and the ones holding one
      // must be told about one. A delegation that reintroduced a constant fails here first.
      const twoBuiltins = estate.repos.find((r) => r.posture === "tracked")!;
      const oneBuiltin = estate.repos.find((r) => r.posture === "dirty")!;
      for (const argv of bmadCalls(spy).filter((a) => a.includes(twoBuiltins.dir))) {
        expect(valueOf(argv, "--modules")).toBe("core,bmm");
      }
      for (const argv of bmadCalls(spy).filter((a) => a.includes(oneBuiltin.dir))) {
        expect(valueOf(argv, "--modules")).toBe("core");
      }
    } finally {
      await estate.cleanup();
    }
  });

  // RED-TURNING INPUT, RUN — not reasoned about. A `deploy` with its own invocation and a hardcoded
  // `--modules core,bmm` is exactly the regression the case above exists to catch, and this proves the
  // equality actually breaks on it rather than being vacuously true.
  //
  // It is also the data-loss hazard itself, made visible: the `dirty` repo below carries `core` alone,
  // and the hardcoded argv asks the installer to make its module set `core,bmm` — a WIDENING. Against a
  // repo carrying `core,bmm` the same constant paired with a narrower probe is the DELETION direction.
  test("CASE 4 (red) — a hardcoded --modules in deploy's own leg BREAKS the equality", async () => {
    const estate = await hermeticEstate(["tracked", "dirty"], (posture) => ({
      builtins: posture === "tracked" ? ["core", "bmm"] : ["core"],
    }));
    try {
      const manifestPath = writeManifest(estate.manifest);
      const { deps, spy } = rig(manifestPath);

      await runBmadUpdate(["--apply"], deps);
      const updateCalls = bmadCalls(spy).map((a) => [...a]);
      spy.exec.length = 0;

      // The counterfactual `deploy.ts`: its own leg, a constant module set.
      const hardcodedLeg: InstallLeg = {
        kind: "update",
        buildArgv: (ctx) => [
          ["install", "--directory", ctx.repo.path, "--modules", "core,bmm", "--action", "update", "--yes"],
        ],
      };
      const opts = parseBmadOpts(["--apply"]);
      await runBatch([...estate.manifest.filter((r) => r.role !== "source-only")], hardcodedLeg, opts, deps);
      const forkedCalls = bmadCalls(spy).map((a) => [...a]);

      expect(forkedCalls.length).toBeGreaterThan(0);
      expect(JSON.stringify(forkedCalls)).not.toBe(JSON.stringify(updateCalls));
      // …and specifically in the module set, which is the part that deletes things.
      expect(forkedCalls.some((a) => valueOf(a, "--modules") === "core,bmm")).toBe(true);
      const dirtyRepo = estate.repos.find((r) => r.posture === "dirty")!;
      expect(
        forkedCalls.filter((a) => a.includes(dirtyRepo.dir)).map((a) => valueOf(a, "--modules")),
      ).toEqual(["core,bmm"]); // the probe said `core` — this constant would widen the repo
    } finally {
      await estate.cleanup();
    }
  });
});

// ══ CASES 5–7 — AC4: dry-run default, --apply authorizes, --push never implied ════════════════════

describe("AC4 — dry-run is the default; --apply authorizes; --push is NEVER implied", () => {
  test("CASE 5 — no --apply ⇒ ZERO mutation across the whole fixture estate, plan fully populated", async () => {
    const estate = await hermeticEstate();
    try {
      const { deps, spy } = rig(writeManifest(estate.manifest));
      expect(await runBmadDeploy(["--json"], deps)).toBe(0);

      // No subprocess at all — not the installer, not even the verification `diff`.
      expect(spy.exec).toHaveLength(0);
      expect(spy.writes).toHaveLength(0);
      // Reads are permitted and expected (the live posture read runs in both modes); WRITES are not.
      for (const { args } of spy.git) {
        expect(["add", "commit", "push", "checkout", "reset"]).not.toContain(args[0]);
      }
      for (const r of rowsOf(spy)) {
        expect(r.stagedPaths).toEqual([]);
        expect(r.committed).toBe(false);
        expect(r.pushed).toBe(false);
        expect(r.planned.installArgv.length).toBeGreaterThan(0);
      }
    } finally {
      await estate.cleanup();
    }
  });

  test("CASE 6 — --apply WITHOUT --push pushes in NO repo, and every backup precedes its own install", async () => {
    const estate = await hermeticEstate();
    try {
      const { deps, spy } = rig(writeManifest(estate.manifest));
      expect(await runBmadDeploy(["--apply", "--json"], deps)).toBe(0);

      // ACROSS EVERY REPO, not "the first one did not push" — deploy's blast radius is the whole set.
      expect(spy.git.filter((c) => c.args[0] === "push")).toHaveLength(0);
      for (const r of rowsOf(spy)) expect(r.pushed).toBe(false);

      // NFR-1 reversibility: for each repo that was installed into, its backup write appears in the
      // timeline BEFORE the first invocation aimed at it. A backup taken after the mutation reverses
      // nothing, and nothing else in the suite would notice the reordering.
      for (const f of estate.repos.filter((r) => r.posture !== "source-only")) {
        const backupAt = spy.events.findIndex(
          (e) => e.startsWith("write:") && e.includes(`${sep}backups${sep}${f.entry.name}${sep}`),
        );
        const installAt = spy.events.findIndex(
          (e) => e.startsWith("exec:bmad-under-test:") && e.includes(f.dir),
        );
        expect(backupAt).toBeGreaterThanOrEqual(0);
        expect(installAt).toBeGreaterThanOrEqual(0);
        expect(backupAt).toBeLessThan(installAt);
        // …and out of the repo (BM-8) — an in-repo backup would become dirty-tree noise fighting FR-11.
        expect(spy.writes.some((w) => w.path.startsWith(f.dir))).toBe(false);
      }
    } finally {
      await estate.cleanup();
    }
  });

  test("CASE 7 — --apply --push: `push -u origin <live branch>` where no upstream exists", async () => {
    const estate = await hermeticEstate();
    try {
      const { deps, spy } = rig(writeManifest(estate.manifest));
      expect(await runBmadDeploy(["--apply", "--push", "--json"], deps)).toBe(0);

      const noUpstream = estate.repos.find((r) => r.posture === "no-upstream")!;
      const feature = estate.repos.find((r) => r.posture === "feature-branch")!;
      const tracked = estate.repos.find((r) => r.posture === "tracked")!;

      // FR-14: no `@{u}` ⇒ `push -u origin <branch>`, and the branch is the LIVE one, never the
      // Manifest's informational `branch?`.
      expect(gitFor(spy, noUpstream.dir).filter((a) => a[0] === "push")).toEqual([
        ["push", "-u", "origin", "main"],
      ]);
      expect(gitFor(spy, feature.dir).filter((a) => a[0] === "push")).toEqual([
        ["push", "-u", "origin", FIXTURE_FEATURE_BRANCH],
      ]);
      // An existing upstream ⇒ a bare `push`.
      expect(gitFor(spy, tracked.dir).filter((a) => a[0] === "push")).toEqual([["push"]]);

      // The live branch is what the LEDGER reports too — hardcoding `main` would pass the argv assert
      // above and still misreport the repo.
      const rows = rowsOf(spy);
      expect(rows.find((r) => r.repo === feature.entry.name)!.branch).toBe(FIXTURE_FEATURE_BRANCH);
      // The pushes really took: `pushed` is set only after re-reading `@{u}..HEAD` as 0.
      expect(rows.find((r) => r.repo === noUpstream.entry.name)!.pushed).toBe(true);
      expect(rows.find((r) => r.repo === feature.entry.name)!.pushed).toBe(true);
    } finally {
      await estate.cleanup();
    }
  });
});

// ══ CASE 8 — AC6#2 + AC7(a): gitignored is non-failing, and verify still RAN on it ════════════════

describe("AC6/AC7(a) — the gitignored posture, and verification ran on every eligible repo", () => {
  test("CASE 8 — skipped-gitignored is non-failing, never `add -f`, and verify ran on it too", async () => {
    const estate = await hermeticEstate();
    try {
      const { deps, spy } = rig(writeManifest(estate.manifest));
      expect(await runBmadDeploy(["--apply", "--json"], deps)).toBe(0);

      const rows = rowsOf(spy);
      const ignored = estate.repos.find((r) => r.posture === "gitignored")!;
      const row = rows.find((r) => r.repo === ignored.entry.name)!;
      expect(row.status).toBe("skipped-gitignored");
      expect(row.reason).toContain("gitignored");
      // NON-FAILING (BM-17) — it is a reported, expected outcome, and the run exits 0.
      expect(batchExit(rows)).toBe(0);
      // No `add` at all, and emphatically no `-f`: `--force-track` is the only route to that and it was
      // not passed.
      expect(gitFor(spy, ignored.dir).filter((a) => a[0] === "add")).toHaveLength(0);
      expect(gitFor(spy, ignored.dir).flat()).not.toContain("-f");

      // AC7(a) — THE PER-FIXTURE PRESENCE LOOP IS THE LOAD-BEARING ASSERT. BM-17: read-only filters still
      // run on a non-committing repo, so the gitignored fixture MUST appear here. A
      // `if (!repo.claudeTracked) continue` added above the verification filter drops it silently.
      const eligible = estate.repos.filter((r) => r.posture !== "source-only");
      const diffs = diffCalls(spy);
      for (const f of eligible) {
        expect(diffs.some((a) => a.some((operand) => operand.startsWith(f.dir)))).toBe(true);
      }
      // …with the TOTAL as the cross-check. It is `1 + |skills|` per repo, NOT 1: one whole-Surface
      // Parity comparison, plus one Faithfulness comparison per SELECTED skill. Set-Parity shells
      // nothing (it is in-process over `listDirs`). Derived, then asserted — a flat `=== eligible.length`
      // would be red on arrival and would invite weakening the real assert above.
      expect(diffs).toHaveLength(eligible.length * (1 + SELECTED.length));
      // The story's derived 15, pinned — WITH its inputs, so a legitimate change to either one shows up
      // as a named mismatch here rather than as an unexplained count that the next reader "fixes".
      expect(eligible).toHaveLength(ALL_POSTURES.length - 1); // 6 postures − 1 source-only = 5
      expect(SELECTED).toHaveLength(2); // BM-12's default loop-family pair
      expect(diffs).toHaveLength(15);
    } finally {
      await estate.cleanup();
    }
  });

  // AC7(a)'s READ-ONLY half, isolated so it cannot be confounded by the backup and staging writes the
  // surrounding pipeline legitimately makes. A whole-pass "writes[] is empty under --apply" claim is
  // simply false — the backup writes — so asserting it would have to be weakened or deleted by the next
  // reader. This measures the verification engine's own write delta directly, and it is zero.
  test("CASE 8b — verifyRepo itself writes NOTHING and issues no git verb, even under --apply", async () => {
    const f = await makeFixtureRepo("tracked", { moduleRoot: FIXTURE_MODULE, skills: SELECTED });
    try {
      const { deps, spy } = rig(writeManifest([f.entry]));
      const findings = await verifyRepo(f.dir, SELECTED, FIXTURE_MODULE, deps);
      expect(findings.filter((x) => x.severity === "error")).toHaveLength(0);
      expect(spy.writes).toHaveLength(0);
      expect(spy.git).toHaveLength(0);
      // It really did compare something — a zero-finding report over zero comparisons is the false green
      // this engine exists to prevent.
      expect(diffCalls(spy)).toHaveLength(1 + SELECTED.length);
    } finally {
      await f.cleanup();
    }
  });
});

// ══ CASE 9 — AC8: a partially-deployed estate can NEVER report success ════════════════════════════

describe("AC8 — a partially-deployed estate can never report success (FR-15/BM-11/BM-16)", () => {
  // DISTINCTIVE AND NON-EMPTY, and asserted so. `expect(md).toContain("")` is vacuously true for every
  // string, so an empty injected stderr would make the "verbatim" claim unfalsifiable — and an empty
  // `reason` is reachable in production, because `spawnCapture` returns 124 on timeout and 128+signo on
  // a signal kill with only the output captured so far. That gap belongs to the pipeline; what this owes
  // is a test that cannot be fooled by it.
  const INJECTED = "bmad: ancestor conflict in the estate module — refusing";

  test("CASE 9 — one repo fails ⇒ the batch continues, in order, and the render names every repo", async () => {
    // THE FAILURE IS INJECTED INTO A REPO WITH SUCCESSORS, deliberately. Injecting it into the LAST
    // selected repo makes the "the batch continued" assert VACUOUS — there is nothing after it to run.
    const estate = await hermeticEstate();
    try {
      const failing = estate.repos.find((r) => r.posture === "no-upstream")!;
      const names = selectedNames(estate);
      expect(names.indexOf(failing.entry.name as string)).toBeLessThan(names.length - 1);

      const { deps, spy } = rig(writeManifest(estate.manifest), {
        execStub: (cmd, args) =>
          cmd === "bmad-under-test" && args.includes(failing.dir)
            ? { stdout: "", stderr: INJECTED, code: 3 }
            : undefined,
      });

      // (d) the family exit code is 1 when any repo failed. Run once in HUMAN mode, because AC8(e) is a
      // claim about the markdown an operator reads and `--json` renders that instead, not as well.
      expect(await runBmadDeploy(["--apply"], deps)).toBe(1);
      const md = spy.print.join("\n");

      // …then again under `--json` for the ledger. Same fixtures, same injection: the second run is
      // idempotent for everything this case asserts, and the failing repo fails identically.
      spy.exec.length = 0;
      expect(await runBmadDeploy(["--apply", "--json"], deps)).toBe(1);
      const rows = rowsOf(spy);
      expect(batchExit(rows)).toBe(1);

      const failedRow = rows.find((r) => r.repo === failing.entry.name)!;
      // (b) the injected stderr, VERBATIM — never paraphrased, never truncated.
      expect(failedRow.status).toBe("failed");
      expect(failedRow.reason).toBeTruthy();
      expect(failedRow.reason).toContain(INJECTED);

      // (a) every OTHER repo is non-failing. Not blanket `'ok'`: the gitignored posture's correct
      // terminal state is `skipped-gitignored`, and asserting `'ok'` for it would be asserting a bug.
      for (const r of rows.filter((x) => x.repo !== failing.entry.name)) {
        expect(r.status).not.toBe("failed");
      }
      expect(rows.filter((r) => r.status === "ok").length).toBeGreaterThan(0);

      // (c) the batch CONTINUED, in Manifest order — caught by length AND by order, so a short-circuit
      // cannot hide behind a re-sorted result set.
      expect(rows.map((r) => r.repo)).toEqual(names);

      // (e) the RENDERED markdown names every repo and the failure reason. A summary that collapsed to
      // "N repos processed" or printed a blanket verdict cannot pass this.
      expect(md).not.toBe("");
      for (const r of rows) expect(md).toContain(r.repo);
      expect(md).toContain(INJECTED);
    } finally {
      await estate.cleanup();
    }
  });
});

// ══ CASE 10 — FR-10 idempotency, hermetically ═════════════════════════════════════════════════════

describe("FR-10 — idempotency, provable without a binary", () => {
  // HERMETIC ON PURPOSE. `skillTreeDigest` is pure, so FR-10's claim can be proven with no installer at
  // all — and it must be, or its only evidence would be a test that skips whenever `bmad` is absent,
  // which is exactly what this suite forbids elsewhere.
  test("CASE 10 — regenerated config does not move the digest; a real skill byte does", async () => {
    const f = await makeFixtureRepo("tracked", { moduleRoot: FIXTURE_MODULE, skills: SELECTED });
    try {
      const { deps } = rig(writeManifest([f.entry]));
      const before = skillTreeDigest(f.dir, deps);

      // The three by-design regeneration locations. `bmad install` rewrites these on every run, so
      // counting them as drift would make every verification red.
      put(join(f.dir, "_bmad", "_config", "manifest.yaml"), "regenerated: 1\n");
      put(join(f.dir, "_bmad", "config.toml"), "regenerated = 1\n");
      put(join(f.dir, "_bmad", "scripts", "x.py"), "# regenerated\n");
      expect(skillTreeDigest(f.dir, deps)).toBe(before);

      // …and one real byte under a Surface DOES move it. Without this half the assert above is
      // satisfied by a digest that always returns the same constant.
      const skill = SELECTED[0]!;
      put(join(f.dir, CLAUDE_SKILLS, skill, "SKILL.md"), `# ${skill}\n\ndrift\n`);
      expect(skillTreeDigest(f.dir, deps)).not.toBe(before);
    } finally {
      await f.cleanup();
    }
  });
});

// ══ AC5/AC6/AC11 — the harness itself, and the four traps it closes ═══════════════════════════════

describe("AC5/AC6 — the six-posture harness, and the traps that make it honest", () => {
  test("the partition is SIX, and every posture is distinguishable on disk", async () => {
    expect(ALL_POSTURES).toHaveLength(6);
    expect(new Set(ALL_POSTURES).size).toBe(6);

    const estate = await hermeticEstate();
    try {
      expect(estate.repos.map((r) => r.posture)).toEqual([...ALL_POSTURES]);
      const byPosture = new Map(estate.repos.map((r) => [r.posture, r]));

      // Each posture's claim, read back off the real repo rather than off its own entry.
      expect(byPosture.get("gitignored")!.entry.claudeTracked).toBe(false);
      expect(byPosture.get("source-only")!.entry.role).toBe("source-only");
      expect(byPosture.get("feature-branch")!.branch).toBe(FIXTURE_FEATURE_BRANCH);
      expect(byPosture.get("tracked")!.entry.hasUpstream).toBe(true);
      expect(byPosture.get("no-upstream")!.entry.hasUpstream).toBe(false);
      // `tools` comes from the loader's exported default, never a literal pair — hardcoding it would
      // mask a regression in the defaulting itself.
      expect(byPosture.get("tracked")!.entry.tools).toEqual(["claude-code", "antigravity-cli"]);
    } finally {
      await estate.cleanup();
    }
  });

  // Story 2.1's own escaped defect, applied to the harness: two entries resolving to the SAME `--repos`
  // key make `selectRepos` return both for one requested name, so a batch touches a repo the caller
  // never named — and `loadManifest` fails loud on it. An estate builder that handed two same-posture
  // fixtures the same name would make every multi-repo case here unloadable, so this pins the suffixing.
  test("an estate holding two of one posture gives them DISTINCT names and still loads", async () => {
    const estate = await hermeticEstate(["tracked", "tracked", "gitignored"]);
    try {
      const names = estate.manifest.map((r) => r.name);
      expect(new Set(names).size).toBe(names.length);
      // The real loader is the oracle — a duplicate key is a `ManifestError`, not a silent merge.
      const { deps, spy } = rig(writeManifest(estate.manifest));
      expect(await runBmadDeploy(["--json"], deps)).toBe(0);
      expect(rowsOf(spy).map((r) => r.repo)).toEqual(names as string[]);
    } finally {
      await estate.cleanup();
    }
  });

  // ── TRAP 1: the `.gitignore` must land BEFORE the seed commit ──────────────────────────────────
  test("TRAP 1 — the gitignored fixture is REALLY ignored; the naive ordering measurably is not", async () => {
    const f = await makeFixtureRepo("gitignored", { moduleRoot: FIXTURE_MODULE, skills: SELECTED });
    try {
      // `check-ignore` exits 0 when the path IS ignored.
      expect(checkIgnored(f.dir, CLAUDE_SKILLS)).toBe(true);
      // A pending Surface edit — the state a run leaves behind — so the probe below is asked a real
      // question. Without it a scoped add stages nothing for the trivial reason that nothing changed.
      put(join(f.dir, CLAUDE_SKILLS, SELECTED[0]!, "SKILL.md"), "# edited by the installer\n");
      // …and a SCOPED add — the exact pathspec set the product issues — stages nothing from a Surface.
      expect(scopedAddStages(f.dir).filter((p) => p.startsWith(".claude") || p.startsWith(".agents"))).toEqual([]);
      // …while the directories are still on disk, which the verification `diff` needs.
      expect(existsSync(join(f.dir, CLAUDE_SKILLS))).toBe(true);
      expect(existsSync(join(f.dir, AGENTS_SKILLS))).toBe(true);
    } finally {
      await f.cleanup();
    }

    // THE NAIVE ORDERING, BUILT AND MEASURED — not reasoned about. Committing the Surfaces first and
    // writing `.gitignore` afterwards leaves them TRACKED, and a `.gitignore` cannot un-track a path.
    // The fixture's `claudeTracked:false` would then be a lie the fixture itself cannot detect, and
    // every assertion resting on it would be green against a repo that is not gitignored at all.
    const naive = await makeScratchRepo();
    try {
      fixtureGit(naive.dir, "symbolic-ref", "HEAD", "refs/heads/main");
      put(join(naive.dir, "_bmad", "core", ".keep"), "");
      put(join(naive.dir, CLAUDE_SKILLS, "s", "SKILL.md"), "# s\n");
      put(join(naive.dir, AGENTS_SKILLS, "s", "SKILL.md"), "# s\n");
      fixtureGit(naive.dir, "add", "-A");
      fixtureGit(naive.dir, "commit", "-m", "seed");
      put(join(naive.dir, ".gitignore"), ".claude/\n.agents/\n"); // TOO LATE
      fixtureGit(naive.dir, "add", ".gitignore");
      fixtureGit(naive.dir, "commit", "-m", "ignore");
      put(join(naive.dir, CLAUDE_SKILLS, "s", "SKILL.md"), "# edited by the installer\n");

      // NOT ignored, despite the rule — and the scoped add STAGES the Surface edit. That is the whole
      // trap: this repo would carry `claudeTracked:false` in its entry while behaving as tracked.
      expect(checkIgnored(naive.dir, CLAUDE_SKILLS)).toBe(false);
      expect(scopedAddStages(naive.dir).filter((p) => p.startsWith(".claude"))).toEqual([
        join(".claude", "skills", "s", "SKILL.md").replaceAll(sep, "/"),
      ]);
    } finally {
      await naive.cleanup();
    }
  });

  // ── TRAP 2: the commit identity must be injected UNCONDITIONALLY ───────────────────────────────
  test("TRAP 2 — the fixture commit identity is the harness's, not the machine's global one", async () => {
    expect(FIXTURE_IDENTITY.join(" ")).toContain(`${EMAIL_KEY}=`);
    expect(FIXTURE_IDENTITY.join(" ")).toContain("user.name=");
    // `commit.gpgsign=false` survives a machine that signs every commit globally (no key in CI).
    expect(FIXTURE_IDENTITY.join(" ")).toContain("commit.gpgsign=false");

    const f = await makeFixtureRepo("tracked", { moduleRoot: FIXTURE_MODULE, skills: SELECTED });
    try {
      // THE REAL PROOF, and the only one that can fail on THIS machine: the seed commit's author is the
      // harness identity. The missing-identity failure is invisible here (a global `user.email` exists,
      // so a bare `git commit` succeeds) and appears only in a bare CI container — so "add the identity
      // if the commit fails" is the wrong shape, and this asserts the injection actually took.
      const author = fixtureGit(f.dir, "log", "-1", "--format=%ae");
      expect(author).toBe("bmad-fixture@example.invalid");
      expect(author).not.toBe(globalGitEmail());
    } finally {
      await f.cleanup();
    }
  });

  // ── TRAP 3: the default branch must be normalized explicitly ───────────────────────────────────
  test("TRAP 3 — every fixture lands on `main`, even where git would default to `master`", async () => {
    const estate = await hermeticEstate(["tracked", "no-upstream", "dirty", "source-only"]);
    try {
      for (const f of estate.repos) {
        expect(fixtureGit(f.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      }
    } finally {
      await estate.cleanup();
    }

    // The counterfactual: a repo initialised the way an older or unconfigured git does it. Without the
    // explicit `symbolic-ref`, every branch assertion in this file is a CI-only failure that never
    // reproduces on a machine whose `init.defaultBranch` happens to be `main`.
    const legacy = join(scratch, `legacy-${seq++}`);
    mkdirSync(legacy, { recursive: true });
    execFileSync("git", ["-c", "init.defaultBranch=master", "init", "-q", legacy], { stdio: "ignore" });
    expect(fixtureGit(legacy, "symbolic-ref", "--short", "HEAD")).toBe("master");
    fixtureGit(legacy, "symbolic-ref", "HEAD", "refs/heads/main"); // what the harness does
    expect(fixtureGit(legacy, "symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  // ── TRAP 4: "no upstream" is not "no remote" ───────────────────────────────────────────────────
  test("TRAP 4 — the no-upstream posture HAS a remote; a no-remote fixture asserts a failure path", async () => {
    const attached = await makeFixtureRepo("no-upstream", { moduleRoot: FIXTURE_MODULE, skills: SELECTED });
    const bare = await makeFixtureRepo("no-upstream", {
      moduleRoot: FIXTURE_MODULE,
      skills: SELECTED,
      remote: "none",
      name: "no-remote",
    });
    try {
      // Both are genuinely upstream-less — that is what `readGitPosture` reads, and it reads `@{u}`.
      expect(attached.entry.hasUpstream).toBe(false);
      expect(bare.entry.hasUpstream).toBe(false);
      expect(attached.remote).toBeTruthy();
      expect(bare.remote).toBeUndefined();

      const opts = parseBmadOpts(["--apply", "--push"]);
      const { deps } = rig(writeManifest([attached.entry, bare.entry]));

      // With a remote, FR-14's `push -u` SUCCEEDS — the path the push case means to exercise.
      expect(pushGate(attached.entry, opts, deps, "main")).toEqual({ pushed: true });
      // Without one it FAILS, and is reported as a failure rather than a silent `pushed:false`. A
      // fixture built this way would make the push case green while asserting the wrong path entirely.
      const bareResult = pushGate(bare.entry, opts, deps, "main");
      expect(bareResult.pushed).toBe(false);
      expect(bareResult.reason).toBeTruthy();
    } finally {
      await attached.cleanup();
      await bare.cleanup();
    }
  });

  test("FR-11 — the 503 unrelated dirty files stay unstaged while the scoped trees are committed", async () => {
    // The real count, here and only here: this is the case FR-11's number was written for.
    const f = await makeFixtureRepo("dirty", { moduleRoot: FIXTURE_MODULE, skills: SELECTED });
    try {
      const { deps, spy } = rig(writeManifest([f.entry]));
      expect(await runBmadDeploy(["--apply", "--json"], deps)).toBe(0);

      // NEVER `git add -A` — the argv form is the invariant, not just the outcome.
      for (const a of gitFor(spy, f.dir).filter((x) => x[0] === "add")) {
        expect(a).not.toContain("-A");
        expect(a).toContain("--");
      }
      // All 503 are still sitting there, dirty, exactly as the operator left them.
      const stillDirty = fixtureGit(f.dir, "status", "--porcelain")
        .split("\n")
        .filter((l) => l.includes("unrelated-"));
      expect(stillDirty).toHaveLength(503);
      // …and NONE of them was staged. Asserted off `diff --cached`, not off the porcelain's index
      // column: the porcelain read is trimmed, which eats the leading space of the first line and would
      // make a column test quietly wrong for exactly one of the 503.
      const stagedNow = fixtureGit(f.dir, "diff", "--cached", "--name-only");
      expect(stagedNow).toBe("");
      const everCommitted = fixtureGit(f.dir, "show", "--name-only", "--format=", "HEAD").split("\n");
      expect(everCommitted.filter((p) => p.includes("unrelated-"))).toEqual([]);
      // The scoped work DID happen, or the assertion above is satisfied by a run that did nothing.
      expect(rowsOf(spy)[0]!.committed).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
});

// ══ AC2/AC10/AC11/AC12 — the structural gates, EXECUTED ═══════════════════════════════════════════
//
// These are not matrix cases; they are the story's grep gates, run here so they hold on every CI run
// rather than only when a human remembers to type them. A gate that lives in a runbook is a property
// stated in prose that nothing enforces — the exact shape of every defect this epic has produced.

describe("AC2/AC10/AC12 — the composition is structural, and the gates can go red", () => {
  const SRC = join(import.meta.dir);
  const deployTs = readFileSync(join(SRC, "deploy.ts"), "utf-8");

  /** The per-repo-flow tokens `deploy.ts` must not contain — COMMENTS INCLUDED. */
  const AC2 =
    /InstallLeg|buildArgv|runBatch|runRepoPipeline|buildPlan|materializeStaging|moduleGuard|stagingPathFor|batchExit|--custom-source|quick-update|--action/;
  /** NFR-4: no direct effect edge and no raw platform module — the seam is the only route. */
  const NFR4 = /["']\.\.\/(proc|git|fsx)|["'](node:)?(fs|crypto|child_process)(\/[a-z]+)?["']/;

  test("AC2 — deploy.ts contains ZERO per-repo-flow machinery", () => {
    const hits = deployTs.split("\n").filter((l) => AC2.test(l));
    expect(hits).toEqual([]);
  });

  test("AC2 (red) — the gate FIRES on a leg-and-batch body, so it is not vacuous", () => {
    const violation = `${deployTs}\nconst leg: InstallLeg = { kind: "install", buildArgv: () => [[]] };\nconst r = await runBatch(repos, leg, opts, deps);\nreturn batchExit(r);\n`;
    expect(violation.split("\n").filter((l) => AC2.test(l)).length).toBeGreaterThan(0);
  });

  test("AC10 — deploy.ts imports NOTHING from ./cli (the two-node cycle)", () => {
    // The quote CHARACTER CLASS is load-bearing: a double-quote-only pattern misses `from './cli'`.
    expect(deployTs.split("\n").filter((l) => /["']\.\/cli["']/.test(l))).toEqual([]);
    // And the router still has exactly ONE `deploy:` key — a second is SILENT (last-wins, no `tsc`
    // error, no lint error), so the arity edit is a replacement and this is how that is proven.
    const cliTs = readFileSync(join(SRC, "cli.ts"), "utf-8");
    expect(cliTs.split("deploy:").length - 1).toBe(1);
  });

  test("AC12/NFR-4 — deploy.ts reaches no effect edge directly", () => {
    expect(deployTs.split("\n").filter((l) => NFR4.test(l))).toEqual([]);
  });

  test("AC12/NFR-4 (red) — the gate FIRES on each banned import form", () => {
    for (const line of [
      'import { spawnCapture } from "../proc";',
      'import { x } from "fs";',
      "import { y } from 'crypto';",
      'import { z } from "node:fs/promises";',
      'import { w } from "child_process";',
    ]) {
      expect(NFR4.test(line)).toBe(true);
    }
    // …and does NOT fire on the legal ones, or it would be a gate that can never go green.
    for (const line of ['import { hasFlag } from "../core/index";', 'import { runBmadUpdate } from "./update";']) {
      expect(NFR4.test(line)).toBe(false);
    }
  });

  test("AC11 — exactly ONE file in src/bmad declares a fixture git identity", () => {
    // THE NEEDLE IS ASSEMBLED AT RUNTIME so this gate does not match its own source. Spelling it
    // literally would make `deploy.test.ts` a permanent second hit and force the next reader to exempt
    // this file by name — after which a genuine second declaration added here would go unnoticed.
    // A DECLARATION, not a mention: prose in a doc comment is not a second source of truth, and a gate
    // that counted it would be weakened until it stopped catching the real thing.
    const declares = (src: string): boolean =>
      src.includes(`${EMAIL_KEY}=`) || src.includes(`"${EMAIL_KEY}"`) || src.includes(`'${EMAIL_KEY}'`);

    const declaring = readdirSync(SRC)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => declares(readFileSync(join(SRC, f), "utf-8")));
    expect(declaring).toEqual(["bmad.test-helpers.ts"]);
  });

  test("AC12 — the harness bakes in no consumer identity", () => {
    // COMMENTS MASKED FIRST, exactly as `check-no-consumer-ids` does (`stripComments`) — a doc comment
    // saying "no such literal appears here" is not a consumer identity, and a gate that read one as a
    // violation could never reach green.
    const harness = readFileSync(join(SRC, "bmad.test-helpers.ts"), "utf-8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    expect(harness).not.toMatch(/\/Users\//);
    expect(harness).not.toMatch(/\/home\/[a-z]/);
    // …and the real gate agrees. `check-no-consumer-ids` is a 6-name denylist matched segment-aware, so
    // it would NOT catch a bare home-directory literal — the assertions above are the stricter floor.
    for (const banned of ["loom", "zsh-planning", "sesh-harvest"]) {
      expect(harness.split(/[^A-Za-z0-9-]/)).not.toContain(banned);
    }
  });
});

// ══ CASES 11–12 — the LIVE layer ══════════════════════════════════════════════════════════════════

const bmadBin = resolveBmadBin();
if (!bmadBin) {
  console.log("SKIP: no bmad binary ($BMAD_BIN unset, none on PATH) — cases 11–12 need a real install");
}

/** The real shipped payload, which Story 1.2 already proved installs cleanly. */
const LIVE_MODULE = resolveEstateModule();

describe("AC7(b)/FR-10 — LIVE, against a real bmad install (skips without a binary)", () => {
  test.skipIf(!bmadBin)(
    "CASE 11 — after a real install, verifyRepo finds ZERO errors; one flipped byte is reported",
    async () => {
      // `builtins: []` AND `skills: []` — NOTHING is pre-seeded. The real installer establishes `_bmad/`
      // and both Surfaces itself, so the assertions below are answerable only by a binary that ran.
      // A fixture pre-rendered at seed time would satisfy every one of them having shelled nothing.
      const f = await makeFixtureRepo("tracked", { moduleRoot: LIVE_MODULE, skills: [], builtins: [] });
      try {
        const { deps, spy } = rig(writeManifest([f.entry]), {
          moduleRoot: LIVE_MODULE,
          bmadBin: bmadBin as string,
          live: true,
        });
        expect(existsSync(join(f.dir, CLAUDE_SKILLS))).toBe(false); // nothing here yet
        expect(await runBmadDeploy(["--apply"], deps)).toBe(0);

        // A REAL BINARY REALLY RAN, and it wrote both Surfaces. Asserted directly, because "the command
        // exited 0" is satisfied by a faked `exec` and this is the half that is not.
        expect(bmadCalls(spy, bmadBin as string).length).toBeGreaterThan(0);
        for (const surface of [CLAUDE_SKILLS, AGENTS_SKILLS]) {
          expect(existsSync(join(f.dir, surface, SELECTED[0]!))).toBe(true);
        }

        const findings = await verifyRepo(f.dir, SELECTED, LIVE_MODULE, deps);
        expect(findings.filter((x) => x.severity === "error")).toEqual([]);

        // ALL THREE CHECKS ARE LIVE HERE — flip one byte under `.agents/skills` and Parity must name it.
        // Without this half, "zero findings" is satisfied by an engine that compares nothing.
        const skill = SELECTED[0]!;
        const victim = join(f.dir, AGENTS_SKILLS, skill, "SKILL.md");
        writeFileSync(victim, `${readFileSync(victim, "utf-8")}\n<!-- drift -->\n`, "utf-8");
        const after = await verifyRepo(f.dir, SELECTED, LIVE_MODULE, deps);
        const errors = after.filter((x) => x.severity === "error");
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some((x) => x.id === "parity")).toBe(true);
      } finally {
        await f.cleanup();
      }
    },
  );

  test.skipIf(!bmadBin)(
    "CASE 12 — re-running deploy --apply on an unchanged estate leaves every digest byte-identical",
    async () => {
      // Two postures rather than six: each repo costs two real installs per run and four across the
      // case, and the claim is per-repo. Narrowed deliberately, and recorded — the hermetic idempotency
      // proof (case 10) is the one that runs everywhere.
      const estate = await makeFixtureEstate(["tracked", "gitignored"], {
        moduleRoot: LIVE_MODULE,
        skills: [],
        builtins: [],
      });
      try {
        const manifestPath = writeManifest(estate.manifest);
        const { deps, spy } = rig(manifestPath, {
          moduleRoot: LIVE_MODULE,
          bmadBin: bmadBin as string,
          live: true,
        });

        // Run 1 establishes the installed state, with a REAL binary.
        expect(await runBmadDeploy(["--apply"], deps)).toBe(0);
        expect(bmadCalls(spy, bmadBin as string).length).toBeGreaterThan(0);
        const before = estate.repos.map((f) => skillTreeDigest(f.dir, deps));
        // Non-empty, or the equality below is satisfied by two digests of nothing at all.
        const emptyDigest = skillTreeDigest(join(scratch, "nothing-here"), deps);
        for (const d of before) expect(d).not.toBe(emptyDigest);

        // Run 2 changes nothing.
        expect(await runBmadDeploy(["--apply"], deps)).toBe(0);
        const after = estate.repos.map((f) => skillTreeDigest(f.dir, deps));
        expect(after).toEqual(before);
      } finally {
        await estate.cleanup();
      }
    },
  );
});

// ── small fixture-inspection helpers ──────────────────────────────────────────────────────────────

/** `git check-ignore` exits 0 when the path IS ignored, 1 when it is not. */
function checkIgnored(dir: string, path: string): boolean {
  try {
    execFileSync("git", ["-C", dir, "check-ignore", path], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** What a SCOPED `git add` — the exact pathspec set the product uses — would stage. Leaves no index. */
function scopedAddStages(dir: string): string[] {
  try {
    execFileSync("git", ["-C", dir, "add", "--", "_bmad/", CLAUDE_SKILLS, AGENTS_SKILLS], { stdio: "ignore" });
  } catch {
    // A pathspec that matches nothing makes git fail the whole invocation; that is "staged nothing".
  }
  const out = execFileSync("git", ["-C", dir, "diff", "--cached", "--name-only"], { encoding: "utf-8" }).trim();
  execFileSync("git", ["-C", dir, "reset", "-q"], { stdio: "ignore" });
  return out === "" ? [] : out.split("\n");
}

/** The machine's global commit email, or `""`. Used only to prove the fixture identity is NOT it. */
function globalGitEmail(): string {
  try {
    return execFileSync("git", ["config", "--global", EMAIL_KEY], { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}
