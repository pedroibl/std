// The per-repo pipeline — the SINGLE mutation gate of the `bmad-manager` family (Story 2.2, AC3/AC4;
// BM-6/BM-14). This is the load-bearing safety module: every later story's effect hangs off the one
// `if (opts.apply)` branch below, and every later story's plan flows from the one `buildPlan` call.
//
// THE DEFECT CLASS THIS STRUCTURE KILLS (Epic-5 `--brain`): "the plan you preview is not the plan that
// runs", because dry-run and apply took DIFFERENT code paths that drifted apart over successive changes.
// The fix is structural, not disciplinary — there is exactly ONE plan computation, it happens BEFORE the
// gate, and both sides thread the same object. If you are editing this file and find yourself computing
// a `PlanProjection` inside the apply branch, stop: that is the regression, and `cli-dryrun.test.ts`
// will catch it (it counts how many times the plan is built).
//
// SCOPE (2.2): the gate STRUCTURE and the plan threading land here. No filter BODY did.
// SCOPE (2.3): the first two filter BODIES land — backup (FR-7/BM-8) and the installer shell-out
// (FR-8/BM-3/BM-15) — plus `skillTreeDigest` (FR-10/BM-10).
// SCOPE (2.6): the verify filter is FILLED — delegated to `bmad-verify.ts`'s scoped engine (BM-10). It
// sits between the installer and the git spine, and it is the only filter that can fail a repo for a
// reason the installer reported as success.
// SCOPE (2.4): the git filters are FILLED — but their bodies live in `git-safety.ts` (BM-7's one
// chokepoint), and this file only ORDERS them and records their outcomes. Every git write below is
// followed by a state check that proves the write happened, because `deps.git` is fail-soft and cannot
// report a failure; see `git-safety.ts`'s header for the full contract before editing any of it.
//
// D1 core purity: a Bun edge. D4: no path, repo, or binary literal — everything arrives via `deps`.

import { createHash } from "node:crypto";
import { join, relative } from "node:path";

import { walkFiles } from "../fsx/index";
import { BmadVerifyError, verifyRepo } from "./bmad-verify";
import type { BmadDeps, InstallLeg, PlanProjection, RepoResult } from "./deps";
import {
  commitIfStaged,
  presentScopedPaths,
  pushGate,
  readGitPosture,
  scopedStage,
  stagingFailed,
} from "./git-safety";
import { type BmadRepo, repoName } from "./manifest";
import type { BmadOpts } from "./opts";

/**
 * The TWO Surface trees a `bmad install` renders into, and therefore the exact scope of both the FR-7
 * backup and the FR-10 idempotency digest (BM-9/BM-10). Nothing else in a repo is this family's
 * business: a whole-repo snapshot or a whole-repo checksum is what BM-10 forbids.
 */
const SURFACE_TREES = [join(".claude", "skills"), join(".agents", "skills")] as const;

/** The reported no-op explanation when a repo has neither Surface tree (AC2 — a report, not an error). */
const NO_SURFACE_TREES = "no existing Surface trees — backup skipped (no-op)";

/**
 * The paths `bmad install` REGENERATES by design (BM-10) — they differ between two byte-identical
 * installs, so counting them as drift would make every verify red. Pruned from the digest walk.
 *
 * They sit under `_bmad/`, which is outside both Surface skill roots already; pruning them is
 * belt-and-suspenders against a future estate that nests one inside a skill tree.
 */
const REGEN_DIRS = /(^|[/\\])_bmad[/\\](_config|scripts)([/\\]|$)/;

/**
 * Project what a run WOULD do to one repo (BM-14). **Pure**: it reads `repo`/`opts` and the resolved
 * paths on `deps`, calls `deps.clock()` and `leg.buildArgv`, and returns a value. It performs no effect
 * and mutates nothing, which is what makes it safe to compute before knowing whether `--apply` was given.
 *
 * `installArgv` is authored by the LEG, never inlined here (BM-15): the pipeline is rule-agnostic, so
 * changing the install rule (2.3) or the update rule (2.5) touches one command module and not this file.
 * The {@link LegCtx} is built from this function's own parameters.
 *
 * SINCE 2.4 THIS READS THE FILESYSTEM (`deps.fs.exists`, via `presentScopedPaths`). It is still pure in
 * the sense that matters — no mutation, no subprocess — but a `BmadDeps` fake that omits `fs.exists`
 * now throws here instead of silently returning the seeded `[]`. Every fake in the suite supplies it.
 *
 * `wouldStage`/`wouldCommit` ARE INTENTS AND ARE NOT PREDICTIONS OF THE OUTCOME (BM-14). `wouldStage` is
 * the set of scoped PATHSPECS present at PLAN time — computed before the installer has run, and
 * therefore before the files the installer is about to write exist. `RepoResult.stagedPaths` is the
 * outcome: the actual FILE list git staged afterwards. The two are different kinds of thing and a reader
 * who conflates them will read a correct plan as a wrong one. The gates are honored here too, so a
 * source-only or gitignored repo honestly projects "would stage nothing".
 */
