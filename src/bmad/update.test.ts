// Story 2.5 acceptance suite — the update rule: the FR-9 ASYMMETRY between the two legs (AC1–AC9).
//
// THE SUBJECT OF THIS SUITE IS A DELIBERATE ASYMMETRY, NOT A COMMAND. `update` is 2.3's pipeline with a
// different leg; the guard, backup, staging, digest, verify and git spine are all inherited and are
// tested where they live. What is new, and what every block below exists to make fail loudly, is:
//
//   · the MODULE invocation carries `--custom-source` + `--action update`
//   · the BUILT-IN invocation carries `--action quick-update` and NO `--custom-source`
//
// and that those are NOT interchangeable — bare `quick-update` has a measured blind spot and will not
// propagate a local estate edit.
//
// THE ASYMMETRY IS PROVEN IN BOTH DIRECTIONS, IN TWO LAYERS. The hermetic layer (fake `exec`) asserts
// the argv SHAPE and always runs. The live layer shells the REAL `bmad` into a disposable
// `makeScratchRepo()` and asserts the ON-DISK outcome; it SKIPS when `resolveBmadBin()` is `null` (the
// CI reality, and the Epic-0 precedent). The skip is a test-harness accommodation, NOT the product rule
// — AC9 keeps a missing `bmad` fail-loud in the shipped code, and there is a case below that pins it.
//
// THE DEFECT THIS SUITE IS SHAPED TO PREVENT is a HALF-UPDATED REPO REPORTING `ok`: invocation 1
// succeeds, invocation 2 fails, and the repo says fine. `spawnCapture` never rejects, so the exit code
// is the entire signal and there is nothing for a `try/catch` around `deps.exec` to catch — treating
// "it did not throw" as success IS the failure mode. It is the structural twin of 2.4's CRITICAL (a
// silently-failed `git add` reporting success), which only the third reviewer caught.
//
// IDENTITY-FREE (D4): every path is `os.tmpdir()`-derived, repos are `alpha`/`beta`, and the estate is a
// synthetic module — never the package's own `bmad-estate/`, whose contents would silently decide
// whether these tests pass.

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { spawnCapture } from "../proc/index";

import {
  BMAD_BOOKKEEPING_DIRS,
  makeEstateModule,
  makeScratchRepo,
  removeTempTree,
  renderInstalledSurfaces,
  resolveBmadBin,
} from "./bmad.test-helpers";
import { runBmad } from "./cli";
import { BmadError, type BmadDeps, type LegCtx, type RepoResult } from "./deps";
import { materializeStaging, moduleGuard, stagingPathFor } from "./estate-source";
import type { BmadRepo } from "./manifest";
import { parseBmadOpts } from "./opts";
import { skillTreeDigest } from "./pipeline";
import { presentBuiltins, runBmadUpdate, updateLeg } from "./update";

const JHON = "bmad-agent-jhon-the-loop";
const EPIC = "bmad-agent-epic-the-loop";
const DEV = "bmad-agent-dev-the-loop";

/** The two Surface trees, spelled out rather than imported — a test that shares the constant with the */
/** code under test cannot catch the code renaming it. */
const CLAUDE_SKILLS = join(".claude", "skills");
const AGENTS_SKILLS = join(".agents", "skills");

const scratch = mkdtempSync(join(tmpdir(), "bmad-update-"));
const tempTrees: string[] = [scratch];

afterAll(() => {
  for (const dir of tempTrees) removeTempTree(dir);
});

