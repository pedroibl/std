// Fixture support for the `src/bmad/` dual-surface proof suite (Story 1.2, BM-9). This is the FIRST
// file under `src/bmad/` — the slice's shipped surface (the `install`/`verify`/`deploy` command family)
// is all Epic A; here only a test + this helper land. Mirrors `src/cli/edge-deploy.test-helpers.ts`'s
// role: a not-shipped fixture module that happens to need a home. NEVER exported from any `index.ts`,
// and there is no `src/bmad/index.ts` this story (no speculative surface — Rule-of-Three).
//
// IDENTITY-FREE (D4/NFR3, the identity trap the live 1-5 gate enforces): this file is `*.test-helpers.ts`,
// NOT `*.test.ts`, so the no-consumer-ids / dep-root / single-source gates DO scan it. It therefore bakes
// in NO consumer path: the `bmad` binary resolves from `$BMAD_BIN`/PATH (BM-3), the estate module resolves
// relative to the package root via `import.meta.dir`/`$BMAD_ESTATE_DIR` (BM-13), and scratch repos live
// under `os.tmpdir()`. No `/Users/...` literal appears here.
//
// std reuse (build less): `spawnCapture` from `src/proc` is the one subprocess primitive — never-reject,
// never-hang, `{stdout,stderr,code}`, missing binary → 127. `git init` shells through it (BM-9).

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnCapture } from "../proc/index";
import { type BmadRepo, DEFAULT_TOOLS } from "./manifest";

/** A disposable `git init`-ed scratch repo in a temp dir. `cleanup()` `rm -rf`s it (call it in `finally`). */
export interface ScratchRepo {
  /** Absolute path to the fresh temp repo. */
  readonly dir: string;
  /** Recursively removes `dir`. Idempotent; safe if the dir is already gone. */
  cleanup(): Promise<void>;
}

/**
 * Make a fresh temp dir under `os.tmpdir()` and `git init` it via `spawnCapture` (BM-9's disposable
 * `git init` — no committed fixture tree). Returns the dir and a `cleanup()`. On a `git init` failure the
 * partial dir is removed and the error is thrown loud (with `git`'s stderr) rather than leaking a temp dir.
 */
export async function makeScratchRepo(): Promise<ScratchRepo> {
  const dir = await mkdtemp(join(tmpdir(), "bmad-scratch-"));
  const init = await spawnCapture("git", ["init", dir]);
  if (init.code !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`git init failed (code ${init.code}) in ${dir}: ${init.stderr.trim()}`);
  }
  // THE choke point: every fixture repo in this slice is born here, so persisting the identity once
  // covers 2.4's postures, 2.5's live fixtures and 2.7's harness alike. Required because the PRODUCT
  // code commits through `src/git` with no `-c` overrides — see `persistFixtureIdentity`.
  persistFixtureIdentity(dir);
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The git subcommands that MUTATE something — a repo's index, its history, or a remote (Story 2.4).
 *
 * This list is the instrument behind every "no git write happened here" assertion in the suite, and it
 * is deliberately a DENY-list of writers rather than an allow-list of readers: a reader this file has
 * not heard of is harmless, while a writer it has not heard of must never be waved through by default.
 */
export const GIT_WRITE_SUBCOMMANDS: readonly string[] = [
  "add",
  "commit",
  "push",
  "rm",
  "mv",
  "reset",
  "checkout",
  "switch",
  "restore",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "stash",
  "clean",
  "fetch",
  "pull",
  "tag",
  "branch",
  "apply",
  "am",
  "update-ref",
  "config",
  "init",
  "clone",
  "gc",
  "worktree",
  "remote",
  "submodule",
  "notes",
  "replace",
];

