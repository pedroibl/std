// Story 2.2 acceptance suite — the `std bmad` command surface and the dry-run gate (AC1–AC8).
//
// What this suite is really defending: the FR-5/SM-6 safety contract. Three of its assertions are the
// contract itself rather than ordinary coverage, and each is written to fail LOUDLY if a later story
// erodes it:
//   1. `--push` is never implied by `--apply` (the flag-separation matrix).
//   2. A dry run and its `--apply` twin report the IDENTICAL plan, and the plan is built exactly ONCE
//      per repo (the Epic-5 `--brain` defect class).
//   3. A dry run touches no mutating dep — proven by injecting a `BmadDeps` whose `exec`/write members
//      THROW and whose `git` throws on every WRITE subcommand, then running and asserting it does not.
//
// HOW "buildPlan ran exactly once" IS OBSERVED. `runRepoPipeline` calls the module-local `buildPlan`
// directly, so an ESM spy on the export would never see that call — it would pass while a recompute
// went undetected, which is worse than no test. Instead the suite counts the two effects `buildPlan`
// necessarily produces: one `leg.buildArgv` call and one `deps.clock()` call. A second plan computation
// on the apply path fires both a second time, so the counters catch it at the real seam.
//
// IDENTITY-FREE fixtures (AC8). `check:no-consumer-ids` skips `*.test.ts`, but a real machine path in a
// fixture is bad hygiene regardless: repos here are `alpha`/`beta`/`gamma` under `/srv/estate/…`, the
// manifest is an `os.tmpdir()` file, and no `/Users/…` literal appears anywhere in this file.
//
// AMENDED BY STORY 2.3 (the C4 async cascade + the first real `--apply` bodies). Two mechanical changes
// and one semantic one:
//   - `runRepoPipeline`/`runBatch` return promises now, so every call site awaits.
//   - `fakeDeps` grew `fs.exists` (real — a read) and `fs.cpDir` (throws — a write), matching the seam
//     `deps.ts` concretized, and it now points `estateModulePath` at a REAL synthetic estate, because
//     the FR-6 module guard runs in dry-run too and a nonexistent module is (correctly) fatal.
//   - The `--apply` half of the zero-IO assertions MOVED to `install.test.ts`. It is no longer true that
//     `--apply` does nothing — that was 2.2's scaffold state, not a contract. What IS the permanent
//     contract, and stays here, is that a DRY RUN (with or without `--push`) touches no mutating dep.
//
// AMENDED BY STORY 2.4 (the live git posture read). `fakeDeps.git` no longer throws unconditionally: it
// throws on every WRITE subcommand and returns `""` for reads. That is a NARROWING of the fake, not a
// weakening of the contract — 2.4/AC7 requires the posture read (`rev-parse`/`rev-list`) to run in BOTH
// modes precisely because it mutates nothing, and "a dry run issues no `add`/`commit`/`push`" is the
// invariant that was always meant. The provisional-posture test below became the live-read test.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HELP, runMain } from "../cli/main";
import { batchExit, runBatch } from "./batch";
import { makeEstateModule, readOnlyGit, removeTempTree } from "./bmad.test-helpers";
import { BMAD_USAGE, runBmad } from "./cli";
import { defaultBmadDeps, type BmadDeps, type InstallLeg, type RepoResult } from "./deps";
import type { BmadRepo } from "./manifest";
import { DEFAULT_SKILLS, parseBmadOpts } from "./opts";
import { buildPlan, runRepoPipeline } from "./pipeline";

const scratch = mkdtempSync(join(tmpdir(), "bmad-dryrun-"));
// A valid estate carrying exactly the two default skills — what the FR-6 guard expects to find, so
// these dry-run cases exercise the paths they were written for rather than aborting at the guard.
const estateModule = makeEstateModule();
let seq = 0;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  removeTempTree(estateModule);
});

/** Write a TOML manifest fixture to a fresh temp file and return its path (the injected `manifestPath`). */
function manifest(toml: string): string {
  const path = join(scratch, `estate-${seq++}.toml`);
  writeFileSync(path, toml, "utf-8");
  return path;
}

const TWO_REPOS = `
[[repos]]
path = "/srv/estate/alpha"
claudeTracked = true
hasUpstream = true
branch = "main"

[[repos]]
path = "/srv/estate/beta"
claudeTracked = true
hasUpstream = false
`;