export function buildPlan(
  repo: BmadRepo,
  leg: InstallLeg,
  opts: BmadOpts,
  deps: BmadDeps,
): PlanProjection {
  // The same two gates the apply path applies, in the same order (AC5/AC3) — a plan that projected
  // staging for a repo the git filter will skip would be a preview of a run that cannot happen.
  const gated = repo.role === "source-only" || (repo.claudeTracked === false && !opts.forceTrack);
  const wouldStage = gated ? [] : presentScopedPaths(repo.path, deps);

  return {
    // The leg receives a NARROWED deps object, built here rather than passed through: handing it the
    // whole seam and relying on `LegDeps` to hide the effect members would leave them reachable at
    // runtime through one `as` cast. Constructing the slice makes the dry-run guarantee structural.
    installArgv: leg.buildArgv({
      repo,
      opts,
      deps: {
        bmadBin: deps.bmadBin,
        manifestPath: deps.manifestPath,
        estateModulePath: deps.estateModulePath,
        backupRoot: deps.backupRoot,
      },
    }),
    // BM-8. `deps.clock()` is injected precisely so this is deterministic under test — a live clock
    // would make two runs' backupPath differ and defeat the SM-3 equality the whole gate is judged by.
    backupPath: join(deps.backupRoot, repoName(repo), deps.clock()),
    wouldStage,
    wouldCommit: wouldStage.length > 0,
    // An INTENT, and deliberately independent of `apply`: a dry run must report that it would push.
    wouldPush: opts.push,
  };
}

/**
 * Run one repo through the pipeline and return its ledger row (BM-5). This is the ONLY place in the
 * family where `opts.apply` is read (BM-6) — one flag, one branch, one file.
 *
 * Dry-run (the default) is a no-op that RECORDS INTENT: it returns the plan with every outcome field at
 * its literal zero value, and it touches no mutating member of `deps` — no `exec`, no write, and no git
 * WRITE. Since 2.4 it does perform the read-only git posture read (`rev-parse`/`rev-list`), which is what
 * lets a preview report the branch the plan actually applies to. `cli-dryrun.test.ts` asserts both halves
 * by injecting a `BmadDeps` whose mutating members throw and whose `git` throws on every write
 * subcommand, then asserting the only argv a dry run issued were reads.
 *
 * ASYNC SINCE 2.3, and the whole family inherits it. `deps.exec` is `src/proc`'s `spawnCapture`, which
 * returns a promise, so the first real installer shell-out is what flips this function — and therefore
 * `runBatch` — from sync to async. `batchExit` stays sync (it consumes the resolved rows).
 *
 * FAIL-FAST WITHIN A REPO (BM-4), FAULT-ISOLATED ACROSS REPOS (FR-15/BM-16). Every failure below sets
 * `status:'failed'` with a named `reason` and RETURNS, so no later filter runs against a repo whose
 * backup or install did not complete. It does not throw: `runBatch` keeps iterating, which is how one
 * bad repo in a twelve-repo estate reports eleven successes and one named failure.
 */
