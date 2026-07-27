// The scoped-git safety spine — the ONE place in `src/bmad/` that stages, commits, or pushes anything
// (Story 2.4, FR-11/12/13/14/15; BM-4/BM-5/BM-6/BM-7/BM-11/BM-14/BM-16/BM-17).
//
// EVERY RULE HERE IS A SCAR FROM A MANUAL RUN. `git add -A` in a repo with 503 unrelated dirty files
// committed all 503. A commit that "succeeded" against a locked index committed nothing. A push that
// returned 0 against a diverged remote pushed nothing. This module exists so none of those can happen
// again, and the shape it takes is dictated by ONE source fact:
//
//   THE `git()` WRAPPER IS FAIL-SOFT. `src/git`'s `git(repo, args): string` returns `""` on ANY failure
//   — nonzero exit, missing/non-repo path, `git` off PATH, or its 5s timeout — and NEVER throws
//   (`src/git/index.ts:32-46`). It cannot report that a mutation failed.
//
// FR-15 requires fail-LOUD. The resolution is NOT a `gitResult` variant in `src/git` (a new std surface
// with no second caller — Rule-of-Three unmet, D2). It is STATE VERIFICATION: every git write below is
// followed by a read that proves the write actually happened.
//
//   write            state check that proves it happened
//   ───────────────  ─────────────────────────────────────────────────────────────────────────────────
//   git add          `git diff --cached --name-only` is the authoritative staged set (returned, not the
//                    requested pathspecs) AND the pipeline's post-stage `git status --porcelain` sweep
//                    over the present scoped paths (`stagingFailed` below) — an add that silently did
//                    nothing leaves worktree-modified/untracked lines behind.
//   git commit       `git rev-parse HEAD` before/after — HEAD MUST advance on a non-empty index.
//   git push         `git rev-list --count @{u}..HEAD` post-push MUST be 0 — a non-fast-forward or
//                    diverged remote leaves it > 0.
//
// DO NOT "SIMPLIFY" THOSE READS AWAY. A return-code check is not available here, and a command that
// returns having done nothing is the failure mode this whole module is built around. If you are editing
// this file and find yourself deleting a post-write read, that read was the only thing standing between
// a failed run and a run that reports `ok`.
//
// D1 core purity: `node:path` is edge-legal in `src/bmad/`; nothing here belongs in `src/core`.
// D4 identity-free: no repo, path, or machine literal — every path arrives via `repo.path`, and every
// effect goes through the injected `deps.git`/`deps.fs` seam (BM-7), never a raw import of `src/git`.

import { join } from "node:path";

import type { BmadDeps } from "./deps";
import type { BmadRepo } from "./manifest";
// `./opts`, NEVER `./cli` — even as `import type`. `cli.ts` value-imports the command modules, which
// reach this file through `install → batch → pipeline`, so a `./cli` edge here re-forms the import cycle
// `check:dep-root` rejects (its graph includes type-only edges by design). See `opts.ts`'s header.
import type { BmadOpts } from "./opts";

/**
 * THE SCOPED PATHSPEC SET (BM-7/FR-11) — the only paths this family ever stages, in any command, ever.
 *
 * Three entries, derived from BM-7 + the epic's scope table + FR-11, not guessed. `git add -A` and
 * `git add .` appear NOWHERE in `src/bmad/*`, and `git-safety.test.ts` proves that negative structurally
 * with an argv-recording spy over every git call a run makes.
 *
 * If a future story needs a fourth path, it goes HERE and the spy test tells you every call site it
 * changed — which is the point of there being exactly one set.
 */
const SCOPED_PATHSPECS = ["_bmad/", ".claude/skills", ".agents/skills"] as const;

/** The commit subject for an estate sync. Module-scope and identity-free (D4) — no repo, no owner. */
const COMMIT_MSG = "chore(bmad): sync estate skills";