const ALPHA: BmadRepo = {
  path: "/srv/estate/alpha",
  tools: ["claude-code"],
  claudeTracked: true,
  hasUpstream: true,
  branch: "main",
};

/** Counters every fake exposes, so a test can assert how many times the plan-producing effects fired. */
interface Counts {
  buildArgv: number;
  clock: number;
  print: string[];
  logged: string[];
  json: unknown[];
}

/**
 * A `BmadDeps` whose every MUTATING member throws. `readIfExists` stays real (the manifest load must
 * work), and the render members capture instead of writing — output is not a mutation. This is the AC4
 * instrument: if any code path under test shells, touches git, or writes, the test explodes by name.
 */
function fakeDeps(overrides: Partial<BmadDeps> = {}): { deps: BmadDeps; counts: Counts } {
  const counts: Counts = { buildArgv: 0, clock: 0, print: [], logged: [], json: [] };
  const boom = (what: string) => () => {
    throw new Error(`IO in 2.2: ${what}`);
  };
  const deps: BmadDeps = {
    exec: boom("exec") as unknown as BmadDeps["exec"],
    // READS PERMITTED, WRITES FATAL (narrowed by 2.4, and deliberately narrowed rather than dropped).
    // 2.4's live posture read (`rev-parse`/`rev-list`) runs in BOTH modes because it mutates nothing —
    // a dry run that reported a stale branch would be previewing the wrong repo state. The FR-5
    // guarantee is that a dry run performs no git WRITE, and that is now what this pins by name.
    // The `""` return matches `src/git`'s fail-soft behavior for ALPHA's non-existent path.
    git: readOnlyGit("dry run"),
    fs: {
      // The real reader — loading a fixture manifest is a READ, and reads are not mutations.
      readIfExists: (p: string) => {
        try {
          return readFileSync(p, "utf-8");
        } catch {
          return null;
        }
      },
      // A real presence check — `exists` is a READ, and the guard and the backup filter both need it
      // to tell "absent" from "there". Making it throw would prove nothing about mutation.
      exists: (p: string) => existsSync(p),
      atomicWrite: boom("fs.atomicWrite"),
      ensureDir: boom("fs.ensureDir"),
      cpDir: boom("fs.cpDir"),
    },
    report: {
      lines: () => {
        const buf: string[] = [];
        return { p: (l = "") => void buf.push(l), toString: () => buf.join("\n") };
      },
      jsonOutput: (d) => JSON.stringify(d, null, 2),
      emitJson: (d) => void counts.json.push(d),
      log: (m) => void counts.logged.push(m),
      print: (m) => void counts.print.push(m),
    },
    // FIXED clock (BM-8). `planned.backupPath` embeds `deps.clock()`, so a live ISO clock would make
    // the dry-run and apply plans differ by timestamp and the AC3 equality would fail for the wrong
    // reason. Fixing it here is what makes the real invariant testable.
    clock: () => {
      counts.clock++;
      return "T0";
    },
    bmadBin: "bmad",
    manifestPath: manifest(TWO_REPOS),
    estateModulePath: estateModule,
    backupRoot: "/tmp/estate-backups",
    ...overrides,
  };
  return { deps, counts };
}

/** A leg that counts its own invocations — the primary "was the plan built twice?" probe. */
function countingLeg(counts: Counts): InstallLeg {
  return {
    kind: "install",
    buildArgv: (ctx) => {
      counts.buildArgv++;
      return ["install", "--directory", ctx.repo.path];
    },
  };
}