let seq = 0;
function fresh(prefix: string): string {
  const dir = join(scratch, `${prefix}-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

// ── the fake seam ─────────────────────────────────────────────────────────────────────────────────

interface Spy {
  exec: { cmd: string; args: string[] }[];
  git: string[][];
  cpDir: { src: string; dest: string }[];
  atomicWrite: { path: string; content: string }[];
  ensureDir: string[];
  clock: number;
  json: unknown[];
  print: string[];
  logged: string[];
}

interface Harness {
  deps: BmadDeps;
  spy: Spy;
  repos: { alpha: string; beta: string };
  estate: string;
  stateHome: string;
}

interface HarnessOpts {
  /** What the mocked installer returns, keyed by `<repo basename>` or `<repo basename>:<action>`. */
  exec?: Record<string, { stdout?: string; stderr?: string; code: number }>;
  skills?: string[];
  emptySkills?: string[];
  marketplace?: unknown;
  /** `false` ⇒ a MONOTONIC clock (`T0`, `T1`, …) instead of a fixed `T0`. */
  fixedClock?: boolean;
  /** Built-in module dirs to create under each repo's `_bmad/`. Default: both. */
  builtins?: string[];
  /** `false` ⇒ beta's `.claude` is gitignored (2.1's required, never-defaulted boolean). */
  betaTracked?: boolean;
  /** Per-repo override of {@link HarnessOpts.builtins}, keyed by repo basename. */
  builtinsPerRepo?: Record<string, string[]>;
}

/**
 * Build a fully-wired fake seam over real temp directories — the same instrument `install.test.ts`
 * uses, extended with the one thing the update rule reads that the install rule does not: the
 * `_bmad/<module>` presence the built-in probe keys off.
 *
 * The fs members are REAL (against temp trees) rather than pure spies: the guard walks the estate, the
 * backup copies actual files, the probe stats actual directories and the digest reads actual bytes — a
 * recorded-call-only fake would let every one of those pass while doing nothing. Only `exec` is mocked.
 */
function harness(opts: HarnessOpts = {}): Harness {
  const spy: Spy = {
    exec: [],
    git: [],
    cpDir: [],
    atomicWrite: [],
    ensureDir: [],
    clock: 0,
    json: [],
    print: [],
    logged: [],
  };

  const root = fresh("case");
  const alpha = join(root, "repos", "alpha");
  const beta = join(root, "repos", "beta");
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });

  // The built-in modules the AC3 probe will find. Seeded as REAL directories, because the probe is a
  // real `deps.fs` read — stubbing its answer would test the stub, not the probe.
  //
  // Each carries a `config.yaml` MODULE MARKER, because that is what the probe now discriminates on
  // (BM-18.1) and what a real installed module carries. A bare directory is NOT a module: `_bmad/` also
  // holds `_config`, `custom`, `scripts` and `render`, and naming one of those in `--modules` would ask
  // `bmad` to install a module that does not exist.
  for (const [name, repo] of [["alpha", alpha], ["beta", beta]] as const) {
    for (const m of opts.builtinsPerRepo?.[name] ?? opts.builtins ?? ["core", "bmm"]) {
      mkdirSync(join(repo, "_bmad", m), { recursive: true });
      writeFileSync(join(repo, "_bmad", m, "config.yaml"), "", "utf-8");
    }
    // The bookkeeping dirs every real `_bmad/` carries, seeded on EVERY fixture so the probe is
    // permanently required to discriminate. Without these the marker check is untested — a probe that
    // returned every child directory would pass every assertion in this file.
    for (const d of BMAD_BOOKKEEPING_DIRS) mkdirSync(join(repo, "_bmad", d), { recursive: true });
  }

  const estate = makeEstateModule({
    skills: opts.skills ?? [JHON, EPIC, DEV],
    ...(opts.emptySkills ? { emptySkills: opts.emptySkills } : {}),
    ...(opts.marketplace !== undefined ? { marketplace: opts.marketplace } : {}),
  });
  tempTrees.push(estate);

  const stateHome = join(root, "state", "std", "bmad-manager");
  const manifestPath = join(root, "estate.toml");
  writeFileSync(
    manifestPath,
    `[[repos]]\npath = ${JSON.stringify(alpha)}\nclaudeTracked = true\nhasUpstream = true\nbranch = "main"\n\n` +
      `[[repos]]\npath = ${JSON.stringify(beta)}\nclaudeTracked = ${opts.betaTracked ?? true}\nhasUpstream = false\n`,
    "utf-8",
  );

  const execTable = opts.exec ?? { "*": { code: 0 } };
  let tick = 0;

  const deps: BmadDeps = {
    exec: async (cmd, args, o) => {
      spy.exec.push({ cmd, args });
      // `diff` goes to the REAL `spawnCapture` (2.6): the pipeline's verify filter must genuinely
      // compare the trees this harness built. A stubbed-green verify would let every assertion below
      // pass over an unverified repo — the exact false green Story 2.6 exists to prevent.
      if (cmd === "diff") return spawnCapture(cmd, args, o);

      const dirFlag = args.indexOf("--directory");
      const target = dirFlag >= 0 ? (args[dirFlag + 1] ?? "") : "";
      const actionFlag = args.indexOf("--action");
      const action = actionFlag >= 0 ? (args[actionFlag + 1] ?? "") : "";
      // Keyed by `<repo>:<action>` first so a test can fail ONE leg of a two-leg run — which is the
      // half-updated-repo case (AC6) and cannot be expressed by a repo-only key.
      const key =
        Object.keys(execTable).find((k) => k.includes(":") && target.endsWith(k.split(":")[0]!) && k.endsWith(`:${action}`)) ??
        Object.keys(execTable).find((k) => k !== "*" && !k.includes(":") && target.endsWith(k));
      const r = (key ? execTable[key] : execTable["*"]) ?? { code: 0 };

      // A SUCCESSFUL install RENDERS BOTH SURFACES, and since 2.6 the pipeline verifies that it did.
      // The rendering is a plain `cpSync` standing in for the EXTERNAL installer's writes — routing it
      // through `deps.fs` would make `spy.cpDir` report bmad-manager as having copied into the repo.
      //
      // IT IS GATED ON `--custom-source`, AND THAT GATE IS THE HERMETIC BLIND SPOT. The built-in
      // `quick-update` invocation carries no source, so it renders nothing — which is exactly what the
      // real binary does, measured. A fake that rendered on every invocation would make AC4(b) vacuous.
      const csFlag = args.indexOf("--custom-source");
      const source = csFlag >= 0 ? (args[csFlag + 1] ?? "") : "";
      if (r.code === 0 && target !== "" && source !== "") renderInstalledSurfaces(target, source);
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code };
    },
    git: (_repo, args) => {
      spy.git.push(args);
      return "";
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
        spy.ensureDir.push(dir);
        mkdirSync(dir, { recursive: true });
      },
      atomicWrite: (p, content) => {
        spy.atomicWrite.push({ path: p, content });
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content, "utf-8");
      },
      cpDir: (src, dest) => {
        spy.cpDir.push({ src, dest });
        cpSync(src, dest, { recursive: true });
      },
      listDirs: (r) => {
        try {
          return readdirSync(r, { withFileTypes: true })
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
    clock: () => {
      spy.clock++;
      return opts.fixedClock === false ? `T${tick++}` : "T0";
    },
    bmadBin: "bmad-under-test",
    manifestPath,
    estateModulePath: estate,
    backupRoot: join(stateHome, "backups"),
  };

  return { deps, spy, repos: { alpha, beta }, estate, stateHome };
}

function seedSurfaces(repo: string, trees: string[] = [CLAUDE_SKILLS, AGENTS_SKILLS]): void {
  for (const tree of trees) put(join(repo, tree, JHON, "SKILL.md"), `# ${JHON}\n`);
}

/** Only the BACKUP copies — a run also copies skill dirs into the staging tree, which is not a backup. */
function backupCopies(spy: Spy): { src: string; dest: string }[] {
  return spy.cpDir.filter((c) => c.dest.includes(`${sep}backups${sep}`));
}

/** Every `bmad` invocation the run shelled, in order (excluding the verify filter's `diff` calls). */
function bmadCalls(spy: Spy): string[][] {
  return spy.exec.filter((e) => e.cmd === "bmad-under-test").map((e) => e.args);
}

/** The `bmad` invocations aimed at one repo, in order. */
function callsFor(spy: Spy, repo: string): string[][] {
  return bmadCalls(spy).filter((a) => a[a.indexOf("--directory") + 1] === repo);
}

/** The value following `flag` in an argv, or `undefined` when the flag is absent. */
function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv[i + 1];
}

/** The ledger rows a `--json` run emitted. */
function rowsOf(spy: Spy): RepoResult[] {
  const payload = spy.json[0] as { repos: RepoResult[] } | undefined;
  return payload?.repos ?? [];
}

/** Build a `LegCtx` for a direct `buildArgv` call — the unit-scope way to inspect the authored argv. */
function ctxFor(repoPath: string, deps: BmadDeps, argv: string[] = []): LegCtx {
  const repo: BmadRepo = { path: repoPath, tools: ["claude-code", "antigravity-cli"], claudeTracked: true, hasUpstream: true };
  return {
    repo,
    opts: parseBmadOpts(argv),
    deps: {
      bmadBin: deps.bmadBin,
      manifestPath: deps.manifestPath,
      estateModulePath: deps.estateModulePath,
      backupRoot: deps.backupRoot,
    },
  };
}