/**
 * The subset of {@link SCOPED_PATHSPECS} that actually EXISTS in this repo (BM-7 "subset present").
 *
 * Not every repo has `.agents/skills`. Passing a non-existent pathspec to `git add` makes git fail the
 * whole invocation (`pathspec … did not match any files`), which — because `git()` is fail-soft — would
 * silently stage NOTHING while looking exactly like a repo with nothing to stage.
 *
 * Reads only (`deps.fs.exists`), so it is safe inside `buildPlan` and on the dry-run path.
 */
export function presentScopedPaths(repoRoot: string, deps: BmadDeps): string[] {
  return SCOPED_PATHSPECS.filter((p) => deps.fs.exists(join(repoRoot, p)));
}

/**
 * The LIVE git posture of a repo (AC7/FR-14) — read-only, and therefore correct to run in BOTH dry-run
 * and `--apply`. A dry run that reported a stale posture would be lying about the state its plan applies
 * to, which is the thing FR-5's preview exists to prevent.
 *
 * `branch` is read live and NEVER from `repo.branch` — the Manifest's `branch?` is documented as
 * informational only (2.1), and a repo sitting on `feature/x` while the Manifest says `main` is the
 * ordinary case, not the exception.
 *
 * The `"(unknown)"` fallback fires ONLY on a `git()` failure. A genuinely detached HEAD returns the
 * literal string `"HEAD"` from `--abbrev-ref`, not `""`, so it reports as `HEAD` and is not mislabeled.
 *
 * `ahead` is `"no-upstream"` when the Manifest says there is none, and ALSO when the live `@{u}..HEAD`
 * read comes back empty — an upstream that was configured but has since been deleted from the remote
 * makes `@{u}` unresolvable, and reporting `0 ahead` there would claim the repo is in sync with a ref
 * that no longer exists.
 */
export function readGitPosture(
  repo: BmadRepo,
  deps: BmadDeps,
): { branch: string; ahead: number | "no-upstream" } {
  const branch = deps.git(repo.path, ["rev-parse", "--abbrev-ref", "HEAD"]) || "(unknown)";
  if (repo.hasUpstream === false) return { branch, ahead: "no-upstream" };
  const raw = deps.git(repo.path, ["rev-list", "--count", "@{u}..HEAD"]);
  const n = Number(raw);
  // `raw === ""` is the fail-soft signal; `Number.isFinite` additionally rejects any non-numeric text a
  // future git version might emit, so `ahead` is never the `NaN` that would render as "NaN ahead".
  return { branch, ahead: raw === "" || !Number.isFinite(n) ? "no-upstream" : n };
}

/**
 * THE ONE GIT-ADD CHOKEPOINT (BM-7/FR-11/AC1). Returns the ACTUAL staged set.
 *
 * The only `add` argv forms this family can produce are:
 *
 *     git add -- <present subset>
 *     git add -f -- <present subset>          (only when `opts.forceTrack`, AC3)
 *
 * The `--` is not decoration: it terminates option parsing, so a pathspec can never be re-read as a
 * flag. The `-f` appears ONLY under an explicit `--force-track`, which is per-invocation and never
 * persisted — a repo whose `.claude` is gitignored stays working-copy-only unless a human says otherwise
 * on that one run (FR-13/BM-17).
 *
 * The return value is `git diff --cached --name-only`, NOT the pathspecs that were requested. Those are
 * two different facts: the pathspecs are what staging was ASKED to do (`planned.wouldStage`, an intent),
 * and the diff is what staging DID (`RepoResult.stagedPaths`, an outcome — BM-14). Returning the request
 * as if it were the result is how a failed add reports success.
 *
 * NOTE what this function does NOT do: it does not decide failure. An empty return is ambiguous by
 * construction — a fail-soft add that did nothing and a repo with genuinely nothing to stage both
 * produce `[]`. Disambiguating them needs the worktree, and that is {@link stagingFailed}'s job, called
 * by the pipeline immediately after this. Do not "fix" the ambiguity here by returning the pathspecs.
 */