describe("parseBmadOpts — the flag-separation matrix (AC2)", () => {
  test("no flags ⇒ dry-run, no push: the default is safe", () => {
    const opts = parseBmadOpts([]);
    expect(opts.apply).toBe(false);
    expect(opts.push).toBe(false);
    expect(opts.forceTrack).toBe(false);
  });

  test("--apply does NOT imply --push (the FR-5/SM-6 contract)", () => {
    const opts = parseBmadOpts(["--apply"]);
    expect(opts.apply).toBe(true);
    expect(opts.push).toBe(false);
  });

  test("--apply --push ⇒ both", () => {
    const opts = parseBmadOpts(["--apply", "--push"]);
    expect(opts.apply).toBe(true);
    expect(opts.push).toBe(true);
  });

  test("--push alone ⇒ push intent without apply (still a dry run)", () => {
    const opts = parseBmadOpts(["--push"]);
    expect(opts.apply).toBe(false);
    expect(opts.push).toBe(true);
  });

  test("selectors come from 2.1's parseSelectors, unchanged", () => {
    const opts = parseBmadOpts([
      "--repos",
      "alpha,beta",
      "--tools",
      "claude-code",
      "--set",
      "bmm.a=1",
      "--set",
      "core.b=2",
    ]);
    expect(opts.repos).toEqual(["alpha", "beta"]);
    expect(opts.tools).toEqual(["claude-code"]);
    expect(opts.set).toEqual([
      { module: "bmm", key: "a", value: "1" },
      { module: "core", key: "b", value: "2" },
    ]);
  });

  test("absent selectors stay absent (no explicit-undefined keys)", () => {
    const opts = parseBmadOpts([]);
    expect(opts.repos).toBeUndefined();
    expect(opts.tools).toBeUndefined();
    expect(opts.set).toEqual([]);
  });
});

describe("parseBmadOpts — --skills is additive (AC2/BM-12)", () => {
  test("absent ⇒ exactly the loop-family default", () => {
    expect(parseBmadOpts([]).skills).toEqual([...DEFAULT_SKILLS]);
  });

  test("--skills ADDS to the default, it does not replace it", () => {
    const { skills } = parseBmadOpts(["--skills", "dev-the-loop"]);
    expect(skills).toContain("dev-the-loop");
    for (const d of DEFAULT_SKILLS) expect(skills).toContain(d);
  });

  test("comma-separated values are split and de-duplicated", () => {
    const { skills } = parseBmadOpts(["--skills", `x , y , ${DEFAULT_SKILLS[0]}`]);
    expect(skills).toContain("x");
    expect(skills).toContain("y");
    expect(skills.filter((s) => s === DEFAULT_SKILLS[0]).length).toBe(1);
  });
});

describe("single source of plan (AC3 — BM-14, the --brain defect class)", () => {
  // The dry-run/apply plan equality over a REAL apply (which now backs up and shells) is asserted in
  // `install.test.ts`; here it is proven over the dry-run side alone, where the fake's mutating members
  // still throw. Both matter: this one says the plan does not depend on `apply`, that one says the plan
  // survives the mutation path unchanged.
  test("a dry run's plan does not depend on the --apply flag", () => {
    const { deps, counts } = fakeDeps();
    const leg = countingLeg(counts);
    const dry = buildPlan(ALPHA, leg, parseBmadOpts([]), deps);
    const applied = buildPlan(ALPHA, leg, parseBmadOpts(["--apply"]), deps);
    // Compared on `planned` ONLY — the outcome fields are deliberately excluded (BM-14).
    expect(JSON.stringify(applied)).toBe(JSON.stringify(dry));
  });

  test("the plan is built EXACTLY ONCE per repo per run, in both modes", async () => {
    for (const argv of [[], ["--apply"]]) {
      const { deps, counts } = fakeDeps();
      // `--apply` reaches the backup filter, whose `cpDir` throws by construction — but only if a
      // Surface tree EXISTS, and `/srv/estate/alpha` does not, so the filter is a reported no-op and
      // the run reaches the installer, whose `exec` throws. Catching keeps the counter assertion the
      // subject of this test rather than the mutation behavior (which `install.test.ts` owns).
      await runRepoPipeline(ALPHA, countingLeg(counts), parseBmadOpts(argv), deps).catch(() => {});
      // One leg.buildArgv + one clock read = one buildPlan. Two of either = a recompute on some path.
      expect(counts.buildArgv).toBe(1);
      expect(counts.clock).toBe(1);
    }
  });

  test("buildPlan is pure — same inputs, same projection", () => {
    const { deps, counts } = fakeDeps();
    const leg = countingLeg(counts);
    const opts = parseBmadOpts(["--push"]);
    expect(buildPlan(ALPHA, leg, opts, deps)).toEqual(buildPlan(ALPHA, leg, opts, deps));
  });

  test("wouldPush tracks --push and is independent of --apply", () => {
    const { deps, counts } = fakeDeps();
    const leg = countingLeg(counts);
    expect(buildPlan(ALPHA, leg, parseBmadOpts([]), deps).wouldPush).toBe(false);
    expect(buildPlan(ALPHA, leg, parseBmadOpts(["--apply"]), deps).wouldPush).toBe(false);
    expect(buildPlan(ALPHA, leg, parseBmadOpts(["--push"]), deps).wouldPush).toBe(true);
  });

  test("the leg authors installArgv — the pipeline never inlines it (BM-15)", () => {
    const { deps } = fakeDeps();
    const leg: InstallLeg = { kind: "update", buildArgv: () => ["sentinel-argv"] };
    expect(buildPlan(ALPHA, leg, parseBmadOpts([]), deps).installArgv).toEqual(["sentinel-argv"]);
  });

  test("backupPath composes backupRoot / repo name / clock (BM-8)", () => {
    const { deps, counts } = fakeDeps();
    const plan = buildPlan(ALPHA, countingLeg(counts), parseBmadOpts([]), deps);
    expect(plan.backupPath).toBe(join("/tmp/estate-backups", "alpha", "T0"));
  });
});

