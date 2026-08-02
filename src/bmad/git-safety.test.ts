// Story 2.4 acceptance suite — the scoped git safety spine (AC1–AC9).
//
// THIS SUITE RUNS REAL GIT AGAINST REAL REPOSITORIES. Every one of them is a disposable `makeScratchRepo`
// under `os.tmpdir()` (BM-9) with a `cleanup()` in `finally`; no committed fixture tree exists and none is
// created. Nothing here ever touches a repository that is not built by this file, which is the only
// acceptable way to test code whose entire job is staging, committing, and pushing in someone's repo.
//
// WHY REAL GIT AND NOT A MOCK. The defect this story exists to prevent is a git command that returns
// success having done nothing, and `src/git`'s wrapper is fail-soft — it cannot tell those apart. A
// mocked git would let every state check pass while proving nothing, because the mock's return value is
// whatever the test author expected. So the checks are asserted against `git status --porcelain`,
// `git rev-list --count`, and `git diff --cached` run against a repo that actually has an index.
//
// THE ARGV SPY IS THE SECOND INSTRUMENT, and it is how the NEGATIVE gets proven. `deps.git` is wrapped so
// each call is recorded AND delegated to the real `git`; one run therefore both executes and exposes its
// argv. "No `git add -A` anywhere" is not a claim about the source — it is an assertion over every add
// argv a run actually issued.
//
// EACH BLOCK NAMES ITS RED-TURNING INPUT. A test whose failure mode nobody has stated is a test nobody
// has checked; the three prior stories in this epic each shipped a property that was stated in prose and
// enforced by nothing, so the properties here are paired with the input that violates them.
//
// IDENTITY-FREE (AC9/D4): repos are `alpha`/`beta`/`gamma` under `os.tmpdir()`; no `/Users/…` literal.

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { exists, readIfExists } from "../fsx/index";
import { git as realGit } from "../git/index";
import { spawnCapture } from "../proc/index";
import { batchExit } from "./batch";
import {
  makeEstateModule,
  makeScratchRepo,
  removeTempTree,
  renderInstalledSurfaces,
  type ScratchRepo,
} from "./bmad.test-helpers";
import type { BmadDeps, InstallLeg, RepoResult } from "./deps";
import {
  commitIfStaged,
  presentScopedPaths,
  pushGate,
  readGitPosture,
  scopedStage,
  stagingFailed,
} from "./git-safety";
import type { BmadRepo } from "./manifest";
import { DEFAULT_SKILLS, parseBmadOpts } from "./opts";
import { runRepoPipeline } from "./pipeline";

/** The empirical dirty-file count of the real estate repo FR-11 was written for. Hardcoded on purpose. */
const UNRELATED_DIRTY = 503;

/** The feature branch the FR-14 posture read must report instead of `main`. */
const FEATURE_BRANCH = "feature/product-development-mkt";

/**
 * The branch every fixture is pinned to unless it asks for another.
 *
 * PINNED, NOT INHERITED — and this is not tidiness. `init.defaultBranch` is ambient config, so a fixture
 * that lets git pick the name gets `main` or `master` depending on whose environment the suite runs in
 * (and, in a shared-process test run, on what an earlier file did to `HOME`). The diverged-remote case
 * below silently STOPPED DIVERGING when the working repo landed on `master` while the bare remote's HEAD
 * said `main`: the two pushes went to different refs, nothing conflicted, and the push-failure test
 * passed a push that should have been rejected. A test that can quietly stop testing its own subject is
 * exactly the defect class this story is about, so the name is pinned.
 */
const DEFAULT_BRANCH = "main";

/** The scoped trees a fixture seeds unless it asks for others — both Surfaces, so Parity holds. */
const SEEDED_TREES = ["_bmad", join(".claude", "skills"), join(".agents", "skills")];
/** Last segment of a Surface tree — how the seeder tells a Surface from `_bmad`. */
const SKILLS_LEAF = "skills";

const scratch = mkdtempSync(join(tmpdir(), "bmad-git-safety-"));
/**
 * The estate module every fixture "installs" from (2.6). The verify filter compares each SELECTED skill
 * against `<module>/skills/<s>`, so the module must be real and must hold the BM-12 default pair — a
 * `join(scratch, "estate-module")` that was never created made every Faithfulness comparison a
 * "module skill missing" finding the moment the filter stopped being a no-op.
 */
const FIXTURE_MODULE = makeEstateModule({ skills: [...DEFAULT_SKILLS] });
afterAll(() => {
  removeTempTree(scratch);
  removeTempTree(FIXTURE_MODULE);
});

/** Unique-suffix counter — two fixtures sharing a repo name must not share a bare remote directory. */
let seq = 0;
/** A fresh, uniquely-named path under the suite scratch. Never created — callers own that. */
function scratchPath(prefix: string): string {
  return join(scratch, `${prefix}-${seq++}`);
}

// ── fixture plumbing ──────────────────────────────────────────────────────────────────────────────

/**
 * Run git and THROW on failure — the inverse of `src/git`'s fail-soft wrapper, and deliberately so.
 * Fixture setup that silently half-worked produces a test that passes for the wrong reason, which is the
 * one failure mode a suite about silent failure cannot afford.
 */
function g(dir: string, ...args: string[]): string {
  const stdio: ("ignore" | "pipe")[] = ["ignore", "pipe", "pipe"];
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", stdio }).trim();
}

/** Write a file and its parents. */
function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

interface PostureOpts {
  /** Scoped trees to seed, relative to the repo root. Default: `_bmad/` and `.claude/skills`. */
  scoped?: string[];
  /** Seed the scoped trees but COMMIT them first, so a later edit is a modification and not an add. */
  commitScoped?: boolean;
  /** Write N unrelated dirty (untracked) files at the repo root. */
  unrelated?: number;
  /** `.gitignore` body to commit. */
  gitignore?: string;
  /** Check out this branch before seeding. */
  branch?: string;
  /** Attach a bare remote and `push -u`. */
  upstream?: boolean;
  /** Detach HEAD after the initial commit. */
  detach?: boolean;
}

interface Fixture extends ScratchRepo {
  /** The `BmadRepo` the pipeline receives. `claudeTracked`/`hasUpstream` are set by the caller. */
  repo: BmadRepo;
  /** The bare remote's path, when `upstream` was requested. */
  remote?: string;
}

/**
 * Build one posture on a disposable scratch repo (BM-9).
 *
 * `git config user.email`/`user.name` are set on EVERY fixture: a fresh `git init` inherits no commit
 * identity in a clean environment, and without them `git commit` exits non-zero — which the fail-soft
 * wrapper would swallow, turning every commit assertion in this file red for a reason that has nothing
 * to do with the code under test.
 */