export function scopedStage(repo: BmadRepo, opts: BmadOpts, deps: BmadDeps): string[] {
  const present = presentScopedPaths(repo.path, deps);
  // No scoped path exists ⇒ nothing to ask for. `git add --` with an empty pathspec list is a no-op that
  // prints "Nothing specified, nothing added" and exits 0, so this early return is about intent, not
  // safety — but it also keeps the argv spy free of meaningless calls.
  if (present.length === 0) return [];

  const argv = ["add", ...(opts.forceTrack ? ["-f"] : []), "--", ...present];
  deps.git(repo.path, argv);

  // The read-back is SCOPED too. An unscoped `diff --cached` reports the whole index, which includes
  // anything the principal had already staged before this run — so the ledger would claim bmad staged
  // files it never touched. Scoping the read keeps `stagedPaths` an honest record of THIS run's work.
  const out = deps.git(repo.path, ["diff", "--cached", "--name-only", "--", ...present]);
  return out === "" ? [] : out.split("\n").filter(Boolean);
}

/**
 * Did the `git add` silently fail? (AC6 — the stage's state-verification, parity with commit and push.)
 *
 * THIS FUNCTION IS THE ANSWER TO "if the add did nothing, what would notice?". Without it, a fail-soft
 * `git add` (index.lock held, permission denied, a corrupt index) returns `""`, `scopedStage` returns
 * `[]`, `commitIfStaged` sees an empty index and reports the benign `"nothing to commit"`, and the repo
 * is rendered `ok` — a run that changed nothing reporting success. That is the exact defect FR-15 names.
 *
 * THE DISCRIMINATOR IS *UNSTAGED CHANGES REMAINING*, NOT *EMPTY INDEX*. `git status --porcelain` emits
 * `XY <path>`, where `X` is the index state and `Y` the worktree state. A leading space (` M`, ` D` —
 * worktree-modified, nothing staged) or `?` (`??` — untracked) under a path staging was just asked to
 * cover means the add did not take. Anything with a non-space, non-`?` first character (`A `, `M `,
 * `MM`) IS staged and is not a failure.
 *
 * That choice is what keeps three legitimate cases green:
 *   - an idempotent re-run (nothing changed under the scoped paths ⇒ no lines at all ⇒ not a failure,
 *     and the flow goes on to report the benign "nothing to commit");
 *   - a `--force-track` forced add (the `-f` DID take ⇒ the files show as staged, not unstaged);
 *   - a repo where the only dirt is OUTSIDE the scoped paths (the sweep is pathspec-limited).
 *
 * THE EMPTY-`present` GUARD IS LOAD-BEARING, not defensive padding. `git status --porcelain --` with an
 * EMPTY pathspec list means "the whole repo" — verified empirically, not assumed. Dropping the guard
 * would make any repo that has no scoped paths but does have unrelated dirty files (i.e. most of the
 * estate) report `staging failed`, turning the safety spine into a machine that fails every repo it
 * touches. It returns `false` here because with nothing present there was nothing to stage.
 */
export function stagingFailed(repo: BmadRepo, deps: BmadDeps): boolean {
  const present = presentScopedPaths(repo.path, deps);
  if (present.length === 0) return false;

  const out = deps.git(repo.path, ["status", "--porcelain", "--", ...present]);
  return out
    .split("\n")
    .filter(Boolean)
    .some((line) => line.startsWith(" ") || line.startsWith("?"));
}

/**
 * Commit the index if it is non-empty, and PROVE the commit happened (AC2/AC6/FR-12).
 *
 * Exactly one commit, on the repo's LIVE current branch. The branch is never named in the argv — a plain
 * `git commit -m` commits wherever HEAD is, which is by definition the live branch, so there is no way
 * for this to land on the Manifest's stale `branch?` value.
 *
 * HEAD-DELTA IS THE FAILURE DETECTOR. `git()` cannot surface the nonzero exit of a commit rejected for
 * unmerged files, a failing hook, or a missing `user.email`, so the only honest signal is whether HEAD
 * actually moved. `committed: true` is never returned on an unmoved HEAD.
 *
 * THE `staged === ""` BRANCH IS DELIBERATELY FAIL-*SAFE*, and a future dev must not "harden" it into a
 * throw. It reports the benign `"nothing to commit"` even in the pathological case where git itself is
 * broken — because a broken environment is caught far earlier and far more legibly by 2.3's installer
 * filter, which runs through `deps.exec` and DOES see exit codes (a missing `bmad`/`git` surfaces as
 * exit 127 with remediation). What this branch can never do is report a false `committed: true`. The
 * fail-LOUD path is the state checks — HEAD-delta here, the ahead-count in {@link pushGate}, the
 * worktree sweep in {@link stagingFailed} — not the empty-diff read.
 */