describe("intent vs outcome (AC3/AC5 — BM-14)", () => {
  test("dry-run outcomes are literal zero values, never derived from the plan", async () => {
    const { deps, counts } = fakeDeps();
    const r = await runRepoPipeline(ALPHA, countingLeg(counts), parseBmadOpts(["--push"]), deps);
    expect(r.planned.wouldPush).toBe(true); // intent
    expect(r.pushed).toBe(false); // outcome
    expect(r.committed).toBe(false);
    expect(r.stagedPaths).toEqual([]);
    expect(r.backupPath).toBeUndefined(); // nothing was backed up; only the INTENT has a path
  });

  // REWRITTEN BY 2.4 (this test's own name previously said "live read is 2.4"). ALPHA's path does not
  // exist, so the read-only git fake returns `""` for every read exactly as `src/git` would — which is
  // what makes this the fallback case rather than the happy one. The point being pinned is that neither
  // value comes from the Manifest any more: ALPHA declares `branch = "main"` and `hasUpstream = true`,
  // and BOTH are ignored in favor of the (here failing, hence fallback) live read. `git-safety.test.ts`
  // owns the happy path against real scratch repos.
  test("branch/ahead come from the LIVE read, not the Manifest entry (2.4/AC7)", async () => {
    const { deps, counts } = fakeDeps();
    const r = await runRepoPipeline(ALPHA, countingLeg(counts), parseBmadOpts([]), deps);
    expect(ALPHA.branch).toBe("main"); // what the Manifest says …
    expect(r.branch).toBe("(unknown)"); // … and what the live read says wins
    expect(ALPHA.hasUpstream).toBe(true);
    expect(r.ahead).toBe("no-upstream"); // an unresolvable `@{u}` is never reported as `0 ahead`
  });
});