/**
 * A `deps.git` fake that permits READS and explodes by name on any WRITE.
 *
 * THE DISTINCTION IS THE WHOLE POINT (Story 2.4/AC7). Before 2.4 the dry-run and installer suites made
 * `deps.git` throw outright, which read as "the pipeline touches no git". That is the wrong invariant:
 * the live posture read (`rev-parse`/`rev-list`) is side-effect-free and MUST run in dry-run, or a
 * preview reports a stale branch for the repo it is about to change. What must never happen in a dry
 * run — or in 2.3's installer filter — is a git WRITE, and that is what this fake pins.
 *
 * `read` supplies the stdout for permitted reads; the default `""` matches `src/git`'s own fail-soft
 * return for a path that is not a repo, which is exactly what those suites' temp dirs are.
 */
export function readOnlyGit(
  label: string,
  read: (repo: string, args: string[]) => string = () => "",
): (repo: string, args: string[]) => string {
  return (repo, args) => {
    const sub = args[0] ?? "";
    if (GIT_WRITE_SUBCOMMANDS.includes(sub)) {
      throw new Error(`git WRITE in ${label}: \`git ${args.join(" ")}\` — reads only here`);
    }
    return read(repo, args);
  };
}

/** How a synthetic estate module should be built. Every field is optional; the defaults are a valid module. */
export interface EstateSpec {
  /** Skill dirs created WITH a file — the shape the FR-6 guard must accept. */
  skills?: string[];
  /**
   * Skill dirs created EMPTY. A present-but-empty skill is a half-family wearing a directory: it sails
   * past an exists-only guard and installs nothing. Fixtures must be able to produce it, or the case
   * cannot be tested at all — which is how that hole survives review.
   */
  emptySkills?: string[];
  /** Replaces the `.claude-plugin/marketplace.json` body. A `null` writes NO marketplace file. */
  marketplace?: unknown;
}

/**
 * Build a throwaway `bmad-estate`-shaped module under `os.tmpdir()` and return its path — the value a
 * test injects as `deps.estateModulePath` (BM-13). Never the real shipped `bmad-estate/`: a unit test
 * that reads the package's own payload would pass or fail on whatever that payload happens to contain.
 *
 * The caller owns cleanup ({@link removeTempTree}).
 */
export function makeEstateModule(spec: EstateSpec = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "bmad-estate-"));
  const skills = spec.skills ?? ["bmad-agent-jhon-the-loop", "bmad-agent-epic-the-loop"];

  for (const skill of skills) {
    const skillDir = join(dir, "skills", skill);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `# ${skill}\n`, "utf-8");
  }
  for (const skill of spec.emptySkills ?? []) {
    mkdirSync(join(dir, "skills", skill), { recursive: true });
  }

  const marketplace =
    spec.marketplace === undefined
      ? {
          name: "estate-fixture",
          plugins: [{ name: "estate-fixture", source: "./", skills: skills.map((s) => `./skills/${s}`) }],
        }
      : spec.marketplace;
  if (marketplace !== null) {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    const body = typeof marketplace === "string" ? marketplace : JSON.stringify(marketplace, null, 2);
    writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), body, "utf-8");
  }
  return dir;
}

/**
 * Bring a repo to the state a SUCCESSFUL `bmad install` leaves it in: both Surfaces rendered from
 * `moduleRoot`, byte-identical to each other and to the module source (Story 2.6).
 *
 * EVERY SUITE THAT DRIVES THE APPLY PIPELINE NEEDS THIS, and the reason is the whole point of Story 2.6.
 * Since 2.6 the pipeline VERIFIES the post-install state, so an installer fake that exits 0 while writing
 * nothing describes a run that cannot happen on a real machine — and the verify filter fails it, exactly
 * as it should. Before 2.6 that fake was harmless because verify was a no-op stub; it is not harmless now.
 *
 * Deliberately a plain `cpSync`, not a call through any `BmadDeps.fs` seam: this stands in for the
 * EXTERNAL installer's writes, and routing them through the seam would make a suite's write-spy report
 * `bmad-manager` as having copied into the repo — the exact self-copy claim `install.test.ts` asserts is
 * false (FR-8: the installer does all of it).
 */
export function renderInstalledSurfaces(
  repoRoot: string,
  moduleRoot: string,
  skills: readonly string[] = listSkillDirs(moduleRoot),
): void {
  for (const surface of [join(".claude", "skills"), join(".agents", "skills")]) {
    for (const skill of skills) {
      const src = join(moduleRoot, "skills", skill);
      if (!existsSync(src)) continue;
      cpSync(src, join(repoRoot, surface, skill), { recursive: true });
    }
  }
}