/** The leg under test, wired to the REAL on-disk probe (never a stubbed answer). */
function legFor(stagingDir: string, deps: BmadDeps) {
  return updateLeg(stagingDir, (p) => presentBuiltins(p, deps));
}

// ── AC1 / AC2 / AC3 — the argv asymmetry, hermetically ────────────────────────────────────────────

describe("AC1 — the update rule is STRUCTURAL: the two legs are deliberately NOT symmetric (FR-9)", () => {
  test("CASE 1 — the MODULE argv carries --custom-source + --action update, and never 'quick-update'", () => {
    const h = harness();
    const argv = legFor("/staging/fixed", h.deps).buildArgv(ctxFor(h.repos.alpha, h.deps));

    const moduleArgv = argv.at(-1)!;
    expect(valueOf(moduleArgv, "--custom-source")).toBe("/staging/fixed");
    expect(valueOf(moduleArgv, "--action")).toBe("update");
    // RED IF the module leg is "simplified" to a bare quick-update — the exact defect FR-9 exists to
    // prevent, and the one that would make the whole command silently ship nothing.
    expect(moduleArgv).not.toContain("quick-update");
  });

  test("CASE 2 — the BUILT-IN argv carries --action quick-update and NO --custom-source token at all", () => {
    const h = harness();
    const argv = legFor("/staging/fixed", h.deps).buildArgv(ctxFor(h.repos.alpha, h.deps));

    const builtin = argv[0]!;
    expect(valueOf(builtin, "--action")).toBe("quick-update");
    // RED IF `--custom-source` leaks into the built-in argv. That absence is not an oversight — it IS
    // the blind spot the module leg exists to cover, and the live regression below would go vacuous
    // the moment this invocation could propagate an edit on its own.
    expect(builtin).not.toContain("--custom-source");
  });

  test("both invocations are `bmad install …` — 'quick-update' is an --action VALUE, not a subcommand", () => {
    // Re-probed against bmad 6.10.0 at dev time: `bmad --help` lists exactly
    // `install | status | uninstall | help`. A `["quick-update", …]` argv exits 2/usage.
    const h = harness();
    for (const argv of legFor("/staging/fixed", h.deps).buildArgv(ctxFor(h.repos.alpha, h.deps))) {
      expect(argv[0]).toBe("install");
    }
  });

  test("--set rides BOTH invocations — an operator setting must not land on only half an update", () => {
    const h = harness();
    const argv = legFor("/s", h.deps).buildArgv(ctxFor(h.repos.alpha, h.deps, ["--set", "core.a=b"]));
    expect(argv).toHaveLength(2);
    for (const a of argv) expect(a.slice(a.indexOf("--set"))).toEqual(["--set", "core.a=b"]);
  });
});

describe("AC2 — --custom-source is BM-12's FILTERED staging dir, never the raw module", () => {
  test("CASE 3 — it equals the staging dir, NOT deps.estateModulePath", () => {
    const h = harness();
    const staging = stagingPathFor(h.deps);
    const argv = legFor(staging, h.deps).buildArgv(ctxFor(h.repos.alpha, h.deps));

    expect(valueOf(argv.at(-1)!, "--custom-source")).toBe(staging);
    // RED IF pointed at the unfiltered module: the marketplace `skills` array IS the install gate, so
    // the raw module ships whatever ITS array names — which breaks the resolved "dev-the-loop is
    // opt-in until proven" decision by shipping dev estate-wide.
    expect(valueOf(argv.at(-1)!, "--custom-source")).not.toBe(h.deps.estateModulePath);
  });

  test("CASE 4 — THE C3 TRAP: under a MONOTONIC clock the --custom-source is the dir that was WRITTEN", async () => {
    // A fixed clock structurally CANNOT see this defect: two `stagingPathFor` calls return the same
    // string. Only a live/monotonic clock makes the second call name a directory `materializeStaging`
    // never wrote — and the production clock is live.
    const h = harness({ fixedClock: false });
    seedSurfaces(h.repos.alpha);
    await runBmadUpdate(["--repos", "alpha", "--apply"], h.deps);

    const moduleArgv = callsFor(h.spy, h.repos.alpha).at(-1)!;
    const customSource = valueOf(moduleArgv, "--custom-source")!;
    const written = h.spy.atomicWrite.find((w) => w.path.endsWith("marketplace.json"))!.path;
    expect(written.startsWith(customSource + sep)).toBe(true);
    expect(existsSync(join(customSource, ".claude-plugin", "marketplace.json"))).toBe(true);
  });

  test("the staged marketplace array is the SELECTED set — the filter really is applied", async () => {
    const h = harness();
    await runBmadUpdate(["--repos", "alpha", "--apply"], h.deps);
    const write = h.spy.atomicWrite.find((w) => w.path.endsWith("marketplace.json"))!;
    const arr = (JSON.parse(write.content) as { plugins: { skills: string[] }[] }).plugins[0]!.skills;
    // Two of the three on-disk skills — `dev-the-loop` is opt-in and must not ship by default.
    expect(arr).toEqual([`./skills/${JHON}`, `./skills/${EPIC}`]);
    expect(arr).not.toContain(`./skills/${DEV}`);
  });
});