describe("zero side effects in DRY RUN (AC4 — NFR-1)", () => {
  // Narrowed by 2.3 from "neither mode" to "dry run". `--apply` genuinely mutates now — that is the
  // point of 2.3 — and `install.test.ts` owns what it is allowed to touch. The dry-run half is the
  // permanent FR-5 contract and must never be narrowed further.
  test("a dry run touches no mutating dep, with or without --push", async () => {
    const { deps, counts } = fakeDeps();
    const leg = countingLeg(counts);
    // `deps.exec`/`deps.fs.atomicWrite`/`ensureDir`/`cpDir` throw by construction, and `deps.git` throws
    // on every write subcommand (`add`/`commit`/`push`/…). Reaching the assertion at all is the proof:
    // any mutating member fired would have rejected. `--push` is included because an implied push is
    // the one mutation that would reach someone else's remote.
    expect(await runRepoPipeline(ALPHA, leg, parseBmadOpts([]), deps)).toBeDefined();
    expect(await runRepoPipeline(ALPHA, leg, parseBmadOpts(["--push"]), deps)).toBeDefined();
  });

  // The complement of the above, and the sharper form: the fake RECORDS every git call a dry run makes,
  // so this asserts the positive (only reads were issued) rather than merely "nothing threw".
  test("a dry run issues git READS only — never add/commit/push (2.4/AC7)", async () => {
    const calls: string[][] = [];
    const { deps, counts } = fakeDeps({
      git: readOnlyGit("dry run", (_repo, args) => {
        calls.push(args);
        return "";
      }),
    });
    await runRepoPipeline(ALPHA, countingLeg(counts), parseBmadOpts(["--push"]), deps);
    expect(calls.length).toBeGreaterThan(0); // the posture read DID happen
    for (const args of calls) expect(["rev-parse", "rev-list"]).toContain(args[0]);
  });

  test("a full `install` run shells nothing without --apply (even with --push)", async () => {
    for (const argv of [["install"], ["install", "--push"]]) {
      const { deps } = fakeDeps();
      expect(await runBmad(argv, deps)).toBe(0);
    }
  });

  // `buildPlan` calls `buildArgv` BEFORE the --apply gate, so an effect reachable through `ctx.deps`
  // would run during a dry run. `LegDeps` makes that a compile error; this pins it at RUNTIME too, so
  // a single `as BmadDeps` cast inside a future leg (2.3/2.5/2.7) cannot quietly restore the reach.
  test("the leg's ctx.deps carries the resolved values and NONE of the effect surface", async () => {
    const { deps } = fakeDeps();
    let seen: Record<string, unknown> | undefined;
    const spyLeg: InstallLeg = {
      kind: "install",
      buildArgv: (ctx) => {
        seen = ctx.deps as unknown as Record<string, unknown>;
        return ["install"];
      },
    };
    await runRepoPipeline(ALPHA, spyLeg, parseBmadOpts(["--push"]), deps);

    expect(Object.keys(seen ?? {}).sort()).toEqual([
      "backupRoot",
      "bmadBin",
      "estateModulePath",
      "manifestPath",
    ]);
    for (const effect of ["exec", "git", "fs", "report", "clock"]) {
      expect(seen).not.toHaveProperty(effect);
    }
  });
});

describe("batch (AC7 — BM-5/BM-16)", () => {
  test("iterates sequentially in Manifest order and returns one row per repo", async () => {
    const { deps, counts } = fakeDeps();
    const beta: BmadRepo = { ...ALPHA, path: "/srv/estate/beta" };
    const results = await runBatch([ALPHA, beta], countingLeg(counts), parseBmadOpts([]), deps);
    expect(results.map((r) => r.repo)).toEqual(["alpha", "beta"]);
    expect(counts.buildArgv).toBe(2); // once per repo — still exactly one plan each
  });

  test("a failing repo isolates to its own row and the loop continues (FR-15)", async () => {
    const { deps } = fakeDeps();
    const beta: BmadRepo = { ...ALPHA, path: "/srv/estate/beta" };
    const explodingLeg: InstallLeg = {
      kind: "install",
      buildArgv: (ctx) => {
        if (ctx.repo.path.endsWith("alpha")) throw new Error("leg exploded");
        return ["install"];
      },
    };
    const results = await runBatch([ALPHA, beta], explodingLeg, parseBmadOpts([]), deps);
    expect(results.map((r) => r.status)).toEqual(["failed", "ok"]);
    expect(results[0]?.reason).toBe("leg exploded");
    expect(batchExit(results)).toBe(1);
  });

  test("batchExit is 0 when every repo is ok or skipped, 1 when any failed", () => {
    const row = (status: RepoResult["status"]): RepoResult => ({
      repo: "alpha",
      status,
      branch: "main",
      ahead: 0,
      planned: {
        installArgv: [],
        backupPath: "",
        wouldStage: [],
        wouldCommit: false,
        wouldPush: false,
      },
      stagedPaths: [],
      committed: false,
      pushed: false,
    });
    expect(batchExit([row("ok"), row("skipped-gitignored")])).toBe(0);
    expect(batchExit([row("ok"), row("failed")])).toBe(1);
    expect(batchExit([])).toBe(0);
  });
});