/**
 * The skill directory names a module (or a materialized staging source) holds. Fail-soft `[]`.
 *
 * Defaulting {@link renderInstalledSurfaces} to this is what lets a harness point the fake installer at
 * the run's `--custom-source` staging dir and get exactly the skills that run SELECTED — the same set a
 * real `bmad install` would render, rather than everything the estate happens to ship.
 */
export function listSkillDirs(moduleRoot: string): string[] {
  try {
    return readdirSync(join(moduleRoot, "skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** `rm -rf` a temp tree. Idempotent and never throws — safe in an `afterAll` that may run twice. */
export function removeTempTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Resolve the `bmad-estate/` payload dir (the module this proof installs), NEVER as a baked absolute
 * (BM-13, D4). `$BMAD_ESTATE_DIR` wins when set; otherwise it is the package root's `bmad-estate/`,
 * reached relative to this file (`src/bmad/` → up two → repo root → `bmad-estate`).
 */
export function resolveEstateModule(): string {
  const override = process.env.BMAD_ESTATE_DIR;
  if (override && override.length > 0) return override;
  return join(import.meta.dir, "..", "..", "bmad-estate");
}

// ── the six-posture git fixture harness (Story 2.7, BM-9 — AC5/AC6/AC11) ─────────────────────────────
//
// BM-9 `[ADOPTED]` supersedes the epic's and 2.4's "`fixtures/` harness" / "real-repo harness" wording:
// there is NO committed fixture directory and NO real repo. Every posture below is a disposable
// `git init` scratch repo under `os.tmpdir()`, built programmatically and `rm -rf`'d by its `cleanup()`.
//
// IDENTITY-FREE (D4 — `check:no-consumer-ids` scans this file; the `.endsWith(".test.ts")` fence in all
// three gate scripts does NOT skip a `*.test-helpers.ts`). Repo names are `alpha`/`beta`/…, the commit
// identity uses the RFC-2606 reserved `.invalid` TLD, and no consumer path appears anywhere.

/**
 * The fixture commit identity, as `git -c` overrides — the ONE place a `user.email` appears in
 * `src/bmad/` (AC11), and the reason {@link fixtureGit} exists at all.
 *
 * ⚠ INJECTED UNCONDITIONALLY, AND THAT IS NOT DEFENSIVE PADDING. `makeScratchRepo` does `git init` and
 * nothing else — no commit, no identity. A bare `git commit` in such a repo SUCCEEDS on a developer
 * machine that has a global `user.email` and FAILS in a bare CI container, which is why "add the
 * identity if the commit fails" is exactly the wrong shape: the failure is invisible where it is
 * written and only appears where nobody is watching. Verified 2026-08-02 on this machine — a global
 * identity is present, so the omission would have been silent here.
 *
 * `commit.gpgsign=false` survives a machine whose global config signs every commit (no key in CI ⇒ every
 * fixture commit fails). Passed as `-c` FLAGS so one runner carries them to every invocation, including
 * those made against a repo this file did not create.
 *
 * ⚠ `-c` FLAGS ARE PER-INVOCATION AND DO NOT PERSIST — which is why {@link persistFixtureIdentity}
 * exists and must be called on every repo the PRODUCT code will commit in. Caught by CI on PR #69 after
 * passing three local reviews: this file's `-c` flags cover the calls the HARNESS makes, but the code
 * under test commits through `src/git`, which carries no `-c` and therefore falls back to the global
 * config — present on a developer machine, absent in a bare CI container. 21 tests failed there and zero
 * failed here. The identity must be written INTO each repo's own config, not merely passed alongside the
 * harness's calls. (Story 2.4 had this right incidentally, via three `git config` writes; consolidating
 * them onto `-c` flags for AC11 dropped the persistence they were providing.)
 */
export const FIXTURE_IDENTITY: readonly string[] = [
  "-c",
  "user.email=bmad-fixture@example.invalid",
  "-c",
  "user.name=bmad fixture",
  "-c",
  "commit.gpgsign=false",
];

/**
 * Write {@link FIXTURE_IDENTITY} into a repo's own `.git/config` so it survives for git processes this
 * harness does not launch — specifically the PRODUCT code under test, which commits via `src/git` with
 * no `-c` overrides of its own.
 *
 * The key/value pairs are DERIVED from `FIXTURE_IDENTITY` rather than restated, so `user.email` still
 * appears exactly once in `src/bmad/` (AC11's gate) and the two mechanisms cannot drift apart.
 */
export function persistFixtureIdentity(dir: string): void {
  // FIXTURE_IDENTITY is a flat ["-c", "k=v", "-c", "k=v", …] argv; take every value slot and split once
  // on "=" so a value containing "=" would survive.
  for (let i = 1; i < FIXTURE_IDENTITY.length; i += 2) {
    const pair = FIXTURE_IDENTITY[i] as string;
    const eq = pair.indexOf("=");
    execFileSync("git", ["-C", dir, "config", pair.slice(0, eq), pair.slice(eq + 1)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

/**
 * THE ONE GIT RUNNER FOR FIXTURE CONSTRUCTION — carries {@link FIXTURE_IDENTITY} and THROWS on failure.
 *
 * Deliberately the inverse of `src/git`'s fail-soft wrapper. Fixture setup that silently half-worked
 * produces a test that passes for the wrong reason, which is the one failure mode a suite about silent
 * failure cannot afford. Every git call this harness makes goes through here, so there is exactly one
 * place the identity can go missing from.
 *
 * SYNCHRONOUS (`execFileSync`), deviating from the `spawnCapture` the story sketched. `git-safety.test.ts`
 * drives ~200 sync fixture git calls through its own `g()`, and a second, async runner alongside this one
 * would be precisely the shared-file fork AC11 exists to prevent — so `g()` delegates here instead.
 * `makeScratchRepo`'s own `git init` still goes through `spawnCapture` and is untouched.
 */
export function fixtureGit(dir: string, ...args: string[]): string {
  const stdio: ("ignore" | "pipe")[] = ["ignore", "pipe", "pipe"];
  return execFileSync("git", ["-C", dir, ...FIXTURE_IDENTITY, ...args], {
    encoding: "utf-8",
    stdio,
  }).trim();
}

/** The six real estate postures the Epic-A slice must survive (AC6). Length is asserted: **6**. */
export type FixturePosture =
  | "tracked"
  | "gitignored"
  | "no-upstream"
  | "dirty"
  | "feature-branch"
  | "source-only";

/**
 * Every posture, in the order {@link makeFixtureEstate} builds them. Exported so a caller cannot drift
 * from AC6's table by hand-listing five of six — `ALL_POSTURES.length === 6` is asserted downstream.
 */
export const ALL_POSTURES = [
  "tracked",
  "gitignored",
  "no-upstream",
  "dirty",
  "feature-branch",
  "source-only",
] as const satisfies readonly FixturePosture[];

/** The branch every fixture is normalised onto before its seed commit. */
export const FIXTURE_BRANCH = "main";

/** The live branch the `feature-branch` posture checks out — a repo whose HEAD is NOT `main` (FR-14). */
export const FIXTURE_FEATURE_BRANCH = "feature/product-development-mkt";

/** The unrelated-dirty-file count of the real estate's dirtiest repo (PRD FR-11) — the FR-11 fixture size. */
export const FIXTURE_DIRTY_COUNT = 503;

/**
 * How a fixture is wired to a remote. THIS IS A SEPARATE AXIS FROM THE POSTURE, and conflating the two
 * is a trap this harness closes by construction:
 *
 *   - `"none"`     — no remote at all. `git push -u origin <branch>` FAILS, so `pushGate` reports
 *                    `{pushed:false, reason:"push failed…"}`. A useful fixture, but a test that meant to
 *                    exercise FR-14's `push -u` SUCCESS path against it is silently asserting a failure
 *                    path instead — green for the wrong reason.
 *   - `"attached"` — a bare remote exists as `origin`, but no upstream tracking ref is set. This is what
 *                    "no-upstream" actually MEANS to the code under test: `readGitPosture` reads `@{u}`,
 *                    not `remote`. It is therefore the DEFAULT for the `no-upstream` posture.
 *   - `"tracking"` — bare remote plus `push -u`, so `@{u}` resolves and `hasUpstream:true` is true ON
 *                    DISK rather than only in the Manifest entry.
 */
export type FixtureRemote = "none" | "attached" | "tracking";

/** Knobs for {@link makeFixtureRepo}. Every one has a posture-appropriate default. */
export interface FixtureRepoOpts {
  /** The `--repos` match key. Defaults to the posture name. Never a real repo's name (D4). */
  name?: string;
  /** Unrelated dirty files for the `dirty` posture. Defaults to {@link FIXTURE_DIRTY_COUNT}. */
  dirtyCount?: number;
  /** Override the posture's default remote wiring — see {@link FixtureRemote}. */
  remote?: FixtureRemote;
  /** The module whose skills are byte-copied into both Surfaces. Defaults to {@link resolveEstateModule}. */
  moduleRoot?: string;
  /** Which skills to render. Defaults to every skill dir `moduleRoot` holds. */
  skills?: readonly string[];
  /**
   * Built-in module dirs to seed under `_bmad/`. Defaults to `["core"]`.
   *
   * ⚠ THIS IS AN INPUT THE ESTATE MUST BE ABLE TO VARY, not a constant. The update rule PROBES which
   * built-ins are present on each repo's disk and names exactly that set in the argv it shells, because
   * the installer treats the named set as the set that should EXIST — naming fewer modules than a repo
   * carries DELETES the rest. A harness that seeded the same built-ins into every fixture could not
   * distinguish a correct per-repo probe from a hardcoded set that happens to match, which is precisely
   * how a delegation regression would slip through unseen.
   */
  builtins?: readonly string[];
}

/** A built posture: the scratch repo, the Manifest entry describing it, and its live branch. */
export interface FixtureRepo extends ScratchRepo {
  readonly posture: FixturePosture;
  /** The `BmadRepo` entry describing this fixture — feed straight into a synthetic manifest. */
  readonly entry: BmadRepo;
  /** The live branch after construction. */
  readonly branch: string;
  /** The bare remote's path, when one was created. */
  readonly remote?: string;
}

/** The remote wiring each posture gets when the caller does not override it. */
const DEFAULT_REMOTE: Record<FixturePosture, FixtureRemote> = {
  tracked: "tracking",
  gitignored: "tracking",
  dirty: "tracking",
  // A remote, deliberately WITHOUT `push -u` — see `FixtureRemote`. Building this one with no remote at
  // all is the trap: FR-14's `push -u origin <branch>` would then fail for a reason the test never meant.
  "no-upstream": "attached",
  "feature-branch": "attached",
  "source-only": "none",
};

/**
 * Build ONE posture on a disposable scratch repo (AC5/AC6/BM-9).
 *
 * THE STEP ORDER IS LOAD-BEARING and each step is here for a measured reason:
 *
 *  1. NORMALISE THE BRANCH before anything is committed. `git init` yields `main` on this machine and
 *     `master` on an older or unconfigured git; asserting a branch name without normalising is a
 *     CI-only failure that never reproduces locally.
 *  2. WRITE `.gitignore` BEFORE THE SEED COMMIT for the gitignored posture. ⚠ Measured both ways: with
 *     the ignore written AFTER the seed commit, `.claude/skills` is already TRACKED, `git check-ignore`
 *     reports NOT ignored, and a scoped `git add .claude/skills` STAGES it — so the entry's
 *     `claudeTracked:false` becomes a lie the fixture itself cannot detect, and every assertion resting
 *     on it is green against a repo that is not actually gitignored. Written first, `check-ignore`
 *     reports ignored, a scoped add stages nothing, and the dirs are still present on disk (which the
 *     verification `diff` needs).
 *  3. RENDER BOTH SURFACES from `moduleRoot`. Without this the hermetic layer is unbuildable: with no
 *     real installer run, `<repo>/.claude/skills/<s>` is absent and the verification filter emits an
 *     error finding per selected skill per repo, so EVERY repo reports `failed` and no case needing an
 *     `ok` repo can be satisfied. Copying from the module (rather than synthesising content) is also
 *     what makes the Faithfulness comparison clean — it compares a tree against its own copy.
 *  4. SEED `_bmad/core` so the update rule's on-disk built-in probe finds a built-in and emits BOTH of
 *     its invocations. A fixture without it silently halves the invocation count.
 */
export async function makeFixtureRepo(
  posture: FixturePosture,
  opts: FixtureRepoOpts = {},
): Promise<FixtureRepo> {
  const s = await makeScratchRepo();
  const name = opts.name ?? posture;
  const moduleRoot = opts.moduleRoot ?? resolveEstateModule();
  const skills = opts.skills ?? listSkillDirs(moduleRoot);
  const remoteKind = opts.remote ?? DEFAULT_REMOTE[posture];

  // 1. branch normalisation — BEFORE the first commit, so the seed lands on a known ref.
  fixtureGit(s.dir, "symbolic-ref", "HEAD", `refs/heads/${FIXTURE_BRANCH}`);

  // 2. the ignore, FIRST, for the one posture that needs it (see the ⚠ above).
  if (posture === "gitignored") {
    writeFixtureFile(join(s.dir, ".gitignore"), ".claude/\n.agents/\n");
  }

  // 3. + 4. the seed working tree.
  writeFixtureFile(join(s.dir, "README.md"), `# ${name}\n`);
  for (const m of opts.builtins ?? ["core"]) writeFixtureFile(join(s.dir, "_bmad", m, ".keep"), "");
  renderInstalledSurfaces(s.dir, moduleRoot, skills);

  // `add -A` is legal HERE and nowhere in the shipped slice: this is fixture CONSTRUCTION, not the
  // product's staging path. FR-11's never-`git add -A` chokepoint governs `src/bmad/git-safety.ts`.
  fixtureGit(s.dir, "add", "-A");
  fixtureGit(s.dir, "commit", "-m", "seed");

  let branch = FIXTURE_BRANCH;
  if (posture === "feature-branch") {
    fixtureGit(s.dir, "checkout", "-q", "-b", FIXTURE_FEATURE_BRANCH);
    branch = FIXTURE_FEATURE_BRANCH;
  }

  if (posture === "dirty") seedDirty(s.dir, opts.dirtyCount ?? FIXTURE_DIRTY_COUNT, skills);

  let remote: string | undefined;
  if (remoteKind !== "none") {
    remote = mkdtempSync(join(tmpdir(), "bmad-remote-"));
    execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "ignore" });
    fixtureGit(s.dir, "remote", "add", "origin", remote);
    // `tracking` is what makes `hasUpstream:true` true ON DISK. A Manifest that claims an upstream the
    // repo lacks makes the live `@{u}` read fall back to `'no-upstream'`, silently unbinding the
    // upstream posture's assertions from the tracked one's.
    if (remoteKind === "tracking") fixtureGit(s.dir, "push", "-q", "-u", "origin", branch);
  }

  const entry: BmadRepo = {
    path: s.dir,
    // From the exported default rather than a literal pair: hardcoding the tools here would mask a
    // regression in the Manifest loader's own defaulting. `tools` is REQUIRED on `BmadRepo`, so it
    // cannot simply be omitted.
    tools: [...DEFAULT_TOOLS],
    claudeTracked: posture !== "gitignored" && posture !== "source-only",
    hasUpstream: remoteKind === "tracking",
    name,
    ...(posture === "source-only" ? { role: "source-only" as const } : {}),
  };

  return {
    dir: s.dir,
    posture,
    entry,
    branch,
    ...(remote !== undefined ? { remote } : {}),
    async cleanup() {
      await s.cleanup();
      if (remote !== undefined) await rm(remote, { recursive: true, force: true });
    },
  };
}

/**
 * The FR-11 dirty posture: N unrelated files COMMITTED and then modified, plus a BMAD-managed change
 * under each scoped tree.
 *
 * Committed-then-modified rather than merely untracked, because that is the strictly harder case for the
 * never-`git add -A` claim: `git add -A` stages modifications AND untracked files, so a fixture of only
 * untracked dirt would still be caught, but one of tracked modifications proves the pathspec limit is
 * what is doing the work. The BMAD-managed changes are what give the scoped stage something real to do.
 */
function seedDirty(dir: string, count: number, skills: readonly string[]): void {
  for (let i = 0; i < count; i++) {
    writeFixtureFile(join(dir, `unrelated-${String(i).padStart(3, "0")}.txt`), `clean ${i}\n`);
  }
  fixtureGit(dir, "add", "-A");
  fixtureGit(dir, "commit", "-m", "unrelated work");
  for (let i = 0; i < count; i++) {
    writeFixtureFile(join(dir, `unrelated-${String(i).padStart(3, "0")}.txt`), `dirt ${i}\n`);
  }

  // A BMAD-managed change, under `_bmad/` rather than under a Surface. Deliberately NOT a Surface edit:
  // the Surfaces are byte-copies of the module, and diverging one would make this fixture fail the
  // dual-surface verification for a reason that has nothing to do with FR-11 — a fixture that is ALREADY
  // broken cannot show what the git spine does to a healthy repo. `_bmad/` is a scoped pathspec, so the
  // scoped stage still has real work to do here. Placed directly under `_bmad/` so it exists whatever
  // built-in set the caller seeded.
  writeFixtureFile(join(dir, "_bmad", "estate-marker.txt"), `managed by the estate\n${skills.join("\n")}\n`);
}

/** Write a file and every missing parent. */
function writeFixtureFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

/** A built estate: the fixtures in construction order, the Manifest they describe, and one `cleanup()`. */
export interface FixtureEstate {
  readonly repos: FixtureRepo[];
  /** `repos.map(r => r.entry)` — feed straight to `selectRepos`, or write to a synthetic manifest. */
  readonly manifest: BmadRepo[];
  cleanup(): Promise<void>;
}

/**
 * Build the whole estate, IN THE GIVEN ORDER (AC5). Order matters downstream: BM-16's "the batch
 * continued, in Manifest order" assertion compares against exactly this sequence, so construction order
 * is part of the contract rather than an implementation detail.
 *
 * `cleanup()` uses `allSettled`, never `all`: one rejected teardown must not leak the other five
 * temp trees.
 */
export async function makeFixtureEstate(
  postures: readonly FixturePosture[] = ALL_POSTURES,
  opts: FixtureRepoOpts | ((posture: FixturePosture, index: number) => FixtureRepoOpts) = {},
): Promise<FixtureEstate> {
  const repos: FixtureRepo[] = [];
  for (const [i, posture] of postures.entries()) {
    const base = typeof opts === "function" ? opts(posture, i) : opts;
    // Suffixed so a caller may build two of the same posture without them colliding on a `--repos` key
    // — a duplicate match key is a fail-loud Manifest fault, not a silently-merged entry.
    const dupe = postures.indexOf(posture) !== i;
    repos.push(
      await makeFixtureRepo(posture, dupe ? { ...base, name: base.name ?? `${posture}-${i}` } : base),
    );
  }
  return {
    repos,
    manifest: repos.map((r) => r.entry),
    async cleanup() {
      await Promise.allSettled(repos.map((r) => r.cleanup()));
    },
  };
}

/**
 * Resolve the `bmad` binary: `$BMAD_BIN` → first `bmad` on `$PATH` → `null`. The `null` is the AC7 SKIP
 * signal — on CI (GitHub Actions, no `bmad` on PATH) the proof suite reports skipped, never 127-red.
 * Never a baked path (BM-3, the identity trap).
 */
export function resolveBmadBin(): string | null {
  const override = process.env.BMAD_BIN;
  if (override && override.length > 0) return override;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, "bmad");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