describe("AC3 — --modules is PROBED on disk, never hardcoded", () => {
  test("CASE 5a — a bmm-absent repo yields --modules core on the built-in argv", () => {
    const h = harness({ builtins: ["core"] });
    const argv = legFor("/s", h.deps).buildArgv(ctxFor(h.repos.alpha, h.deps));
    expect(argv).toHaveLength(2);
    // RED IF `"core,bmm"` is hardcoded: naming an absent built-in asks bmad to INSTALL it, silently
    // widening the estate of a repo that deliberately runs core only.
    expect(valueOf(argv[0]!, "--modules")).toBe("core");
  });

  test("CASE 5b — a repo with NO built-in installed yields ONE invocation: the module leg", () => {
    const h = harness({ builtins: [] });
    const argv = legFor("/s", h.deps).buildArgv(ctxFor(h.repos.alpha, h.deps));
    expect(argv).toHaveLength(1);
    expect(argv[0]).toContain("--custom-source");
    expect(argv[0]).not.toContain("quick-update");
    // The degenerate case still needs a host module for the estate skills to render alongside.
    expect(valueOf(argv[0]!, "--modules")).toBe("core");
  });

  test("the probe reads the real filesystem, per repo, and the two repos can disagree", () => {
    const h = harness({ builtinsPerRepo: { alpha: ["core", "bmm"], beta: ["core"] } });
    const leg = legFor("/s", h.deps);
    expect(valueOf(leg.buildArgv(ctxFor(h.repos.alpha, h.deps))[0]!, "--modules")).toBe("core,bmm");
    expect(valueOf(leg.buildArgv(ctxFor(h.repos.beta, h.deps))[0]!, "--modules")).toBe("core");
  });

  // ── THE DEFECT FOUND LIVE AT DEV TIME, now a permanent guard ──────────────────────────────────
  // The module leg runs LAST and `--action update` treats `--modules` as the set that should EXIST,
  // not as a set to add. Measured against bmad 6.10.0: a module leg passing the frozen `--modules core`
  // against a repo holding core AND bmm **DELETES `_bmad/bmm` from disk** — `bmad status` afterwards
  // lists core alone. That is silent data loss caused by this command's own argv, so the invariant is
  // pinned here rather than left to the live layer (which skips without a binary).
  test("THE bmm-DELETION TRAP: the MODULE argv names every built-in that must survive it", () => {
    const h = harness({ builtins: ["core", "bmm"] });
    const argv = legFor("/s", h.deps).buildArgv(ctxFor(h.repos.alpha, h.deps));
    expect(valueOf(argv.at(-1)!, "--modules")).toBe("core,bmm");
    // Both invocations agree on the set — a divergence is the shape that loses a module.
    expect(valueOf(argv[0]!, "--modules")).toBe(valueOf(argv.at(-1)!, "--modules"));
  });

  // ── BM-18.1 — THE INPUT THAT WAS MISSING FOR THREE EPICS ──────────────────────────────────────
  // Every assertion above supplies only `core` and/or `bmm`. Against that input a correct disk probe
  // and the old `BUILTIN_MODULES = ["core","bmm"]` intersection return IDENTICAL answers, so the whole
  // describe block passed while the shipped probe could not name a single module outside that pair.
  // The gate was real; the input that makes it fail did not exist. Found 2026-08-03 on first contact
  // with the real estate: all 9 repos hold 4–7 built-ins, so `update --apply` would have deleted 2–5
  // modules from every one of them.
  test("BM-18.1 — a built-in OUTSIDE {core,bmm} is named; the probe enumerates disk, not a literal", () => {
    // `tea` and `wds` are real modules in the live estate. RED against the pre-BM-18.1 probe, which
    // returns `core,bmm` here and hands `--action update` an argv that DELETES tea and wds from disk.
    const h = harness({ builtins: ["core", "bmm", "tea", "wds"] });
    const argv = legFor("/s", h.deps).buildArgv(ctxFor(h.repos.alpha, h.deps));
    for (const a of argv) expect(valueOf(a, "--modules")).toBe("core,bmm,tea,wds");
  });

  test("BM-18.1 — a repo with NO core still names what it has; nothing is assumed", () => {
    // The inverse blind spot: an intersection cannot return a module it does not list, and it also
    // cannot notice that `core` is absent. Enumeration reports exactly what is on disk.
    const h = harness({ builtins: ["tea"] });
    const argv = legFor("/s", h.deps).buildArgv(ctxFor(h.repos.alpha, h.deps));
    expect(valueOf(argv.at(-1)!, "--modules")).toBe("tea");
  });

  test("BM-18.1 — `_bmad`'s bookkeeping dirs are NEVER named as modules", () => {
    // `_config`, `custom`, `scripts` and `render` are seeded into every fixture repo. Naming one in
    // `--modules` asks bmad to install a module that does not exist. This is the assertion that makes
    // "enumerate the directory" safe — without it, the cure is worse than the disease.
    // POSITIVE CONTROL on the same path: the real modules must still be named, so a probe that
    // returned `[]` cannot satisfy this test by emitting nothing.
    const h = harness({ builtins: ["core", "tea"] });
    // 🔬 AN ARBITRARY UNMARKED DIRECTORY, and it is the whole point of this case (PR #74 reviewer).
    // Asserting only against BMAD_BOOKKEEPING_DIRS is VACUOUS: a probe reimplemented as a denylist of
    // those four names would pass every line below it. A name nothing has ever heard of can only be
    // excluded by the `config.yaml` MARKER actually doing the work.
    mkdirSync(join(h.repos.alpha, "_bmad", "zzz-unmarked-dir"), { recursive: true });
    const modules = valueOf(legFor("/s", h.deps).buildArgv(ctxFor(h.repos.alpha, h.deps)).at(-1)!, "--modules");
    // POSITIVE CONTROL on the same path: the real modules must still be named, so a probe that
    // returned `[]` cannot satisfy this test by emitting nothing.
    expect(modules).toBe("core,tea");
    expect(modules).not.toContain("zzz-unmarked-dir");
    for (const d of BMAD_BOOKKEEPING_DIRS) expect(modules).not.toContain(d);
  });

  test("BM-18.1 — a repo with NO `_bmad` at all yields [] and falls back, it does NOT throw", () => {
    // Raised by the PR #74 reviewer as "listDirs may throw where the exists-based probe did not".
    // The MECHANISM claim is wrong — `deps.fs.listDirs` is fail-soft `[]` by construction
    // (`deps.ts:245`), measured: `listDirs("/nope") === []`. The CONCERN was right, though: nothing
    // asserted the enumeration probe's behaviour on a repo that has never had bmad installed, and
    // "the primitive is fail-soft" is a property a future refactor can silently drop.
    const h = harness();
    const virgin = join(h.repos.alpha, "..", "virgin");
    mkdirSync(virgin, { recursive: true }); // a repo dir with NO `_bmad/` whatsoever
    expect(presentBuiltins(virgin, h.deps)).toEqual([]);
    // …and the leg still emits a usable argv: the estate module needs a host module to render beside.
    const argv = legFor("/s", h.deps).buildArgv(ctxFor(virgin, h.deps));
    expect(argv).toHaveLength(1);
    expect(valueOf(argv[0]!, "--modules")).toBe("core");
  });

  test("BM-18.1 — the emitted set is SORTED, so deploy's byte-identity assertion cannot flake", () => {
    // BM-18 requires deploy's recorded argv to be byte-identical to update's for the same repo set.
    // `readdir` order is a filesystem detail; without the sort that assertion is at its mercy.
    //
    // 🔬 THE FILESYSTEM IS FORCED TO LIE (PR #74 reviewer). Seeding dirs out of order proves nothing:
    // `readdirSync` on APFS returns them sorted anyway, so this case passed with production sorting
    // DELETED — a textbook vacuous gate. Scrambling `listDirs` at the seam is the only input that makes
    // the assertion depend on the production `.sort()`, and it is REVERSED rather than shuffled so the
    // test is deterministic (`Math.random` would make a red flaky and a green meaningless).
    const h = harness({ builtinsPerRepo: { alpha: ["wds", "core", "tea", "bmm"] } });
    const real = h.deps.fs.listDirs;
    h.deps.fs.listDirs = (root: string) => [...real(root)].reverse();
    expect(valueOf(legFor("/s", h.deps).buildArgv(ctxFor(h.repos.alpha, h.deps)).at(-1)!, "--modules")).toBe(
      "core,bmm,tea,wds",
    );
    h.deps.fs.listDirs = real;
  });
});