describe("render composes src/report through the seam (AC5/AC6)", () => {
  test("human mode writes markdown via deps.report.print, and labels the mode", async () => {
    const { deps, counts } = fakeDeps();
    expect(await runBmad(["install"], deps)).toBe(0);
    const md = counts.print.join("");
    expect(md).toContain("DRY RUN");
    expect(md).toContain("alpha");
    expect(md).toContain("beta");
    expect(md).toContain("would push: no");
    expect(counts.json).toEqual([]); // nothing on the JSON channel in human mode
  });

  test("--json emits the structured ledger and prints no markdown", async () => {
    const { deps, counts } = fakeDeps();
    expect(await runBmad(["install", "--json"], deps)).toBe(0);
    expect(counts.print).toEqual([]);
    expect(counts.json.length).toBe(1);
    const payload = counts.json[0] as { command: string; mode: string; repos: RepoResult[] };
    expect(payload.command).toBe("install");
    expect(payload.mode).toBe("dry-run");
    expect(payload.repos.map((r) => r.repo)).toEqual(["alpha", "beta"]);
  });

  // The dry-run-render vs --apply-render plan equality MOVED to `install.test.ts` in Story 2.3: an
  // `--apply` run now writes a staging tree and shells the installer, so it cannot be driven by this
  // file's deliberately-exploding fake. It is asserted there against a real apply, which is a strictly
  // stronger form of the same SM-3 claim — the plan survives the mutation path, not just the gate.
});

describe("router + exit contract (AC1/AC7 — BM-1)", () => {
  test("install / update / deploy all route and exit 0 on a clean dry run", async () => {
    for (const sub of ["install", "update", "deploy"]) {
      const { deps } = fakeDeps();
      expect(await runBmad([sub], deps)).toBe(0);
    }
  });

  test("each subcommand authors its own leg (BM-15) — update is not install", async () => {
    const argvOf = async (sub: string) => {
      const { deps, counts } = fakeDeps();
      await runBmad([sub, "--json"], deps);
      const payload = counts.json[0] as { repos: RepoResult[] };
      return payload.repos[0]?.planned.installArgv ?? [];
    };
    expect((await argvOf("install"))[0]).toBe("install");
    expect((await argvOf("update"))[0]).toBe("update");
  });

  // Story 2.3 gave the shared pipeline a real mutation path (BM-4: one per-repo filter chain), which
  // silently promoted `update --apply`/`deploy --apply` from 2.2 no-ops into REAL estate-wide runs of
  // their PROVISIONAL legs. Fenced at the command entry until 2.5/2.7 author the real ones. These tests
  // are the fence's tripwire: delete them in the same commit that removes the fence, never before.
  test("update/deploy refuse --apply while their legs are provisional (exit 2, nothing shelled)", async () => {
    for (const sub of ["update", "deploy"]) {
      const { deps, counts } = fakeDeps();
      expect(await runBmad([sub, "--apply"], deps)).toBe(2);
      expect(await runBmad([sub, "--apply", "--push"], deps)).toBe(2);
      // the deliberately-exploding fake would have thrown had the pipeline been reached at all
      expect(counts.json).toHaveLength(0);
    }
  });

  test("the fence is on --apply only — update/deploy dry runs still plan normally", async () => {
    for (const sub of ["update", "deploy"]) {
      const { deps } = fakeDeps();
      expect(await runBmad([sub], deps)).toBe(0);
      expect(await runBmad([sub, "--push"], deps)).toBe(0);
    }
  });

  test("no subcommand ⇒ usage, exit 2", async () => {
    const { deps, counts } = fakeDeps();
    expect(await runBmad([], deps)).toBe(2);
    expect(counts.logged.join("\n")).toContain("usage: std bmad");
  });

  test("an unknown subcommand ⇒ usage, exit 2 (never 0, never 1)", async () => {
    const { deps, counts } = fakeDeps();
    expect(await runBmad(["bogus"], deps)).toBe(2);
    expect(counts.logged.join("\n")).toContain("unknown subcommand 'bogus'");
  });

  test("`verify` is not wired yet (2.6) and falls through to usage/2", async () => {
    const { deps } = fakeDeps();
    expect(await runBmad(["verify"], deps)).toBe(2);
    expect(BMAD_USAGE).toContain("Story 2.6");
  });

  test("an inherited prototype key is not a subcommand", async () => {
    const { deps } = fakeDeps();
    expect(await runBmad(["constructor"], deps)).toBe(2);
    expect(await runBmad(["toString"], deps)).toBe(2);
  });

  test("a missing Manifest is fail-loud: exit 1, message names the path", async () => {
    const { deps, counts } = fakeDeps({ manifestPath: join(scratch, "does-not-exist.toml") });
    expect(await runBmad(["install"], deps)).toBe(1);
    expect(counts.logged.join("\n")).toContain("does-not-exist.toml");
  });

  test("an unknown --repos name is fail-loud: exit 1", async () => {
    const { deps, counts } = fakeDeps();
    expect(await runBmad(["install", "--repos", "nope"], deps)).toBe(1);
    expect(counts.logged.join("\n")).toContain('unknown repo "nope"');
  });

  test("a malformed --set token is fail-loud: exit 1", async () => {
    const { deps, counts } = fakeDeps();
    expect(await runBmad(["install", "--set", "garbage"], deps)).toBe(1);
    expect(counts.logged.join("\n")).toContain("--set");
  });

  test("--repos narrows the run to the named repo", async () => {
    const { deps, counts } = fakeDeps();
    expect(await runBmad(["install", "--json", "--repos", "beta"], deps)).toBe(0);
    const payload = counts.json[0] as { repos: RepoResult[] };
    expect(payload.repos.map((r) => r.repo)).toEqual(["beta"]);
  });
});