export async function runRepoPipeline(
  repo: BmadRepo,
  leg: InstallLeg,
  opts: BmadOpts,
  deps: BmadDeps,
): Promise<RepoResult> {
  // ONE plan computation, BEFORE the gate. Both sides below thread THIS object — neither recomputes.
  const planned = buildPlan(repo, leg, opts, deps);

  // LIVE posture, in BOTH modes (2.4/AC7). This replaces 2.2's provisional read off the Manifest entry,
  // whose `branch?` is informational only — a repo sitting on a feature branch while the Manifest says
  // `main` is ordinary, and a preview that reported `main` would be previewing the wrong repo state.
  //
  // It is correct on the dry-run path because it is READ-ONLY: `rev-parse` and `rev-list` mutate
  // nothing. That is the one and only reason a `deps.git` call is allowed above the `--apply` gate, and
  // the dry-run guard in `cli-dryrun.test.ts` enforces the distinction by making every git WRITE
  // subcommand throw while letting reads through.
  const posture = readGitPosture(repo, deps);

  const result: RepoResult = {
    status: "ok",
    repo: repoName(repo),
    branch: posture.branch,
    ahead: posture.ahead,
    planned,
    // OUTCOMES (BM-14) — literal zero values. Never derived from `planned.would*`.
    stagedPaths: [],
    committed: false,
    pushed: false,
  };

  if (!opts.apply) {
    // DRY RUN (default). Intent recorded, nothing done. This is the FR-5 guarantee.
    return result;
  }

  // APPLY. The ordered filter chain (BM-4), each filter receiving the SAME `planned` computed above:
  //
  //   guard   (2.3) — module-guard, FR-6 — HOISTED above the batch, in `install.ts`, because it
  //                   validates the estate SOURCE and is repo-invariant. See `estate-source.ts`.
  //   backup  (2.3) — ✅ below
  //   leg     (2.3/2.5) — ✅ below
  //   verify  (2.6) — ✅ below — Parity/Faithfulness/set-Parity, BM-10 — delegated to `bmad-verify.ts`
  //   stage   (2.4) — ✅ below — scoped staging → `result.stagedPaths`; gitignored ⇒ `skipped-gitignored`
  //   commit  (2.4) — ✅ below — commit-if-staged → `result.committed`
  //   push    (2.4) — ✅ below — gated on `opts.push` → `result.pushed`

  // ── backup (FR-7 / BM-8) ────────────────────────────────────────────────────────────────────────
  // BEFORE the installer, always: a backup taken after the mutation reverses nothing.
  try {
    const written = backupSurfaces(repo.path, deps, planned.backupPath);
    if (written === null) result.reason = NO_SURFACE_TREES;
    else result.backupPath = written;
  } catch (err) {
    // A repo we could not snapshot must NOT be installed into — that is the one path that produces an
    // irreversible change, which is precisely what FR-7 exists to prevent.
    result.status = "failed";
    result.reason = `backup failed: ${errText(err)}`;
    return result;
  }

  // ── installer (FR-8 / BM-3 / BM-15) ─────────────────────────────────────────────────────────────
  // `planned.installArgv` — NOT a second `leg.buildArgv(ctx)` call. The argv that was previewed is the
  // argv that runs; recomputing it here is the exact dry-run/apply divergence BM-14 forbids, and under
  // a live clock it would also re-derive a different `--custom-source` timestamp.
  //
  // A LIST SINCE 2.5, run ORDERED and FAIL-FAST within the repo (BM-4). `update` emits two invocations
  // (built-in `quick-update`, then module `--custom-source`) and they are not interchangeable — FR-9
  // exists because the first one CANNOT propagate a local module edit.
  //
  // `spawnCapture` NEVER REJECTS (`src/proc/index.ts`): a timeout is `124`, a launch failure `127`, a
  // signal `128+signo`. The exit CODE is therefore the entire signal, and there is nothing here for a
  // `try/catch` to catch. Treating "it did not throw" as success IS the silent-failure mode, and on a
  // multi-invocation leg it is worse than on a single one: leg 1 can succeed, leg 2 fail, and the repo
  // is left HALF-UPDATED. That repo must never report `ok` (FR-15/AC6), and the `reason` must say which
  // leg died, so the operator knows whether the built-ins or the estate module is the half that landed.
  for (const [i, invocation] of planned.installArgv.entries()) {
    const install = await deps.exec(deps.bmadBin, invocation);
    if (install.code !== 0) {
      result.status = "failed";
      result.reason = installerFailure(
        deps.bmadBin,
        install,
        legLabel(leg, planned.installArgv.length, i),
        result.backupPath,
        invocation,
      );
      // Later invocations do NOT run, and neither does verify/stage/commit/push (BM-4). A repo whose
      // built-in refresh failed must not then have the estate module written over the top of it.
      return result;
    }
  }

  // ── verify (2.6 / FR-16 / BM-10) ────────────────────────────────────────────────────────────────
  // DELEGATED, never inlined: the engine is `bmad-verify.ts`, and this file must not grow a comparison
  // of its own (BM-10 forbids a whole-repo checksum, and a second comparison rule is how one appears).
  //
  // POSITION IS THE CONTRACT (BM-4): AFTER the installer — there is nothing to verify until it has run —
  // and BEFORE the git filters, so a divergent repo is never staged or committed. It sits ABOVE the
  // gitignore short-circuit on purpose: a `skipped-gitignored` repo has been installed into and must
  // still be verified (BM-17). Do not add a `claudeTracked` guard here.
  //
  // FAIL-FAST WITHIN THE REPO, ISOLATED ACROSS REPOS. `reason` carries the diverging paths VERBATIM
  // (FR-15) — a count would tell the operator that something is wrong and not what.
  try {
    const errors = (await verifyRepo(repo.path, opts.skills, deps.estateModulePath, deps)).filter(
      (f) => f.severity === "error",
    );
    if (errors.length > 0) {
      result.status = "failed";
      note(result, errors.map((f) => f.message).join("; "));
      return result;
    }
  } catch (err) {
    // A `diff` that could not RUN (exit ≥2, incl. a missing binary) is not drift — it means the repo was
    // not verified at all, and an unverified repo must never reach the git spine. Fails this repo alone.
    if (!(err instanceof BmadVerifyError)) throw err;
    result.status = "failed";
    note(result, err.message);
    return result;
  }

  // ── the git spine (2.4) ─────────────────────────────────────────────────────────────────────────
  // TWO GUARDS, THEN THREE MUTATIONS, EACH MUTATION FOLLOWED BY A STATE CHECK. The guards come first
  // and RETURN, which is what makes them unbypassable: no later step can stage inside a repo the guards
  // excluded, and neither guard can be tripped by the staging verification that follows them.

  // 1. SOURCE-ONLY (AC5/BM-11). Belt-and-suspenders to 2.1's `selectRepos`, which already omits
  //    source-only entries from the DEFAULT set — but an explicit `--repos <source-only-name>` routes
  //    one straight into the batch, and these repos are nested INSIDE another repo. Committing here
  //    would write a commit into the parent's history from a path the operator named for inspection.
  //    Non-failing: being source-only is a fact about the repo, not a fault.
  if (repo.role === "source-only") {
    note(result, "source-only — staging/commit skipped (BM-11)");
    return result;
  }

  // 2. GITIGNORE HONOR (AC3/FR-13/BM-17). `claudeTracked === false` is 2.1's REQUIRED, never-defaulted
  //    boolean: the working copy has already been updated by the installer above, and that is the whole
  //    intended outcome for these repos. `skipped-gitignored` is NON-failing (`batchExit` treats it as
  //    a clean exit) and it does not short-circuit anything that mattered — verify ran before it.
  //    `--force-track` is the explicit, per-invocation, never-persisted escape.
  if (repo.claudeTracked === false && !opts.forceTrack) {
    result.status = "skipped-gitignored";
    note(result, "gitignored, working copy updated");
    return result;
  }

  // 3. STAGE (AC1) — then PROVE THE STAGE TOOK (AC6). `scopedStage` returns the authoritative staged
  //    set, but an empty one is ambiguous: a fail-soft `git add` that did nothing and a repo with
  //    genuinely nothing to stage both produce `[]`. `stagingFailed` disambiguates them from the
  //    WORKTREE — unstaged changes still sitting under paths staging was just asked to cover mean the
  //    add did not take. Deleting this check restores exactly the silent-success defect FR-15 forbids.
  result.stagedPaths = scopedStage(repo, opts, deps);
  if (stagingFailed(repo, deps)) {
    result.status = "failed";
    note(result, "staging failed (unstaged changes remain under scoped paths)");
    return result;
  }

  // 4. COMMIT (AC2). A REAL failure (HEAD did not advance on a non-empty index) is fail-fast within the
  //    repo — push must not run against a commit that does not exist. "nothing to commit" is NOT a
  //    failure: it is the idempotent re-run, which is the common case on a healthy estate.
  const commit = commitIfStaged(repo, deps);
  result.committed = commit.committed;
  if (!commit.committed && commit.reason !== "nothing to commit") {
    result.status = "failed";
    note(result, commit.reason ?? "commit failed");
    return result;
  }
  if (commit.reason !== undefined) note(result, commit.reason);

  // 5. RE-READ AHEAD (AC7). The commit just made moved the repo one further ahead of upstream, and a
  //    ledger that reported the pre-commit count would understate what a subsequent `--push` will send.
  result.ahead = readGitPosture(repo, deps).ahead;

  // 6. PUSH (AC4). `pushGate` issues NOTHING without `--push`; `--apply` never implies it.
  const push = pushGate(repo, opts, deps, result.branch);
  result.pushed = push.pushed;
  if (opts.push && !push.pushed && push.reason !== undefined) {
    result.status = "failed";
    note(result, push.reason);
  }
  // A SUCCESSFUL push means the ledger's `ahead` is now stale by exactly the commits it just sent, and
  // reporting "1 ahead" for a repo that is level with its upstream is a false statement in the one
  // artifact an operator reads. This is not a derived value: `pushGate` returns `pushed: true` ONLY
  // after reading `git rev-list --count @{u}..HEAD` and finding it `0`, so this records the number that
  // read produced. It also fixes the `push -u` case, where the Manifest's `hasUpstream: false` would
  // otherwise keep `readGitPosture` reporting `no-upstream` for a repo that now demonstrably has one.
  if (push.pushed) result.ahead = 0;

  return result;
}