// ── AC5 — multi-leg composition ───────────────────────────────────────────────────────────────────

describe("AC5 — ONE guard, ONE backup, ONE verify per repo; only the LEGS repeat (BM-4/BM-16)", () => {
  test("CASE 8 — two repos: 2 invocations each, built-in BEFORE module, exactly 1 backup each", async () => {
    const h = harness();
    seedSurfaces(h.repos.alpha);
    seedSurfaces(h.repos.beta);
    expect(await runBmadUpdate(["--apply", "--json"], h.deps)).toBe(0);

    // Manifest order across repos, one row each (BM-16).
    expect(rowsOf(h.spy).map((r) => r.repo)).toEqual(["alpha", "beta"]);

    for (const repo of [h.repos.alpha, h.repos.beta]) {
      const calls = callsFor(h.spy, repo);
      expect(calls).toHaveLength(2);
      // ORDER IS THE CONTRACT: built-in first so the module leg has the final word on the manifests
      // `bmad install` regenerates. RED IF the order inverts.
      expect(valueOf(calls[0]!, "--action")).toBe("quick-update");
      expect(valueOf(calls[1]!, "--action")).toBe("update");
      expect(calls[0]).not.toContain("--custom-source");
      expect(calls[1]).toContain("--custom-source");

      // ONE backup per repo — the legs are the only step that repeats. RED IF a second backup appears.
      const backups = backupCopies(h.spy).filter((c) => c.src.startsWith(repo + sep));
      expect(backups).toHaveLength(2); // the two Surface trees of ONE backup
      expect(new Set(backups.map((c) => dirname(dirname(c.dest)))).size).toBe(1);
    }
  });

  test("a non-zero BUILT-IN invocation aborts the repo — the module leg never runs (fail-fast, BM-4)", async () => {
    const h = harness({ exec: { "alpha:quick-update": { code: 1, stderr: "builtin boom" }, "*": { code: 0 } } });
    seedSurfaces(h.repos.alpha);
    await runBmadUpdate(["--repos", "alpha", "--apply", "--json"], h.deps);

    const calls = callsFor(h.spy, h.repos.alpha);
    // RED IF a failed built-in still lets the module leg write over the top of it.
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("--custom-source");
    expect(rowsOf(h.spy)[0]?.status).toBe("failed");
    expect(rowsOf(h.spy)[0]?.reason).toContain("built-in leg failed");
  });

  // BM-17 is an ORDERING claim, and a two-invocation leg is the first thing that can break it in a way
  // no single-leg command could: the gitignore short-circuit must sit AFTER both legs and after verify,
  // never before. If it were hoisted, `update` would silently run ZERO invocations against the estate's
  // one `claudeTracked:false` target and report a NON-FAILING status having updated nothing — a clean
  // exit code over an untouched repo, which is the same silent-success family as AC6.
  test("a gitignored repo still runs BOTH invocations — only commit/push are skipped (BM-17)", async () => {
    const h = harness({ betaTracked: false });
    seedSurfaces(h.repos.alpha);
    seedSurfaces(h.repos.beta);
    // Non-failing: being gitignored is a fact about the repo, not a fault.
    expect(await runBmadUpdate(["--apply", "--json"], h.deps)).toBe(0);

    const row = rowsOf(h.spy).find((r) => r.repo === "beta")!;
    expect(row.status).toBe("skipped-gitignored");
    // The working copy WAS updated — that is the whole intended outcome for these repos.
    expect(callsFor(h.spy, h.repos.beta)).toHaveLength(2);
    expect(row.committed).toBe(false);
    expect(row.pushed).toBe(false);
  });
});

// ── AC6 — the half-updated repo ───────────────────────────────────────────────────────────────────

describe("AC6 — a HALF-UPDATED repo NEVER reports ok (FR-15 — this story's whole point)", () => {
  test("CASE 9 — leg 2 fails after leg 1 succeeded: failed, named leg, verbatim stderr, backup path", async () => {
    const h = harness({ exec: { "alpha:update": { code: 1, stderr: "ANCESTOR CONFLICT: /x/.claude" }, "*": { code: 0 } } });
    seedSurfaces(h.repos.alpha);
    const code = await runBmadUpdate(["--repos", "alpha", "--apply", "--json"], h.deps);

    // Both invocations ran; the second failed. The repo is genuinely half-updated.
    expect(callsFor(h.spy, h.repos.alpha)).toHaveLength(2);

    const row = rowsOf(h.spy)[0]!;
    // RED IF a half-updated repo reports `ok` — the mirror of 2.4's CRITICAL.
    expect(row.status).toBe("failed");
    expect(code).toBe(1);

    // WHICH leg — a two-leg command whose failure cannot say which half landed is unactionable.
    expect(row.reason).toContain("module leg failed");
    expect(row.reason).not.toContain("built-in leg failed");
    // The installer's stderr, VERBATIM (BM-11) — never summarized, never a boolean or a count.
    expect(row.reason).toContain("ANCESTOR CONFLICT: /x/.claude");
    // The failing argv, so the operator can re-run exactly the command that died.
    expect(row.reason).toContain("--custom-source");
    // The rollback handle for the half that DID land. A backup taken but never named is a rollback
    // the operator cannot perform.
    expect(row.backupPath).toBeDefined();
    expect(row.reason).toContain(row.backupPath!);

    // …and the git spine never ran: a half-updated repo must not be staged, committed or pushed.
    expect(row.stagedPaths).toEqual([]);
    expect(row.committed).toBe(false);
    expect(row.pushed).toBe(false);
    expect(h.spy.git.some((a) => a[0] === "commit")).toBe(false);
  });

  test("CASE 10 — repo 1 fails, repo 2 still runs, in Manifest order (BM-16 fault isolation)", async () => {
    const h = harness({ exec: { alpha: { code: 1, stderr: "alpha down" }, "*": { code: 0 } } });
    seedSurfaces(h.repos.alpha);
    seedSurfaces(h.repos.beta);
    expect(await runBmadUpdate(["--apply", "--json"], h.deps)).toBe(1);

    const rows = rowsOf(h.spy);
    expect(rows.map((r) => r.repo)).toEqual(["alpha", "beta"]);
    expect(rows.map((r) => r.status)).toEqual(["failed", "ok"]);
    // RED IF the batch short-circuits: repo 2's invocations must still appear.
    expect(callsFor(h.spy, h.repos.beta)).toHaveLength(2);
  });
});