describe("main.ts wiring (AC1)", () => {
  /**
   * Run `runMain` with stderr captured. These two cases exercise the REAL `defaultBmadDeps()` (that is
   * the point — the wiring must work without an injected seam), whose `report.log` is a genuine stderr
   * write, so the capture keeps a usage block out of the suite's output and makes the message assertable.
   */
  async function runMainCapturingStderr(argv: string[]): Promise<{ code: number; err: string }> {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await runMain(argv, { log: () => {} });
      return { code, err: chunks.join("") };
    } finally {
      process.stderr.write = original;
    }
  }

  test("`std bmad` reaches runBmad — usage, exit 2", async () => {
    const { code, err } = await runMainCapturingStderr(["bmad"]);
    expect(code).toBe(2);
    expect(err).toContain("usage: std bmad");
  });

  test("`std bmad bogus` reaches the family router, not std's unknown-command path", async () => {
    // std's own unknown-command branch also returns 2, so the discriminator is the MESSAGE: this must
    // be the family's usage, which proves the `if (cmd === "bmad")` block was entered.
    const { code, err } = await runMainCapturingStderr(["bmad", "bogus"]);
    expect(code).toBe(2);
    expect(err).toContain("std bmad: unknown subcommand 'bogus'");
  });

  test("HELP lists bmad, and the unknown-command line names it", () => {
    expect(HELP).toContain("bmad install|update|deploy");
    expect(HELP).toContain("--apply to mutate");
  });
});

describe("defaultBmadDeps resolves identity, never bakes it (AC6/D4)", () => {
  test("bmadBin honors $BMAD_BIN and otherwise resolves via PATH (bare name)", () => {
    expect(defaultBmadDeps({ BMAD_BIN: "/opt/tools/bmad" }).bmadBin).toBe("/opt/tools/bmad");
    expect(defaultBmadDeps({}).bmadBin).toBe("bmad");
  });

  test("backupRoot honors $XDG_STATE_HOME (BM-8)", () => {
    const deps = defaultBmadDeps({ XDG_STATE_HOME: "/var/state" });
    expect(deps.backupRoot).toBe(join("/var/state", "std", "bmad-manager", "backups"));
  });

  test("manifestPath comes from 2.1's resolver, honoring $XDG_CONFIG_HOME (BM-2)", () => {
    expect(defaultBmadDeps({ XDG_CONFIG_HOME: "/var/config" }).manifestPath).toBe(
      join("/var/config", "std", "estate.toml"),
    );
  });

  test("estateModulePath honors $BMAD_ESTATE_DIR and is otherwise package-relative (BM-13)", () => {
    expect(defaultBmadDeps({ BMAD_ESTATE_DIR: "/opt/estate" }).estateModulePath).toBe("/opt/estate");
    // No env override: it must still be an absolute path ending in the package's own payload dir,
    // resolved from this file's location rather than baked as a machine path.
    expect(defaultBmadDeps({}).estateModulePath.endsWith("bmad-estate")).toBe(true);
  });

  test("clock is a real ISO timestamp in production wiring", () => {
    expect(defaultBmadDeps({}).clock()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