/**
 * Record a `reason` on a row without DESTROYING one already there (2.4).
 *
 * `RepoResult.reason` is a single string, but a repo can honestly have more than one thing worth saying
 * about it — 2.3's backup no-op ("no existing Surface trees") and 2.4's "nothing to commit" are both
 * true of the ordinary first-install repo, and they arrive from different filters. A plain assignment in
 * the later filter silently ate the earlier one, which is a small instance of exactly the fault this
 * story exists to prevent: a run that reports less than it knows.
 *
 * Appending keeps both facts and keeps every `toContain`-shaped assertion honest. Callers that need to
 * BRANCH on a specific reason must branch on the value the helper returned (e.g. `commitIfStaged`'s),
 * never on `result.reason` — which is a report, not a control signal.
 */
function note(result: RepoResult, text: string): void {
  result.reason = result.reason === undefined ? text : `${result.reason}; ${text}`;
}

/** Flatten an unknown throw into a message without losing a non-Error's text. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Name the invocation that failed, POSITIONALLY (2.5/AC6).
 *
 * A two-invocation leg whose failure report cannot say WHICH invocation died is unactionable: "built-in"
 * means the repo's `core`/`bmm` refresh failed and the estate module was never written, while "module"
 * means the built-ins ARE refreshed and the repo is half-updated. Those are different repair jobs.
 *
 * The pair is ordered by construction — `update`'s leg emits built-in first — so position IS the label.
 * The single-invocation case is NOT hardcoded to either name: it reads `leg.kind`, because `install`'s
 * one argv is an install and `update`'s degenerate one argv (a repo with no built-in on disk) is the
 * module leg. Hardcoding the pair would mislabel both single-argv shapes.
 *
 * Indexed DEFENSIVELY. If a future leg emits a third invocation, `LEG_PAIR[2]` is `undefined` and the
 * reason would read "undefined leg failed" — nonsense in the one artifact an operator reads. It degrades
 * to a positional name instead.
 */