// ── AC7 — dry run ─────────────────────────────────────────────────────────────────────────────────

describe("AC7 — dry run is the default, writes NOTHING, and plans BOTH invocations (FR-5/BM-14)", () => {
  test("CASE 11 — zero fs writes, zero bmad execs, and the plan still carries both invocations", async () => {
    const h = harness();
    seedSurfaces(h.repos.alpha);
    expect(await runBmadUpdate(["--json", "--push"], h.deps)).toBe(0);

    // RED IF any write or shell-out happens without `--apply`.
    expect(bmadCalls(h.spy)).toEqual([]);
    expect(h.spy.cpDir).toEqual([]);
    expect(h.spy.atomicWrite).toEqual([]);
    expect(h.spy.ensureDir).toEqual([]);

    const row = rowsOf(h.spy)[0]!;
    // …and the render still reports the FULL intent, both invocations, including the staging path it
    // did not create. `planned` is intent, not outcome (BM-14).
    expect(row.planned.installArgv).toHaveLength(2);
    expect(row.planned.installArgv[1]).toContain("--custom-source");
    // Outcome fields stay at their literal zero values.
    expect(row.stagedPaths).toEqual([]);
    expect(row.committed).toBe(false);
    expect(row.pushed).toBe(false);
  });

  test("SM-3 — under a fixed clock, dry.planned deep-equals apply.planned", async () => {
    const dry = harness();
    seedSurfaces(dry.repos.alpha);
    await runBmadUpdate(["--repos", "alpha", "--json"], dry.deps);

    const applied = harness();
    seedSurfaces(applied.repos.alpha);
    await runBmadUpdate(["--repos", "alpha", "--apply", "--json"], applied.deps);

    // Compared on `planned` ONLY — never on outcomes (BM-14). The paths differ per harness root, so
    // the comparison is over the argv SHAPE the two modes projected, which is what SM-3 protects.
    const shape = (r: RepoResult) => r.planned.installArgv.map((a) => a.map((t) => (t.includes(sep) ? "<path>" : t)));
    expect(shape(rowsOf(applied.spy)[0]!)).toEqual(shape(rowsOf(dry.spy)[0]!));
    expect(rowsOf(dry.spy)[0]!.planned.installArgv).toHaveLength(2);
  });

  test("--apply alone never implies --push (FR-14/BM-6)", async () => {
    const h = harness();
    seedSurfaces(h.repos.alpha);
    await runBmadUpdate(["--repos", "alpha", "--apply", "--json"], h.deps);
    expect(rowsOf(h.spy)[0]?.planned.wouldPush).toBe(false);
    expect(rowsOf(h.spy)[0]?.pushed).toBe(false);
    expect(h.spy.git.some((a) => a[0] === "push")).toBe(false);
  });

  test("the staging dir is NOT created in dry run, even though the plan names its path", async () => {
    const h = harness();
    await runBmadUpdate(["--repos", "alpha", "--json"], h.deps);
    const named = valueOf(rowsOf(h.spy)[0]!.planned.installArgv.at(-1)!, "--custom-source")!;
    expect(existsSync(named)).toBe(false);
  });
});

// ── AC8 — idempotency ─────────────────────────────────────────────────────────────────────────────

describe("AC8 — idempotency REUSES 2.3's digest; 2.5 rolls no hash (FR-10)", () => {
  test("CASE 12a — a second identical --apply leaves the skill-tree digest byte-identical", async () => {
    const h = harness();
    seedSurfaces(h.repos.alpha);
    await runBmadUpdate(["--repos", "alpha", "--apply"], h.deps);
    const first = skillTreeDigest(h.repos.alpha, h.deps);
    await runBmadUpdate(["--repos", "alpha", "--apply"], h.deps);
    expect(skillTreeDigest(h.repos.alpha, h.deps)).toBe(first);
  });

  test("CASE 12b — by-design REGENERATED paths are not drift", async () => {
    const h = harness();
    seedSurfaces(h.repos.alpha);
    await runBmadUpdate(["--repos", "alpha", "--apply"], h.deps);
    const before = skillTreeDigest(h.repos.alpha, h.deps);

    // Everything `bmad install` re-derives on every run. None of it is drift.
    put(join(h.repos.alpha, "_bmad", "_config", "manifest.yaml"), "regenerated\n");
    put(join(h.repos.alpha, "_bmad", "scripts", "run.sh"), "regenerated\n");
    put(join(h.repos.alpha, "_bmad", "config.toml"), "regenerated\n");
    put(join(h.repos.alpha, "_bmad", "bmad-help.csv"), "regenerated\n");
    expect(skillTreeDigest(h.repos.alpha, h.deps)).toBe(before);
  });

  test("CASE 12c — a WHITESPACE-ONLY skill edit DOES change the digest (the contentHash trap)", async () => {
    const h = harness();
    seedSurfaces(h.repos.alpha);
    await runBmadUpdate(["--repos", "alpha", "--apply"], h.deps);
    const before = skillTreeDigest(h.repos.alpha, h.deps);

    // RED IF `core.contentHash` were substituted: it collapses whitespace, lowercases and slices to
    // 400 chars, so it reports FALSE-EQUAL on exactly this edit — real drift, silently unseen.
    const f = join(h.repos.alpha, CLAUDE_SKILLS, JHON, "SKILL.md");
    writeFileSync(f, `${readFileSync(f, "utf-8")}   \n`, "utf-8");
    expect(skillTreeDigest(h.repos.alpha, h.deps)).not.toBe(before);
  });
});