export function commitIfStaged(repo: BmadRepo, deps: BmadDeps): { committed: boolean; reason?: string } {
  // BOTH the guard and the commit are SCOPED to the same pathspecs staging used. A bare
  // `git commit -m` commits the ENTIRE INDEX — so anything the principal had already staged before
  // this run (interrupted work, a half-made commit) would be swept into the estate sync commit and,
  // under `--push`, sent to their remote under a message they did not write. Scoping the staging while
  // leaving the commit global is the same defect as `git add -A`, arriving one step later.
  //
  // Verified empirically, not assumed: with unrelated work pre-staged, `git commit -m MSG -- <paths>`
  // commits ONLY the pathspec'd files and leaves that work still staged and uncommitted, exactly as
  // the principal left it.
  const present = presentScopedPaths(repo.path, deps);
  if (present.length === 0) return { committed: false, reason: "nothing to commit" };

  const staged = deps.git(repo.path, ["diff", "--cached", "--name-only", "--", ...present]);
  if (staged === "") return { committed: false, reason: "nothing to commit" };

  const before = deps.git(repo.path, ["rev-parse", "HEAD"]);
  deps.git(repo.path, ["commit", "-m", COMMIT_MSG, "--", ...present]);
  const after = deps.git(repo.path, ["rev-parse", "HEAD"]);

  if (after !== "" && after !== before) return { committed: true };
  return { committed: false, reason: "commit failed (HEAD did not advance)" };
}

/**
 * The push gate (AC4/FR-14/BM-6) — and it is a GATE, not a step.
 *
 * WITHOUT `--push` IT ISSUES NO PUSH AT ALL. `--push` is a separate flag that `--apply` never implies;
 * `parseBmadOpts` reads it from the argv alone and this is the only consumer. An implied push is one
 * step past an unrequested mutation: it is an unrequested mutation of someone else's remote.
 *
 * With `--push`, a repo with an upstream gets a bare `git push`; one WITHOUT gets
 * `git push -u origin <live-branch>`, where the branch is the live read threaded in by the caller (never
 * `repo.branch`, never a hardcoded `main`).
 *
 * POST-PUSH AHEAD-COUNT IS THE FAILURE DETECTOR. A non-fast-forward rejection against a diverged remote
 * is the single most common real push failure, and `git()` swallows its nonzero exit whole. After a push
 * that actually landed, `git rev-list --count @{u}..HEAD` is 0. After a rejected one it is still > 0, and
 * after a `push -u` that failed `@{u}` does not resolve at all and the read comes back `""`. Both report
 * `pushed: false` with a reason, which the pipeline turns into `status:'failed'`.
 */
export function pushGate(
  repo: BmadRepo,
  opts: BmadOpts,
  deps: BmadDeps,
  branch: string,
): { pushed: boolean; reason?: string } {
  // Report-only. Not a silent skip: the caller already reported `branch`/`ahead` from the live posture,
  // so the operator sees exactly what a `--push` run would have sent.
  if (!opts.push) return { pushed: false };

  const argv = repo.hasUpstream ? ["push"] : ["push", "-u", "origin", branch];
  deps.git(repo.path, argv);

  const raw = deps.git(repo.path, ["rev-list", "--count", "@{u}..HEAD"]);
  if (raw !== "" && Number(raw) === 0) return { pushed: true };
  return { pushed: false, reason: "push failed (upstream not advanced)" };
}