function legLabel(leg: InstallLeg, total: number, i: number): string {
  if (total === 1) return leg.kind === "install" ? "install" : "module";
  return LEG_PAIR[i] ?? `leg ${i + 1}`;
}

/** `update`'s ordered invocation names (BM-15) — built-in `quick-update` first, module last. */
const LEG_PAIR = ["built-in", "module"] as const;

/**
 * The fail-loud `reason` for a non-zero installer exit (AC7/BM-11).
 *
 * The installer's stderr is carried VERBATIM — never paraphrased, never summarized. Its ancestor-conflict
 * message is the single most actionable line a failed run produces, and a rewritten version of it costs
 * the operator the fix.
 *
 * FOUR THINGS ARE NON-NEGOTIABLE IN THIS STRING (FR-15/AC6), because together they are the entire
 * difference between a half-updated repo that reports honestly and one that reports `ok`:
 *   - WHICH invocation failed (`label`) — see {@link legLabel}.
 *   - The exact argv, so the operator can re-run the one command that died.
 *   - The installer's stderr VERBATIM.
 *   - The `backupPath`, when a backup was written — the rollback handle for the half that DID land.
 *     A backup taken but never named in the failure report is a rollback the operator cannot perform.
 *
 * Two shapes get extra help:
 *   - `127` is `spawnCapture`'s launch-failure sentinel, i.e. no `bmad` on PATH. That is the REQUIRED-TOOL
 *     exception to std's "absent binary ⇒ SKIP 0" adapter rule (BM-3): `bmad` is this operation, not an
 *     optional capability, so it fails with remediation rather than reporting a clean skip.
 *   - `124` is the timeout sentinel, named so a hung installer does not read as a generic failure.
 *   - EMPTY stderr falls back to stdout and then to an explicit marker. A bare "failed (exit 1):" with
 *     nothing after the colon is a silent failure wearing a failure's clothes.
 */