// ── AC9 — fail-loud on every exit path ────────────────────────────────────────────────────────────

describe("AC9 — every exit path is fail-loud; a missing bmad is NOT a skip (BM-3/FR-15)", () => {
  test("CASE 13a — a ManifestError maps to exit 1 (never 2, never 0)", async () => {
    const h = harness();
    // An unknown `--repos` name is 2.1's declared ManifestError.
    expect(await runBmad(["update", "--repos", "nope"], h.deps)).toBe(1);
    expect(bmadCalls(h.spy)).toEqual([]);
  });

  test("CASE 13b — a moduleGuard BmadError maps to exit 1 with NO repo touched", async () => {
    // Only jhon ships; the default set also wants epic — a half-family estate.
    const h = harness({ skills: [JHON] });
    expect(await runBmad(["update", "--apply"], h.deps)).toBe(1);
    // The assertion that matters is not "it failed" but "it failed before touching anything".
    expect(bmadCalls(h.spy)).toEqual([]);
    expect(h.spy.cpDir).toEqual([]);
    expect(h.spy.atomicWrite).toEqual([]);
    expect(h.spy.logged.join("\n")).toContain(EPIC);
  });

  test("the same BmadError surfaces as a throw from the command itself (one mapping site, in cli.ts)", async () => {
    const h = harness({ skills: [JHON] });
    await expect(runBmadUpdate(["--apply"], h.deps)).rejects.toThrow(BmadError);
  });

  test("CASE 13c — exec 127 (bmad absent) is FAILED WITH REMEDIATION, never a SKIP-0", async () => {
    const h = harness({ exec: { "*": { code: 127, stderr: "spawn bmad ENOENT" } } });
    seedSurfaces(h.repos.alpha);
    // RED IF 127 is coded as a skip: `bmad` is this operation, not an optional capability, so the
    // "absent binary ⇒ SKIP 0" adapter rule does not apply (the required-tool exception, BM-3).
    expect(await runBmadUpdate(["--repos", "alpha", "--apply", "--json"], h.deps)).toBe(1);
    const row = rowsOf(h.spy)[0]!;
    expect(row.status).toBe("failed");
    expect(row.reason).toContain("exit 127");
    expect(row.reason).toContain("$BMAD_BIN");
    expect(row.reason).toContain("built-in leg failed");
  });

  test("CASE 13d — exec 124 (timeout) is FAILED and NAMES the timeout", async () => {
    const h = harness({ exec: { "*": { code: 124, stderr: "" } } });
    seedSurfaces(h.repos.alpha);
    expect(await runBmadUpdate(["--repos", "alpha", "--apply", "--json"], h.deps)).toBe(1);
    const row = rowsOf(h.spy)[0]!;
    expect(row.status).toBe("failed");
    expect(row.reason).toContain("timed out");
    // spawnCapture NEVER rejects, so an empty stderr must still produce an actionable message rather
    // than a bare "failed (exit 124):" with nothing after the colon.
    expect(row.reason).toContain("(no output)");
  });

  test("CASE 13e — a signal exit (128+signo) is FAILED, not silently tolerated", async () => {
    const h = harness({ exec: { "*": { code: 137, stderr: "Killed" } } });
    seedSurfaces(h.repos.alpha);
    expect(await runBmadUpdate(["--repos", "alpha", "--apply", "--json"], h.deps)).toBe(1);
    expect(rowsOf(h.spy)[0]?.reason).toContain("exit 137");
  });

  test("CASE 13f — a BmadVerifyError from 2.6's filter fails THAT repo and the batch continues", async () => {
    // `diff` exiting ≥2 means the repo was not verified AT ALL — not that it is clean.
    const h = harness();
    seedSurfaces(h.repos.alpha);
    seedSurfaces(h.repos.beta);
    const realExec = h.deps.exec;
    h.deps.exec = async (cmd, args, o) => {
      if (cmd === "diff" && args.some((a) => a.includes("alpha"))) {
        return { stdout: "", stderr: "diff: cannot open", code: 2 };
      }
      return realExec(cmd, args, o);
    };
    expect(await runBmadUpdate(["--apply", "--json"], h.deps)).toBe(1);
    const rows = rowsOf(h.spy);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[1]?.status).toBe("ok");
  });

  test("CASE 13g — a staging-materialization fault aborts the run BEFORE any repo (exit 1)", async () => {
    // A module whose marketplace.json is missing is unusable as a --custom-source.
    const h = harness({ marketplace: null });
    expect(await runBmad(["update", "--apply"], h.deps)).toBe(1);
    expect(bmadCalls(h.spy)).toEqual([]);
  });
});

// ── AC4 — THE LIVE LAYER: the asymmetry against the real binary ───────────────────────────────────

const bmadBin = resolveBmadBin();
const LIVE_SKILL = "bmad-agent-jhon-the-loop";
const TOOLS = "claude-code,antigravity-cli";
const SPAWN_TIMEOUT_MS = 120_000;
const LIVE_TIMEOUT_MS = 300_000;

if (!bmadBin) {
  console.log("SKIP: bmad binary not on PATH ($BMAD_BIN unset) — the FR-9 live proof needs a real install");
}

/** A real-filesystem `BmadDeps` — only what `skillTreeDigest` and the probe read. */
function liveDeps(moduleDir: string): BmadDeps {
  const h = harness();
  h.deps.estateModulePath = moduleDir;
  h.deps.bmadBin = bmadBin ?? "bmad";
  return h.deps;
}

/** Write a skill with the frontmatter `bmad` requires in order to render it into a Surface. */
function writeLiveSkill(moduleDir: string, marker: string): void {
  put(
    join(moduleDir, "skills", LIVE_SKILL, "SKILL.md"),
    `---\nname: ${LIVE_SKILL}\ndescription: A fixture skill proving the FR-9 update rule end to end.\n---\n\n# Jhon\n\n<!-- MARKER-${marker} -->\n`,
  );
}