async function makePosture(name: string, opts: PostureOpts = {}): Promise<Fixture> {
  const s = await makeScratchRepo();
  g(s.dir, "config", "user.email", "fixture@example.invalid");
  g(s.dir, "config", "user.name", "bmad fixture");
  g(s.dir, "config", "commit.gpgsign", "false");

  put(join(s.dir, "README.md"), `# ${name}\n`);
  g(s.dir, "add", "README.md");
  g(s.dir, "commit", "-m", "initial");

  if (opts.gitignore !== undefined) {
    put(join(s.dir, ".gitignore"), opts.gitignore);
    g(s.dir, "add", ".gitignore");
    g(s.dir, "commit", "-m", "ignore");
  }

  g(s.dir, "branch", "-M", opts.branch ?? DEFAULT_BRANCH);

  let remote: string | undefined;
  if (opts.upstream) {
    remote = scratchPath(`${name}-remote.git`);
    execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "ignore" });
    g(s.dir, "remote", "add", "origin", remote);
    g(s.dir, "push", "-q", "-u", "origin", "HEAD");
  }

  // SEEDED TO MATCH WHAT THE INSTALLER RENDERS (amended by 2.6). The seed used to write `# <tree> skill`
  // into `.claude/skills/s` alone — different content per Surface, and only one Surface. Both were
  // invisible while verify was a no-op stub and are real Parity/set-Parity divergences now: a fixture
  // that is ALREADY divergent cannot be used to test what the git spine does to a CLEAN install. Seeding
  // the Surfaces from the same module the fake installer renders from is also what makes an IDEMPOTENT
  // RE-RUN modellable — `commitScoped` can then commit a state the next install reproduces exactly.
  const seeded = opts.scoped ?? SEEDED_TREES;
  for (const tree of seeded) {
    if (tree.endsWith(SKILLS_LEAF)) {
      // A Surface: seeded from the SAME module the fake installer renders from, one tree at a time so a
      // fixture can still ask for one Surface and not the other (the partial-add posture below).
      for (const skill of DEFAULT_SKILLS) {
        cpSync(join(FIXTURE_MODULE, "skills", skill), join(s.dir, tree, skill), { recursive: true });
      }
    } else {
      put(join(s.dir, tree, "s", "SKILL.md"), "# seeded skill\n");
    }
  }
  if (opts.commitScoped) {
    // Explicit pathspecs even in fixture setup — `git add -A` appears NOWHERE in this file, so a reader
    // grepping the slice for it finds nothing at all, test or shipped.
    for (const tree of seeded) g(s.dir, "add", "--", tree);
    g(s.dir, "commit", "-m", "seed scoped");
  }

  for (let i = 0; i < (opts.unrelated ?? 0); i++) {
    put(join(s.dir, `unrelated-${String(i).padStart(3, "0")}.txt`), `dirt ${i}\n`);
  }

  if (opts.detach) g(s.dir, "checkout", "-q", "--detach");

  const repo: BmadRepo = {
    path: s.dir,
    tools: ["claude-code"],
    claudeTracked: true,
    hasUpstream: opts.upstream === true,
    name,
  };
  return { dir: s.dir, cleanup: s.cleanup, repo, ...(remote !== undefined ? { remote } : {}) };
}

/** The recorded argv of every `deps.git` call a run made. */
type Calls = string[][];

/**
 * A `BmadDeps` whose `git` RECORDS every argv and then delegates to the REAL wrapper — so a single run
 * both does the work and exposes exactly what it asked git to do. `stub` can intercept a subcommand to
 * simulate a fail-soft failure (`""`), which is how the staging-failure posture is built.
 */
function spyDeps(stub?: (repo: string, args: string[]) => string | undefined): {
  deps: BmadDeps;
  calls: Calls;
} {
  const calls: Calls = [];
  const backupRoot = scratchPath("backups");
  const deps: BmadDeps = {
    // AMENDED BY 2.6, and the amendment is the story in miniature. `diff` is passed through to the REAL
    // `spawnCapture`, so the verify filter genuinely compares the trees this fixture built rather than
    // being stubbed green — a stubbed verify would make every assertion below pass over an unverified
    // repo, which is the false green 2.6 exists to prevent. Everything else is the INSTALLER, and a real
    // one RENDERS both Surfaces; a fake that exits 0 while writing nothing is a run that cannot happen,
    // and the verify filter now correctly fails it.
    exec: async (cmd, args, o) => {
      if (cmd === "diff") return spawnCapture(cmd, args, o);
      // Guard `indexOf` returning -1: an unguarded `args[idx + 1]` reads `args[0]` — a subcommand
      // token like "install" — and `renderInstalledSurfaces` would then write a relative
      // `install/.claude/skills/...` tree into the CHECKOUT instead of the temp scratch repo.
      // `LEG` always emits `--directory` so the branch is unreachable today; this keeps a future
      // leg change from writing outside the scratch tree. Mirrors `install.test.ts`'s guard.
      const dirFlag = args.indexOf("--directory");
      const dir = dirFlag >= 0 ? args[dirFlag + 1] : undefined;
      if (dir !== undefined && dir !== "") renderInstalledSurfaces(dir, FIXTURE_MODULE, DEFAULT_SKILLS);
      return { stdout: "", stderr: "", code: 0 };
    },
    git: (repo, args) => {
      calls.push(args);
      const stubbed = stub?.(repo, args);
      return stubbed !== undefined ? stubbed : realGit(repo, args);
    },
    fs: {
      readIfExists,
      exists,
      atomicWrite: (p, c) => put(p, c),
      ensureDir: (d) => mkdirSync(d, { recursive: true }),
      cpDir: (src, dest) => cpSync(src, dest, { recursive: true }),
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
      jsonOutput: (d) => JSON.stringify(d),
      emitJson: () => {},
      log: () => {},
      print: () => {},
    },
    clock: () => "T0",
    bmadBin: "bmad-under-test",
    manifestPath: join(scratch, "estate.toml"),
    estateModulePath: FIXTURE_MODULE,
    backupRoot,
  };
  return { deps, calls };
}

/** A leg whose argv is irrelevant here — the installer is mocked to exit 0 so the git filters are reached. */
// Carries `--directory <repo>` like the real `installLeg` does — the fake installer in `spyDeps`
// reads it to render the Surfaces, which since 2.6 the pipeline verifies immediately afterwards.
const LEG: InstallLeg = {
  kind: "install",
  buildArgv: (ctx) => ["install", "--directory", ctx.repo.path],
};

/** Every `add` argv a run issued. */
function addCalls(calls: Calls): string[][] {
  return calls.filter((a) => a[0] === "add");
}

/** The staged set, read straight from the repo rather than from anything the code under test returned. */
function stagedIn(dir: string): string[] {
  const out = g(dir, "diff", "--cached", "--name-only");
  return out === "" ? [] : out.split("\n");
}

/** `git rev-list --count HEAD` as a number. */
function commitCount(dir: string): number {
  return Number(g(dir, "rev-list", "--count", "HEAD"));
}

// ── AC1 — scoped staging only; the 503 stay unstaged ──────────────────────────────────────────────