function installerFailure(
  bin: string,
  r: { stdout: string; stderr: string; code: number },
  label: string,
  backupPath: string | undefined,
  argv: string[],
): string {
  const output = r.stderr.trim() !== "" ? r.stderr : r.stdout.trim() !== "" ? r.stdout : "(no output)";
  const rollback = backupPath === undefined ? "" : `\nrollback: ${backupPath}`;
  if (r.code === 127) {
    return (
      `${label} leg failed: bmad binary "${bin}" could not be launched (exit 127) — install bmad, put ` +
      `it on $PATH, or set $BMAD_BIN to its absolute path, then re-run. ` +
      `Failing invocation: ${bin} ${argv.join(" ")}. Launch error: ${output}${rollback}`
    );
  }
  const timeout = r.code === 124 ? " — timed out" : "";
  return (
    `${label} leg failed (exit ${r.code})${timeout}: ${bin} ${argv.join(" ")}\n${output}${rollback}`
  );
}

/**
 * Snapshot a repo's Surface trees to `backupPath` (FR-7/BM-8). Returns the path when at least one tree
 * was copied, or `null` when the repo has neither — a REPORTED NO-OP, not an error. A repo with no
 * `.claude/skills` is the ordinary first-install case; throwing there would make the common path fail.
 *
 * OUT-OF-REPO, always: `backupPath` comes from the plan, which composes it under `deps.backupRoot`
 * (BM-8's state home). An in-repo `.bmad-backups/` would become untracked dirty-tree noise fighting
 * FR-11's scoped staging — the reason BM-8 chose the state home in the first place.
 *
 * Exported for 2.5/2.7, which snapshot the same two trees before their own legs run.
 */
export function backupSurfaces(repoRoot: string, deps: BmadDeps, backupPath: string): string | null {
  let copied = 0;
  for (const tree of SURFACE_TREES) {
    const src = join(repoRoot, tree);
    if (!deps.fs.exists(src)) continue;
    deps.fs.cpDir(src, join(backupPath, tree));
    copied++;
  }
  return copied > 0 ? backupPath : null;
}

/**
 * An EXACT content digest of a repo's two Surface skill trees (FR-10/BM-10) — the idempotency probe.
 * Two byte-identical trees digest equal; any real drift changes it.
 *
 * NOT `core.contentHash`. That helper collapses whitespace, lowercases, and slices the first 400 chars
 * before hashing — it is built for DEDUP, and using it here would report false-equal on genuine drift
 * (a whitespace-only edit, a case change, anything past char 400). `install.test.ts` pins that with a
 * whitespace-only mutation, so a future "simplification" to `contentHash` turns the suite red.
 *
 * SCOPED to the two skill roots and PRUNED of {@link REGEN_DIRS}: a whole-repo checksum is what BM-10
 * forbids, and by-design regenerated config is not drift.
 *
 * Each entry is fed as `rel \0 length \0 content \0`. The LENGTH is not decoration — without it, a file
 * whose content contains a NUL could be re-parsed as a different (path, content) split, and two
 * different trees would digest the same.
 */
export function skillTreeDigest(repoRoot: string, deps: BmadDeps): string {
  const entries: { rel: string; content: string }[] = [];
  for (const tree of SURFACE_TREES) {
    for (const file of walkFiles(join(repoRoot, tree), undefined, { prune: isRegenDir })) {
      // Separators normalized to `/` so the digest is a property of the TREE, not of the OS that
      // walked it. `relative` emits `\` on Windows, which would make the same tree digest differently
      // per platform — a false drift signal for 2.6's verify, which is this digest's only consumer.
      const rel = relative(repoRoot, file).replaceAll("\\", "/");
      entries.push({ rel, content: deps.fs.readIfExists(file) ?? "" });
    }
  }
  // Sorted by relative path so the digest is walk-order independent — `walkFiles` uses a stack, and its
  // emission order is not a contract this may lean on.
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const hash = createHash("sha256");
  for (const e of entries) hash.update(`${e.rel}\0${e.content.length}\0${e.content}\0`);
  return hash.digest("hex");
}

/** True for a by-design regenerated directory (BM-10) — pruned from the digest walk, never descended. */
export function isRegenDir(dir: string): boolean {
  return REGEN_DIRS.test(dir);
}