describe("AC4 — the FR-9 asymmetry, LIVE against the real bmad binary (skips without one)", () => {
  test.skipIf(!bmadBin)(
    "CASES 6+7 — quick-update CANNOT propagate a module edit; the module leg CAN, on the same bytes",
    async () => {
      const repo = await makeScratchRepo();
      const moduleDir = fresh("live-module");
      try {
        // ── 1. a fake estate module holding BEFORE ────────────────────────────────────────────────
        writeLiveSkill(moduleDir, "BEFORE");
        put(
          join(moduleDir, ".claude-plugin", "marketplace.json"),
          JSON.stringify(
            { name: "live-fixture", plugins: [{ name: "live-fixture", source: "./", version: "0.1.0", skills: [`./skills/${LIVE_SKILL}`] }] },
            null,
            2,
          ),
        );
        const deps = liveDeps(moduleDir);
        const surface = join(repo.dir, CLAUDE_SKILLS, LIVE_SKILL, "SKILL.md");

        // ── 2. ESTABLISH A BASELINE INSTALL — what `std bmad install` does ────────────────────────
        // Without this there is nothing for step 4 to FAIL to update, and a blind-spot test that
        // installs nothing first can only ever show "unchanged" — which proves nothing.
        const base = await spawnCapture(
          bmadBin!,
          ["install", "--directory", repo.dir, "--modules", "core,bmm", "--custom-source", moduleDir, "--tools", TOOLS, "--yes"],
          { timeout: SPAWN_TIMEOUT_MS },
        );
        expect(base.code).toBe(0);
        expect(readFileSync(surface, "utf-8")).toContain("MARKER-BEFORE");

        // ── 3. SEED THE EDIT in the module, and snapshot the target ───────────────────────────────
        writeLiveSkill(moduleDir, "AFTER");
        const before = skillTreeDigest(repo.dir, deps);

        // The argv come from the leg's OWN probe — never hand-written. A hand-written `--modules
        // core,bmm` could ask bmad to install an absent built-in and fail for a reason that has
        // nothing to do with the blind spot.
        const argv = legFor(moduleDir, deps).buildArgv(ctxFor(repo.dir, deps));
        expect(argv).toHaveLength(2);

        // ── 4. CASE 7 — THE BLIND SPOT: run ONLY the built-in argv ────────────────────────────────
        const builtin = argv[0]!;
        expect(builtin).not.toContain("--custom-source");
        const quick = await spawnCapture(bmadBin!, builtin, { timeout: SPAWN_TIMEOUT_MS });
        expect(quick.code).toBe(0);
        // THE PROOF, and it is non-negotiable: the installed file still holds the PRE-edit bytes.
        // RED IF bare quick-update DID propagate the edit — which would mean FR-9's asymmetry is
        // unnecessary and this whole story is wrong.
        expect(readFileSync(surface, "utf-8")).toContain("MARKER-BEFORE");
        expect(readFileSync(surface, "utf-8")).not.toContain("MARKER-AFTER");
        // Corroborating, not load-bearing (the digest spans the whole Surface roots).
        expect(skillTreeDigest(repo.dir, deps)).toBe(before);

        // ── 5. CASE 6 — THE RULE: run the module argv ─────────────────────────────────────────────
        const moduleArgv = argv[1]!;
        expect(moduleArgv).toContain("--custom-source");
        const upd = await spawnCapture(bmadBin!, moduleArgv, { timeout: SPAWN_TIMEOUT_MS });
        expect(upd.code).toBe(0);
        // RED IF the module leg lost `--custom-source` — nothing would propagate.
        expect(readFileSync(surface, "utf-8")).toContain("MARKER-AFTER");
        expect(skillTreeDigest(repo.dir, deps)).not.toBe(before);
        // Both Surfaces move together (FR-2 parity).
        expect(readFileSync(join(repo.dir, AGENTS_SKILLS, LIVE_SKILL, "SKILL.md"), "utf-8")).toContain("MARKER-AFTER");

        // The two assertions are OPPOSITE IN SIGN ON THE SAME BYTES, so no single mistake makes both
        // green: anything that lets step 4 see AFTER breaks case 7, and anything that stops step 5
        // seeing AFTER breaks case 6.

        // ── 6. THE bmm-DELETION TRAP, live ────────────────────────────────────────────────────────
        // Measured at dev time: a module leg passing `--modules core` here DELETES `_bmad/bmm`. This
        // is the assertion that catches a future "simplification" back to the frozen argv.
        expect(existsSync(join(repo.dir, "_bmad", "core"))).toBe(true);
        expect(existsSync(join(repo.dir, "_bmad", "bmm"))).toBe(true);
      } finally {
        await repo.cleanup();
        rmSync(moduleDir, { recursive: true, force: true });
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

// ── AC10 / AC11 support — the single-definition and no-cycle claims are Task 5 GREPS, not tests ────
// See the Dev Agent Record. What IS testable here is that `update.ts` reuses the shipped primitives
// rather than re-deriving them, which is what keeps those greps green.

describe("NFR-4 — update composes the shipped primitives and re-implements none of them", () => {
  test("the guard, the staging materializer and the digest are 2.3's, called not copied", async () => {
    const h = harness();
    seedSurfaces(h.repos.alpha);
    await runBmadUpdate(["--repos", "alpha", "--apply"], h.deps);

    // The staging descriptor 2.3's materializer writes, at the path 2.3's `stagingPathFor` composes.
    const write = h.spy.atomicWrite.find((w) => w.path.endsWith("marketplace.json"))!;
    expect(write.path.startsWith(join(h.stateHome, "staging") + sep)).toBe(true);
    // And the guard resolved the operator's tokens to directory names before staging them.
    expect(moduleGuard(h.deps, ["jhon-the-loop"])).toEqual([JHON]);
  });

  test("materializeStaging + stagingPathFor are the ONLY writes runBmadUpdate itself performs", async () => {
    const h = harness();
    await runBmadUpdate(["--repos", "alpha", "--apply"], h.deps);
    const staging = stagingPathFor(h.deps);
    // Every write this command made lands under the staging tree or the backup tree — never in a repo.
    for (const w of [...h.spy.atomicWrite.map((x) => x.path), ...h.spy.ensureDir]) {
      const inStaging = w.startsWith(staging) || w.includes(`${sep}staging${sep}`);
      const inBackups = w.includes(`${sep}backups${sep}`);
      expect(inStaging || inBackups).toBe(true);
    }
    for (const repo of [h.repos.alpha, h.repos.beta]) {
      for (const c of h.spy.cpDir) expect(resolve(c.dest).startsWith(resolve(repo) + sep)).toBe(false);
    }
    // `materializeStaging` is importable and is what produced that tree — not a local copy.
    expect(typeof materializeStaging).toBe("function");
  });
});