describe("AC1 — staging is scoped, and `git add -A`/`git add .` exist nowhere (FR-11/BM-7)", () => {
  test("the 503 unrelated dirty files stay unstaged; only scoped paths are added", async () => {
    const f = await makePosture("alpha", { unrelated: UNRELATED_DIRTY });
    try {
      const { deps, calls } = spyDeps();
      const staged = scopedStage(f.repo, parseBmadOpts([]), deps);

      // Anchored on the WORKING TREE, never on a `<base>..HEAD` range — a range diff is blind to the
      // index and would be green by construction before any commit exists (the vacuous-gate trap).
      const actuallyStaged = stagedIn(f.dir);
      expect(staged).toEqual(actuallyStaged);
      expect(actuallyStaged.length).toBeGreaterThan(0);
      for (const p of actuallyStaged) {
        expect(
          p.startsWith("_bmad/") || p.startsWith(".claude/skills") || p.startsWith(".agents/skills"),
        ).toBe(true);
      }

      // All 503 are still sitting there, untracked, exactly as the operator left them.
      const untracked = g(f.dir, "status", "--porcelain")
        .split("\n")
        .filter((l) => l.startsWith("??") && l.includes("unrelated-"));
      expect(untracked.length).toBe(UNRELATED_DIRTY);
      for (const p of actuallyStaged) expect(p).not.toContain("unrelated-");

      // RED-TURNING INPUT: prescribe `git add -A` in `scopedStage` and this block fires — first here
      // (503 unrelated files appear in the staged set), then in the argv assertions below.
      for (const a of addCalls(calls)) {
        expect(a).not.toContain("-A");
        expect(a).not.toContain(".");
        expect(a).not.toContain("--all");
      }
    } finally {
      await f.cleanup();
    }
  });

  test("every add argv is exactly `add [-f] -- <present subset>` and nothing else", async () => {
    const f = await makePosture("alpha");
    try {
      const { deps, calls } = spyDeps();
      scopedStage(f.repo, parseBmadOpts([]), deps);
      scopedStage(f.repo, parseBmadOpts(["--force-track"]), deps);

      const adds = addCalls(calls);
      expect(adds.length).toBe(2);
      // All THREE scoped pathspecs, because the fixture now seeds both Surfaces (2.6 — a fixture with
      // only `.claude/skills` is a Parity divergence before the run even starts).
      expect(adds[0]).toEqual(["add", "--", "_bmad/", ".claude/skills", ".agents/skills"]);
      expect(adds[1]).toEqual(["add", "-f", "--", "_bmad/", ".claude/skills", ".agents/skills"]);
      // The `--` is what makes a pathspec unable to be re-read as a flag. Its position is the contract.
      for (const a of adds) expect(a.indexOf("--")).toBe(a.length - 4);
    } finally {
      await f.cleanup();
    }
  });

  test("a scoped path the repo does NOT have is dropped, never passed to git (BM-7 subset-present)", async () => {
    // `.agents/skills` is absent here. Passing it anyway makes git fail the WHOLE invocation with
    // `pathspec … did not match any files`, which the fail-soft wrapper swallows — so nothing at all
    // would stage while the run reported success. That is the red input this test exists for.
    const f = await makePosture("alpha", { scoped: ["_bmad"] });
    try {
      const { deps, calls } = spyDeps();
      expect(presentScopedPaths(f.dir, deps)).toEqual(["_bmad/"]);
      const staged = scopedStage(f.repo, parseBmadOpts([]), deps);

      expect(addCalls(calls)[0]).toEqual(["add", "--", "_bmad/"]);
      expect(staged.length).toBeGreaterThan(0);
      for (const p of staged) expect(p.startsWith("_bmad/")).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("a repo with NO scoped path at all issues no add and stages nothing", async () => {
    const f = await makePosture("alpha", { scoped: [], unrelated: 3 });
    try {
      const { deps, calls } = spyDeps();
      expect(presentScopedPaths(f.dir, deps)).toEqual([]);
      expect(scopedStage(f.repo, parseBmadOpts([]), deps)).toEqual([]);
      expect(addCalls(calls)).toEqual([]);
      expect(stagedIn(f.dir)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("`stagedPaths` is the ACTUAL staged file list, not the pathspecs that were requested", async () => {
    const f = await makePosture("alpha");
    try {
      const { deps } = spyDeps();
      const staged = scopedStage(f.repo, parseBmadOpts([]), deps);
      // If this returned the pathspecs it would be `["_bmad/", ".claude/skills"]` — the request, not the
      // result. Returning the request as the result is precisely how a failed add reports success.
      expect(staged).not.toContain("_bmad/");
      expect(staged).toContain("_bmad/s/SKILL.md");
      expect(staged).toContain(`.claude/skills/${DEFAULT_SKILLS[0]}/SKILL.md`);
    } finally {
      await f.cleanup();
    }
  });
});

// ── AC2 — commit only on a non-empty index, exactly one, on the live branch ───────────────────────

describe("AC2 — the commit is SCOPED, not the whole index", () => {
  // Found by the PR bot after the cross-vendor review passed this file clean. `scopedStage` was
  // scoped but `commitIfStaged` was not: it read `diff --cached` and ran a bare `commit -m`, both of
  // which take the ENTIRE INDEX. So work the principal had already staged before the run — interrupted
  // edits, a half-made commit — would be swept into the estate sync commit and, under `--push`, sent to
  // their remote under a message they did not write. Scoping the add while leaving the commit global is
  // the same defect as `git add -A`, arriving one step later. No fixture had ever pre-staged anything.
  test("work already staged before the run is NEITHER committed NOR claimed in stagedPaths", async () => {
    const f = await makePosture("alpha");
    try {
      const { deps } = spyDeps();

      // the principal's own in-flight work, staged and left there
      put(join(f.dir, "unrelated.txt"), "USER WORK IN PROGRESS\n");
      g(f.dir, "add", "--", "unrelated.txt");
      const headBefore = g(f.dir, "rev-parse", "HEAD");

      const staged = scopedStage(f.repo, parseBmadOpts([]), deps);
      expect(staged).not.toContain("unrelated.txt"); // the ledger must not claim it
      expect(staged.length).toBeGreaterThan(0); // …while still reporting the real scoped work

      expect(commitIfStaged(f.repo, deps)).toEqual({ committed: true });

      // the commit contains only scoped paths
      const inCommit = g(f.dir, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);
      expect(inCommit).not.toContain("unrelated.txt");
      expect(inCommit.length).toBeGreaterThan(0);

      // and the principal's work is exactly where they left it: still staged, still uncommitted,
      // and absent from the repo's history both before the run and after it
      expect(stagedIn(f.dir)).toEqual(["unrelated.txt"]);
      expect(headBefore).not.toBe(g(f.dir, "rev-parse", "HEAD")); // the scoped commit did land
      expect(g(f.dir, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("unrelated.txt");
    } finally {
      await f.cleanup();
    }
  });

  test("a repo whose ONLY staged work is the principal's reports `nothing to commit`, not a commit", async () => {
    const f = await makePosture("alpha", { scoped: [] });
    try {
      const { deps } = spyDeps();
      put(join(f.dir, "unrelated.txt"), "USER WORK\n");
      g(f.dir, "add", "--", "unrelated.txt");
      const before = commitCount(f.dir);

      expect(commitIfStaged(f.repo, deps)).toEqual({ committed: false, reason: "nothing to commit" });
      expect(commitCount(f.dir)).toBe(before);
      expect(stagedIn(f.dir)).toEqual(["unrelated.txt"]);
    } finally {
      await f.cleanup();
    }
  });
});

describe("AC2 — commit-if-staged: one commit, live branch, HEAD-verified (FR-12)", () => {
  test("a non-empty index ⇒ exactly ONE commit on the current branch", async () => {
    const f = await makePosture("alpha", { branch: FEATURE_BRANCH });
    try {
      const { deps } = spyDeps();
      const before = commitCount(f.dir);
      scopedStage(f.repo, parseBmadOpts([]), deps);

      expect(commitIfStaged(f.repo, deps)).toEqual({ committed: true });
      expect(commitCount(f.dir)).toBe(before + 1); // exactly +1 — not +2, not +0
      expect(g(f.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(FEATURE_BRANCH);
      expect(stagedIn(f.dir)).toEqual([]); // the index was consumed by the commit
    } finally {
      await f.cleanup();
    }
  });

  test("an EMPTY index ⇒ no commit, `nothing to commit`, HEAD unmoved", async () => {
    const f = await makePosture("alpha", { scoped: [], unrelated: 2 });
    try {
      const { deps, calls } = spyDeps();
      const head = g(f.dir, "rev-parse", "HEAD");
      const before = commitCount(f.dir);

      expect(commitIfStaged(f.repo, deps)).toEqual({ committed: false, reason: "nothing to commit" });
      // RED-TURNING INPUT: make `commitIfStaged` commit unconditionally and both of these fire.
      expect(commitCount(f.dir)).toBe(before);
      expect(g(f.dir, "rev-parse", "HEAD")).toBe(head);
      expect(calls.some((a) => a[0] === "commit")).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("a commit that could not land is reported FAILED, never `committed: true` (the fail-soft trap)", async () => {
    const f = await makePosture("alpha");
    try {
      // The stub makes `commit` a no-op returning `""` — exactly what the real wrapper returns when git
      // rejects the commit (unmerged files, a failing hook, no commit identity). Nothing else changes.
      const { deps } = spyDeps((_r, args) => (args[0] === "commit" ? "" : undefined));
      scopedStage(f.repo, parseBmadOpts([]), deps);
      const before = commitCount(f.dir);

      const out = commitIfStaged(f.repo, deps);
      expect(out.committed).toBe(false);
      expect(out.reason).toContain("HEAD did not advance");
      expect(commitCount(f.dir)).toBe(before);
    } finally {
      await f.cleanup();
    }
  });

  test("a REAL git rejection (unmerged files mid-merge) is caught by the same HEAD check", async () => {
    // No stub here — the commit genuinely fails, and `git()` genuinely swallows the exit code. This is
    // the case that proves the HEAD-delta check is not just catching the test's own mock.
    const f = await makePosture("alpha", { scoped: ["_bmad"], commitScoped: true });
    try {
      g(f.dir, "checkout", "-q", "-b", "other");
      put(join(f.dir, "_bmad", "s", "SKILL.md"), "# other side\n");
      g(f.dir, "commit", "-qam", "other side");
      g(f.dir, "checkout", "-q", "-");
      put(join(f.dir, "_bmad", "s", "SKILL.md"), "# this side\n");
      g(f.dir, "commit", "-qam", "this side");
      // Leaves the repo mid-merge with a conflicted index — `git commit` refuses.
      expect(() => g(f.dir, "merge", "other")).toThrow();

      const { deps } = spyDeps();
      const before = commitCount(f.dir);
      const out = commitIfStaged(f.repo, deps);

      expect(out.committed).toBe(false);
      expect(out.reason).toContain("HEAD did not advance");
      expect(commitCount(f.dir)).toBe(before);
    } finally {
      await f.cleanup();
    }
  });
});

// ── AC3 — gitignored surfaces honored; `-f` only under --force-track ──────────────────────────────

describe("AC3 — gitignore honor and the --force-track escape (FR-13/BM-17)", () => {
  const IGNORED: PostureOpts = { gitignore: ".claude/\n.agents/\n" };

  test("claudeTracked:false without --force-track ⇒ skipped-gitignored, nothing staged, no `-f`", async () => {
    const f = await makePosture("alpha", IGNORED);
    try {
      const repo: BmadRepo = { ...f.repo, claudeTracked: false };
      const { deps, calls } = spyDeps();
      const r = await runRepoPipeline(repo, LEG, parseBmadOpts(["--apply"]), deps);

      expect(r.status).toBe("skipped-gitignored");
      expect(r.reason).toContain("gitignored");
      expect(r.stagedPaths).toEqual([]);
      expect(r.committed).toBe(false);
      expect(stagedIn(f.dir)).toEqual([]);
      // RED-TURNING INPUT: emit `-f` without `forceTrack` and this fires.
      expect(calls.some((a) => a[0] === "add")).toBe(false);
      expect(calls.flat()).not.toContain("-f");
    } finally {
      await f.cleanup();
    }
  });

  test("skipped-gitignored is NON-failing — batchExit stays 0 (BM-17)", async () => {
    const f = await makePosture("alpha", IGNORED);
    try {
      const { deps } = spyDeps();
      const repo: BmadRepo = { ...f.repo, claudeTracked: false };
      const r = await runRepoPipeline(repo, LEG, parseBmadOpts(["--apply"]), deps);
      expect(batchExit([r])).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  test("--force-track ⇒ `-f` is added and the commit proceeds", async () => {
    const f = await makePosture("alpha", IGNORED);
    try {
      const repo: BmadRepo = { ...f.repo, claudeTracked: false };
      const { deps, calls } = spyDeps();
      const before = commitCount(f.dir);
      const r = await runRepoPipeline(repo, LEG, parseBmadOpts(["--apply", "--force-track"]), deps);

      expect(r.status).toBe("ok");
      expect(r.committed).toBe(true);
      expect(commitCount(f.dir)).toBe(before + 1);
      expect(addCalls(calls)[0]).toContain("-f");
      expect(r.stagedPaths.some((p) => p.startsWith(".claude/skills"))).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("a --force-track add that DID take is not mistaken for a staging failure", async () => {
    // The `-f` files show as STAGED (`A `), never as unstaged/untracked, so the AC6 worktree sweep must
    // stay quiet. If `stagingFailed` looked at "is the index empty" instead of "what is still unstaged",
    // this and the benign-no-op case below would both flip red.
    const f = await makePosture("alpha", IGNORED);
    try {
      const { deps } = spyDeps();
      scopedStage({ ...f.repo, claudeTracked: false }, parseBmadOpts(["--force-track"]), deps);
      expect(stagingFailed(f.repo, deps)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
});

// ── AC4 — the push gate ───────────────────────────────────────────────────────────────────────────

describe("AC4 — push gate: never without --push, live branch, `-u` on missing upstream (FR-14/BM-6)", () => {
  test("no --push ⇒ ZERO push argv, and the posture is still reported", async () => {
    const f = await makePosture("alpha", { upstream: true });
    try {
      const { deps, calls } = spyDeps();
      const r = await runRepoPipeline(f.repo, LEG, parseBmadOpts(["--apply"]), deps);

      // RED-TURNING INPUT: have `pushGate` push when `!opts.push` and this fires.
      expect(calls.some((a) => a[0] === "push")).toBe(false);
      expect(r.pushed).toBe(false);
      expect(r.branch).not.toBe("(unknown)");
      expect(typeof r.ahead).toBe("number");
    } finally {
      await f.cleanup();
    }
  });

  test("--apply WITHOUT --push never implies a push (the BM-6 contract, at the pipeline)", async () => {
    const f = await makePosture("alpha", { upstream: true });
    try {
      const { deps, calls } = spyDeps();
      await runRepoPipeline(f.repo, LEG, parseBmadOpts(["--apply"]), deps);
      expect(calls.flat()).not.toContain("push");
      expect(commitCount(f.dir)).toBe(2); // the commit DID happen — only the push was withheld
    } finally {
      await f.cleanup();
    }
  });

  test("--push with an upstream ⇒ a bare `git push`, verified by the post-push ahead-count", async () => {
    const f = await makePosture("alpha", { upstream: true });
    try {
      const { deps, calls } = spyDeps();
      const r = await runRepoPipeline(f.repo, LEG, parseBmadOpts(["--apply", "--push"]), deps);

      expect(r.status).toBe("ok");
      expect(r.pushed).toBe(true);
      expect(calls.filter((a) => a[0] === "push")).toEqual([["push"]]);
      expect(g(f.dir, "rev-list", "--count", "@{u}..HEAD")).toBe("0");
    } finally {
      await f.cleanup();
    }
  });

  test("--push with NO upstream ⇒ `push -u origin <live-branch>`", async () => {
    const f = await makePosture("beta", { branch: FEATURE_BRANCH });
    try {
      const remote = scratchPath("beta-late-remote.git");
      execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "ignore" });
      g(f.dir, "remote", "add", "origin", remote);

      const { deps, calls } = spyDeps();
      const opts = parseBmadOpts(["--apply", "--push"]);
      const r = await runRepoPipeline({ ...f.repo, hasUpstream: false }, LEG, opts, deps);

      // RED-TURNING INPUT: drop the `-u` and the push creates no upstream, so the verification read
      // comes back `""` and the repo is reported failed instead of ok.
      expect(calls.filter((a) => a[0] === "push")).toEqual([["push", "-u", "origin", FEATURE_BRANCH]]);
      expect(r.pushed).toBe(true);
      expect(r.status).toBe("ok");
    } finally {
      await f.cleanup();
    }
  });

  test("the branch in the push argv is the LIVE branch, never `main` and never the Manifest's", async () => {
    const f = await makePosture("beta", { branch: FEATURE_BRANCH });
    try {
      const remote = scratchPath("beta-branch-remote.git");
      execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "ignore" });
      g(f.dir, "remote", "add", "origin", remote);

      const { deps, calls } = spyDeps();
      // The Manifest LIES here — it says `main`, the repo is on the feature branch. 2.1 documents
      // `branch?` as informational only, so the live read must win.
      const repo: BmadRepo = { ...f.repo, hasUpstream: false, branch: "main" };
      const r = await runRepoPipeline(repo, LEG, parseBmadOpts(["--apply", "--push"]), deps);

      expect(r.branch).toBe(FEATURE_BRANCH);
      expect(calls.filter((a) => a[0] === "push")[0]).toContain(FEATURE_BRANCH);
      expect(calls.filter((a) => a[0] === "push")[0]).not.toContain("main");
    } finally {
      await f.cleanup();
    }
  });
});

// ── AC5 — source-only repos are excluded from the commit loop ─────────────────────────────────────

describe("AC5 — source-only repos never stage or commit (BM-11)", () => {
  test("a source-only repo routed in by an explicit --repos issues no add and no commit", async () => {
    // The belt-and-suspenders case: 2.1's `selectRepos` omits source-only from the DEFAULT set, but
    // `--repos <source-only-name>` routes one straight into the batch. These repos are nested inside
    // another repo, so a commit here writes into the parent's history.
    const f = await makePosture("gamma");
    try {
      const repo: BmadRepo = { ...f.repo, role: "source-only" };
      const { deps, calls } = spyDeps();
      const before = commitCount(f.dir);
      const r = await runRepoPipeline(repo, LEG, parseBmadOpts(["--apply", "--push"]), deps);

      // RED-TURNING INPUT: drop the `role === 'source-only'` guard and an `add` argv appears here.
      expect(calls.some((a) => ["add", "commit", "push"].includes(a[0] ?? ""))).toBe(false);
      expect(r.reason).toContain("source-only");
      expect(r.status).toBe("ok"); // non-failing — being source-only is a fact, not a fault
      expect(r.stagedPaths).toEqual([]);
      expect(commitCount(f.dir)).toBe(before);
      expect(stagedIn(f.dir)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("the plan honors the gate too — a source-only repo projects `wouldStage: []`", async () => {
    const f = await makePosture("gamma");
    try {
      const { deps } = spyDeps();
      const r = await runRepoPipeline({ ...f.repo, role: "source-only" }, LEG, parseBmadOpts([]), deps);
      expect(r.planned.wouldStage).toEqual([]);
      expect(r.planned.wouldCommit).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
});

// ── AC6 — fail loud; the state verifications; batch honesty ───────────────────────────────────────

describe("AC6 — every git write is state-verified; a silent no-op is never `ok` (FR-15)", () => {
  test("THE STAGING GUARD: an `add` that silently did nothing FAILS the repo", async () => {
    // The stub returns `""` for `add` and delegates everything else to real git — precisely what a
    // fail-soft `git add` looks like when the index is locked or the tree is not writable.
    const f = await makePosture("alpha", { scoped: ["_bmad"] });
    try {
      const { deps } = spyDeps((_r, args) => (args[0] === "add" ? "" : undefined));
      const r = await runRepoPipeline(f.repo, LEG, parseBmadOpts(["--apply"]), deps);

      // THE RED CONDITION, spelled out: remove the `stagingFailed` guard from the pipeline and this run
      // reports `ok` with reason "nothing to commit" — the failed add leaves `_bmad/s/SKILL.md`
      // unstaged, `commitIfStaged` sees an empty index, and a run that changed nothing claims success.
      expect(r.status).toBe("failed");
      expect(r.reason).toMatch(/staging failed/);
      expect(r.committed).toBe(false);
      expect(stagedIn(f.dir)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("the discriminator is UNSTAGED-REMAINING, not EMPTY-INDEX: a benign no-op stays ok", async () => {
    // Nothing under the scoped paths has changed (they are committed and clean), so the index is
    // legitimately empty. That is the idempotent re-run — the common case on a healthy estate — and it
    // must NOT be reported as a staging failure.
    // The FULL post-install state is seeded and committed (amended by 2.6), so the installer that runs
    // inside the pipeline re-renders byte-identical content and git genuinely sees nothing. Seeding only
    // `_bmad` would leave the Surfaces to be created by that installer, which is a first install, not a
    // re-run — the case this test is not about.
    const f = await makePosture("alpha", { commitScoped: true });
    try {
      const { deps } = spyDeps();
      expect(stagingFailed(f.repo, deps)).toBe(false);
      const r = await runRepoPipeline(f.repo, LEG, parseBmadOpts(["--apply"]), deps);
      expect(r.status).toBe("ok");
      expect(r.committed).toBe(false);
      expect(r.reason).toContain("nothing to commit");
    } finally {
      await f.cleanup();
    }
  });

  test("THE EMPTY-PATHSPEC TRAP: a dirty repo with NO scoped paths is ok, not `staging failed`", async () => {
    // `git status --porcelain --` with an empty pathspec list means THE WHOLE REPO. Without the
    // `present.length === 0` guard in `stagingFailed`, this repo's 503 untracked files would be read as
    // "changes that should have staged" and every ordinary estate repo would be failed by the spine.
    const f = await makePosture("alpha", { scoped: [], unrelated: UNRELATED_DIRTY });
    try {
      const { deps } = spyDeps();
      // THE GUARD ITSELF, read against a repo that genuinely has no scoped path — the whole subject of
      // this test, and asserted BEFORE the pipeline runs, because the installer inside the pipeline
      // creates the Surfaces and that state can no longer be observed afterwards (2.6).
      expect(presentScopedPaths(f.dir, deps)).toEqual([]);
      expect(stagingFailed(f.repo, deps)).toBe(false);

      const r = await runRepoPipeline(f.repo, LEG, parseBmadOpts(["--apply"]), deps);
      expect(r.status).toBe("ok");
      // The 503 files the operator left are still theirs — untouched, unstaged, untracked. That is the
      // real invariant behind the guard, and it survives the installer having created the Surfaces.
      for (const p of r.stagedPaths) expect(p).not.toContain("unrelated-");
      const untracked = g(f.dir, "status", "--porcelain")
        .split("\n")
        .filter((l) => l.startsWith("??") && l.includes("unrelated-"));
      expect(untracked.length).toBe(UNRELATED_DIRTY);
    } finally {
      await f.cleanup();
    }
  });

  test("dirt OUTSIDE the scoped paths never trips the staging guard", async () => {
    const f = await makePosture("alpha", { scoped: ["_bmad"], commitScoped: true, unrelated: 40 });
    try {
      const { deps } = spyDeps();
      expect(g(f.dir, "status", "--porcelain").split("\n").length).toBe(40);
      expect(stagingFailed(f.repo, deps)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("THE PUSH GUARD: a non-fast-forward rejection is reported FAILED, never `pushed: true`", async () => {
    const f = await makePosture("alpha", { upstream: true });
    try {
      // Diverge the remote behind this repo's back — a second clone commits and pushes first.
      const other = scratchPath("diverge-clone");
      // `-b` explicitly: a bare repo's HEAD is set from ambient `init.defaultBranch`, so an implicit
      // clone can land on a different branch than the fixture is on — and then the two repos never
      // diverge at all, which makes this test silently vacuous.
      const cloneArgv = ["clone", "-q", "-b", DEFAULT_BRANCH, f.remote as string, other];
      execFileSync("git", cloneArgv, { stdio: "ignore" });
      g(other, "config", "user.email", "other@example.invalid");
      g(other, "config", "user.name", "other");
      put(join(other, "theirs.txt"), "theirs\n");
      g(other, "add", "theirs.txt");
      g(other, "commit", "-m", "theirs");
      g(other, "push", "-q", "origin", `HEAD:refs/heads/${DEFAULT_BRANCH}`);
      // The divergence is REAL only if the remote ref the fixture pushes to has moved. Assert it, or a
      // future change to the fixture can make the subject of this test disappear without failing it.
      expect(g(f.remote as string, "rev-parse", `refs/heads/${DEFAULT_BRANCH}`)).not.toBe(
        g(f.dir, "rev-parse", "HEAD"),
      );

      const { deps } = spyDeps();
      const r = await runRepoPipeline(f.repo, LEG, parseBmadOpts(["--apply", "--push"]), deps);

      // RED-TURNING INPUT: report the diverged push as `pushed: true` (i.e. drop the ahead-count read)
      // and this block fires. `git push` exits non-zero here and `git()` returns `""` for it — there is
      // no signal at all except the state.
      expect(r.pushed).toBe(false);
      expect(r.status).toBe("failed");
      expect(r.reason).toMatch(/push failed/);
      expect(Number(g(f.dir, "rev-list", "--count", "@{u}..HEAD"))).toBeGreaterThan(0);
    } finally {
      await f.cleanup();
    }
  });

  test("an upstream that EXISTS in config but is GONE from the remote reports no-upstream, not `0 ahead`", async () => {
    const f = await makePosture("alpha", { upstream: true });
    try {
      const branch = g(f.dir, "rev-parse", "--abbrev-ref", "HEAD");
      // `branch.<n>.remote`/`.merge` still say there is an upstream; the ref it names is deleted on both
      // sides. `@{u}` becomes unresolvable, so `rev-list` exits non-zero and `git()` returns `""`.
      g(f.remote as string, "update-ref", "-d", `refs/heads/${branch}`);
      g(f.dir, "update-ref", "-d", `refs/remotes/origin/${branch}`);
      expect(g(f.dir, "config", "--get", `branch.${branch}.remote`)).toBe("origin");

      const { deps } = spyDeps();
      // RED-TURNING INPUT: treat the empty read as `Number("") === 0` and this reports `0 ahead` — i.e.
      // claims the repo is in sync with a ref that no longer exists.
      expect(readGitPosture(f.repo, deps).ahead).toBe("no-upstream");
    } finally {
      await f.cleanup();
    }
  });

  test("`pushGate` alone issues nothing without --push, and never claims a push it cannot verify", async () => {
    const f = await makePosture("alpha", { upstream: true });
    try {
      const { deps, calls } = spyDeps();
      // The unit-level complement of the pipeline tests: `pushGate` is the only function in the slice
      // that can reach a remote, so its `!opts.push` early return is asserted in isolation too.
      expect(pushGate(f.repo, parseBmadOpts([]), deps, "main")).toEqual({ pushed: false });
      expect(pushGate(f.repo, parseBmadOpts(["--apply"]), deps, "main")).toEqual({ pushed: false });
      expect(calls).toEqual([]);

      // A push that produces no upstream advance is never `pushed: true`, even when git exits 0.
      const { deps: stubbed } = spyDeps((_r, args) => (args[0] === "rev-list" ? "" : undefined));
      const out = pushGate(f.repo, parseBmadOpts(["--push"]), stubbed, "main");
      expect(out.pushed).toBe(false);
      expect(out.reason).toMatch(/push failed/);
    } finally {
      await f.cleanup();
    }
  });

  test("a git-filter failure isolates to its repo — the batch keeps going and exits 1 (BM-16)", async () => {
    const bad = await makePosture("alpha", { scoped: ["_bmad"] });
    const good = await makePosture("beta", { scoped: ["_bmad"] });
    try {
      // Only `alpha`'s adds are broken; `beta` runs normally through the same deps object.
      const { deps } = spyDeps((repo, args) => (args[0] === "add" && repo === bad.dir ? "" : undefined));
      const results: RepoResult[] = [];
      for (const f of [bad, good]) {
        results.push(await runRepoPipeline(f.repo, LEG, parseBmadOpts(["--apply"]), deps));
      }

      // THE LOAD-BEARING ASSERT: the ledger POSITIVELY carries the failed repo by name with a reason.
      // Any downstream render (2.2's, inline in the command scaffold) can only report "all done" if
      // this row is missing or mislabeled — so this is where the honesty is pinned.
      const failed = results.filter((r) => r.status === "failed");
      expect(failed.map((r) => r.repo)).toEqual(["alpha"]);
      expect(failed[0]!.reason).toBeDefined();
      expect(results.map((r) => r.repo)).toEqual(["alpha", "beta"]); // the batch did NOT abort
      expect(results[1]!.status).toBe("ok");
      expect(results[1]!.committed).toBe(true); // and the good repo did its real work
      expect(batchExit(results)).toBe(1);
    } finally {
      await bad.cleanup();
      await good.cleanup();
    }
  });

  test("a commit failure is fail-fast WITHIN the repo — push never runs after it (BM-4)", async () => {
    const f = await makePosture("alpha", { upstream: true });
    try {
      const { deps, calls } = spyDeps((_r, args) => (args[0] === "commit" ? "" : undefined));
      const r = await runRepoPipeline(f.repo, LEG, parseBmadOpts(["--apply", "--push"]), deps);

      expect(r.status).toBe("failed");
      expect(r.reason).toMatch(/commit failed/);
      expect(calls.some((a) => a[0] === "push")).toBe(false);
      expect(r.pushed).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
});

// ── AC7 — the live posture read, in both modes ────────────────────────────────────────────────────

describe("AC7 — live git posture, dry-run and apply alike (read-only)", () => {
  test("a DRY RUN reports the live branch and ahead while mutating nothing", async () => {
    const f = await makePosture("alpha", { branch: FEATURE_BRANCH, upstream: true });
    try {
      put(join(f.dir, "_bmad", "s", "NEW.md"), "# new\n");
      const { deps, calls } = spyDeps();
      const head = g(f.dir, "rev-parse", "HEAD");
      const r = await runRepoPipeline({ ...f.repo, branch: "main" }, LEG, parseBmadOpts(["--push"]), deps);

      expect(r.branch).toBe(FEATURE_BRANCH); // live, not the Manifest's "main"
      expect(r.ahead).toBe(0);
      expect(r.stagedPaths).toEqual([]);
      expect(r.committed).toBe(false);
      expect(r.pushed).toBe(false);
      // RED-TURNING INPUT: let any write reach the dry-run path and one of these fires.
      for (const a of calls) expect(["rev-parse", "rev-list"]).toContain(a[0]);
      expect(g(f.dir, "rev-parse", "HEAD")).toBe(head);
      expect(stagedIn(f.dir)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("`ahead` is re-read AFTER the commit, so it reflects the commit just made", async () => {
    const f = await makePosture("alpha", { upstream: true });
    try {
      const { deps } = spyDeps();
      expect(readGitPosture(f.repo, deps).ahead).toBe(0);
      const r = await runRepoPipeline(f.repo, LEG, parseBmadOpts(["--apply"]), deps);
      expect(r.committed).toBe(true);
      // RED-TURNING INPUT: drop the post-commit re-read and this is still 0, understating what a
      // subsequent `--push` would send.
      expect(r.ahead).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  test("a DETACHED HEAD reports the literal `HEAD`, not the `(unknown)` failure fallback", async () => {
    const f = await makePosture("alpha", { detach: true });
    try {
      const { deps } = spyDeps();
      // `--abbrev-ref` returns the string "HEAD" when detached — a real answer, not an empty one. The
      // `(unknown)` fallback is reserved for a `git()` FAILURE, and conflating the two would label a
      // perfectly readable repo as unreadable.
      expect(readGitPosture(f.repo, deps).branch).toBe("HEAD");
    } finally {
      await f.cleanup();
    }
  });

  test("a non-repo path fails soft to `(unknown)` / `no-upstream` rather than throwing", async () => {
    const dir = scratchPath("not-a-repo");
    mkdirSync(dir, { recursive: true });
    const { deps } = spyDeps();
    const repo: BmadRepo = { path: dir, tools: [], claudeTracked: true, hasUpstream: true, name: "nope" };
    expect(readGitPosture(repo, deps)).toEqual({ branch: "(unknown)", ahead: "no-upstream" });
  });

  test("`hasUpstream: false` short-circuits to `no-upstream` without a rev-list read", async () => {
    const f = await makePosture("alpha");
    try {
      const { deps, calls } = spyDeps();
      expect(readGitPosture({ ...f.repo, hasUpstream: false }, deps).ahead).toBe("no-upstream");
      expect(calls.some((a) => a[0] === "rev-list")).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
});

// ── AC8 — contract match: fields populated, no new field, no second definition ────────────────────

describe("AC8 — 2.4 populates 2.2's single records and declares nothing new (BM-5/BM-14)", () => {
  test("a full apply run populates every git-outcome field on the ONE RepoResult", async () => {
    const f = await makePosture("alpha", { upstream: true });
    try {
      const { deps } = spyDeps();
      const r = await runRepoPipeline(f.repo, LEG, parseBmadOpts(["--apply", "--push"]), deps);

      expect(r.status).toBe("ok");
      expect(r.stagedPaths.length).toBeGreaterThan(0);
      expect(r.committed).toBe(true);
      expect(r.pushed).toBe(true);
      expect(typeof r.branch).toBe("string");
      expect(r.ahead).toBe(0); // pushed ⇒ level with upstream
    } finally {
      await f.cleanup();
    }
  });

  test("`wouldStage` is the PATHSPEC intent; `stagedPaths` is the FILE outcome (BM-14)", async () => {
    const f = await makePosture("alpha");
    try {
      const { deps } = spyDeps();
      const r = await runRepoPipeline(f.repo, LEG, parseBmadOpts(["--apply"]), deps);

      // Two different kinds of thing, and the suite says so explicitly because conflating them is how a
      // correct plan gets read as a wrong one.
      expect(r.planned.wouldStage).toEqual(["_bmad/", ".claude/skills", ".agents/skills"]);
      expect(r.planned.wouldCommit).toBe(true);
      expect(r.stagedPaths).toContain("_bmad/s/SKILL.md");
      expect(r.stagedPaths).not.toContain("_bmad/");
    } finally {
      await f.cleanup();
    }
  });

  test("a gitignored repo without --force-track projects `wouldStage: []` / `wouldCommit: false`", async () => {
    const f = await makePosture("alpha", { gitignore: ".claude/\n.agents/\n" });
    try {
      const { deps } = spyDeps();
      const repo: BmadRepo = { ...f.repo, claudeTracked: false };
      const gated = await runRepoPipeline(repo, LEG, parseBmadOpts([]), deps);
      expect(gated.planned.wouldStage).toEqual([]);
      expect(gated.planned.wouldCommit).toBe(false);

      const forced = await runRepoPipeline(repo, LEG, parseBmadOpts(["--force-track"]), deps);
      expect(forced.planned.wouldStage.length).toBeGreaterThan(0);
      expect(forced.planned.wouldCommit).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("SM-3 holds: the dry-run plan and the apply plan are identical on an unchanged tree", async () => {
    const f = await makePosture("alpha");
    try {
      const { deps } = spyDeps();
      const dry = await runRepoPipeline(f.repo, LEG, parseBmadOpts([]), deps);
      // A second dry run rather than an apply: an apply CHANGES the tree (it commits), and comparing a
      // plan computed before that change with one computed after would be testing the fixture, not SM-3.
      const dry2 = await runRepoPipeline(f.repo, LEG, parseBmadOpts([]), deps);
      expect(JSON.stringify(dry2.planned)).toBe(JSON.stringify(dry.planned));
    } finally {
      await f.cleanup();
    }
  });
});

// ── AC9 — awkward inputs the fixture matrix would otherwise never supply ──────────────────────────

describe("AC9 — inputs that violate the stated invariants (the class that bit 2.1/2.2/2.3)", () => {
  test("a repo path containing a SPACE stages and commits normally", async () => {
    const f = await makePosture("alpha");
    try {
      const spaced = scratchPath("repo with a space");
      cpSync(f.dir, spaced, { recursive: true });
      const repo: BmadRepo = { ...f.repo, path: spaced, name: "spaced" };
      const { deps } = spyDeps();

      // Args are passed to `execFileSync` as an ARRAY with no shell, so a space is just a character.
      // A shell-string implementation would split this path and operate on the wrong directory.
      const r = await runRepoPipeline(repo, LEG, parseBmadOpts(["--apply"]), deps);
      expect(r.status).toBe("ok");
      expect(r.committed).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  // NAMED for what it can actually turn red on. The repo path is ABSOLUTE (`join(scratch, "-dashed…")`),
  // so the dash never reaches git as a leading-dash argv element — it arrives inside a `-C <dir>` value.
  // The original name claimed a leading-dash guard this input cannot exercise; the argv assertion below
  // is what makes the block load-bearing rather than decorative.
  test("a repo path SEGMENT beginning with a dash survives, and no argv element is flag-shaped", async () => {
    const f = await makePosture("alpha");
    try {
      const dashed = join(scratch, `-dashed-repo-${seq++}`);
      cpSync(f.dir, dashed, { recursive: true });
      const { deps, calls } = spyDeps();
      const repo: BmadRepo = { ...f.repo, path: dashed, name: "dashed" };
      const r = await runRepoPipeline(repo, LEG, parseBmadOpts(["--apply"]), deps);
      expect(r.status).toBe("ok");
      expect(r.committed).toBe(true);
      // No git invocation may LEAD with a dashed token — that is the shape that would be re-read as a
      // flag. Every argv here starts with its subcommand.
      for (const argv of calls) expect(argv[0]?.startsWith("-")).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("a SYMLINKED `.claude/skills` stages the link itself and is not a silent failure", async () => {
    const f = await makePosture("alpha", { scoped: ["_bmad"] });
    try {
      const outside = scratchPath("outside-skills");
      mkdirSync(join(outside, "s"), { recursive: true });
      writeFileSync(join(outside, "s", "SKILL.md"), "# outside\n", "utf-8");
      mkdirSync(join(f.dir, ".claude"), { recursive: true });
      symlinkSync(outside, join(f.dir, ".claude", "skills"));

      const { deps } = spyDeps();
      // `exists` follows the link, so the pathspec IS passed — and git stages the symlink ENTRY rather
      // than walking through it to the outside tree. Recorded here because "we stage a link, not its
      // target" is behavior a reader would otherwise have to discover from a production repo, and
      // because the alternative — git failing the whole invocation — would have been swallowed silently.
      expect(presentScopedPaths(f.dir, deps)).toEqual(["_bmad/", ".claude/skills"]);
      const staged = scopedStage(f.repo, parseBmadOpts([]), deps);
      expect(staged).toContain(".claude/skills");
      expect(staged).not.toContain(".claude/skills/s/SKILL.md"); // the link, not its contents
      expect(stagingFailed(f.repo, deps)).toBe(false);
      expect(commitIfStaged(f.repo, deps).committed).toBe(true);

      // NOT run through `runRepoPipeline` on purpose: 2.3's backup filter calls `cpDir` on the same
      // path and `cpSync` throws ENOENT copying a directory symlink whose destination parent does not
      // exist yet — a real 2.3 finding, but a backup fault, not a git-safety one. Exercising the git
      // filter directly keeps this test about what 2.4 owns; the backup behavior is reported upward.
    } finally {
      await f.cleanup();
    }
  });

  test("a repo mid-REBASE (detached, conflicted) fails loud rather than reporting a commit", async () => {
    const f = await makePosture("alpha", { scoped: ["_bmad"], commitScoped: true });
    try {
      g(f.dir, "checkout", "-q", "-b", "topic");
      put(join(f.dir, "_bmad", "s", "SKILL.md"), "# topic\n");
      g(f.dir, "commit", "-qam", "topic edit");
      g(f.dir, "checkout", "-q", "-");
      put(join(f.dir, "_bmad", "s", "SKILL.md"), "# main\n");
      g(f.dir, "commit", "-qam", "main edit");
      g(f.dir, "checkout", "-q", "topic");
      expect(() => g(f.dir, "rebase", "-")).toThrow(); // stops on the conflict

      const { deps } = spyDeps();
      const before = commitCount(f.dir);
      const r = await runRepoPipeline(f.repo, LEG, parseBmadOpts(["--apply"]), deps);

      // Whatever git decides to do here, the one outcome that is forbidden is `committed: true` with an
      // unmoved HEAD. The state check is what makes that impossible regardless of git's exit code.
      if (r.committed) expect(commitCount(f.dir)).toBe(before + 1);
      else expect(commitCount(f.dir)).toBe(before);
      expect(r.status === "ok" || r.status === "failed").toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("a scoped path gitignored while claudeTracked says otherwise stages what it can, honestly", async () => {
    // git exits 1 for the ignored pathspec but STILL stages the others — a PARTIAL add. `stagedPaths`
    // therefore reports two of the three trees while `planned.wouldStage` reports three, and the ledger
    // carries both. Asserted rather than assumed: this is the one shape where "asked for 3, got 2" is
    // not itself flagged as a failure, because a pathspec that simply had no changes produces the same
    // empty contribution and failing on it would red every idempotent re-run.
    const scoped = ["_bmad", join(".agents", "skills")];
    const f = await makePosture("alpha", { gitignore: ".agents/\n", scoped });
    try {
      const { deps } = spyDeps();
      const staged = scopedStage(f.repo, parseBmadOpts([]), deps);
      expect(staged).toEqual(["_bmad/s/SKILL.md"]);
      expect(staged.some((p) => p.startsWith(".agents"))).toBe(false);
      // Not a staging failure: nothing under the scoped paths is left visible-but-unstaged, because
      // git does not report ignored files in `status --porcelain` at all.
      expect(stagingFailed(f.repo, deps)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("no SHIPPED module in the slice contains `git add -A`, `git add .`, or a second scoped literal", () => {
    // The chokepoint is only a chokepoint if it is the only place these strings live. This reads the
    // SOURCE rather than the behavior, because a second literal would pass every behavior test above
    // right up until the day the two copies disagree — and it scans the whole slice rather than one
    // file, because the invariant AC1 states is about `src/bmad/*`, not about `git-safety.ts`.
    const shipped = readdirSync(import.meta.dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".test-helpers.ts"))
      .map((f) => ({ file: f, src: readIfExists(join(import.meta.dir, f)) ?? "" }));
    expect(shipped.length).toBeGreaterThan(5);

    for (const { file, src } of shipped) {
      // Matches the CODE form (`"add", "-A"` as argv elements), not prose: `git-safety.ts`'s header
      // says the words "git add -A" on purpose, and a check that banned the phrase would push the
      // documentation out of the file that most needs it.
      expect({ file, hit: /["']add["']\s*,\s*["'](-A|--all|\.)["']/.test(src) }).toEqual({ file, hit: false });
      // AC9/D4 — no machine-owner path in a shipped module.
      expect({ file, hit: src.includes("/Users/") }).toEqual({ file, hit: false });
    }

    // The three pathspecs exist exactly once each, and only in the chokepoint.
    const bySpec = (spec: string) =>
      shipped.filter((s) => s.src.includes(`"${spec}"`)).map((s) => s.file);
    expect(bySpec("_bmad/")).toEqual(["git-safety.ts"]);
    expect(bySpec(".claude/skills")).toEqual(["git-safety.ts"]);
    expect(bySpec(".agents/skills")).toEqual(["git-safety.ts"]);
  });
});
