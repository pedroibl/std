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
// (FR-8/BM-3/BM-15) — plus `skillTreeDigest` (FR-10/BM-10). Verify (2.6) and the git spine (2.4) remain
// the no-op stubs the apply branch's banner names; 2.3 delegates to them and duplicates neither.
//
// D1 core purity: a Bun edge. D4: no path, repo, or binary literal — everything arrives via `deps`.

import { createHash } from "node:crypto";
import { join, relative } from "node:path";

import { walkFiles } from "../fsx/index";
import type { BmadDeps, InstallLeg, PlanProjection, RepoResult } from "./deps";
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
 * `wouldStage`/`wouldCommit` are seeded deterministically. Story 2.4 computes the real scoped-staging
 * set; seeding them now is what makes the plan's SHAPE and its threading provable a story early.
 */
export function buildPlan(
  repo: BmadRepo,
  leg: InstallLeg,
  opts: BmadOpts,
  deps: BmadDeps,
): PlanProjection {
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
    wouldStage: [], // STORY 2.4
    wouldCommit: false, // STORY 2.4
    // An INTENT, and deliberately independent of `apply`: a dry run must report that it would push.
    wouldPush: opts.push,
  };
}

/**
 * Run one repo through the pipeline and return its ledger row (BM-5). This is the ONLY place in the
 * family where `opts.apply` is read (BM-6) — one flag, one branch, one file.
 *
 * Dry-run (the default) is a no-op that RECORDS INTENT: it returns the plan with every outcome field at
 * its literal zero value, and it touches no mutating member of `deps` — no `exec`, no `git`, no write.
 * That is asserted directly in `cli-dryrun.test.ts` by injecting a `BmadDeps` whose mutating members
 * throw.
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

  const result: RepoResult = {
    repo: repoName(repo),
    // `branch`/`ahead` are provisional in 2.2: read off the Manifest ENTRY, which is informational only.
    // Story 2.4 replaces both with a live `deps.git` posture read. Deliberately not shelled here — 2.2
    // shells nothing, and a live read now would make the dry-run path do IO (AC4).
    status: "ok",
    branch: repo.branch ?? "(unknown)",
    ahead: repo.hasUpstream ? 0 : "no-upstream",
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
  //   verify  (2.6) — Parity/Faithfulness, BM-10 — still a no-op stub
  //   stage   (2.4) — scoped staging → `result.stagedPaths`; gitignored ⇒ `skipped-gitignored`
  //   commit  (2.4) — commit-if-staged → `result.committed`
  //   push    (2.4) — gated on `planned.wouldPush` → `result.pushed`

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
  const install = await deps.exec(deps.bmadBin, planned.installArgv);
  if (install.code !== 0) {
    result.status = "failed";
    result.reason = installerFailure(deps.bmadBin, install);
    return result;
  }

  // ── verify (2.6) → stage / commit / push (2.4) ──────────────────────────────────────────────────
  // DELEGATED, not implemented here. Until those stories land the outcomes stay at their zero values;
  // 2.3 must not inline a checksum verify (BM-10 forbids it) or any `git add`/commit/push (2.4 owns it).
  return result;
}

/** Flatten an unknown throw into a message without losing a non-Error's text. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The fail-loud `reason` for a non-zero installer exit (AC7/BM-11).
 *
 * The installer's stderr is carried VERBATIM — never paraphrased, never summarized. Its ancestor-conflict
 * message is the single most actionable line a failed run produces, and a rewritten version of it costs
 * the operator the fix.
 *
 * Two shapes get extra help:
 *   - `127` is `spawnCapture`'s launch-failure sentinel, i.e. no `bmad` on PATH. That is the REQUIRED-TOOL
 *     exception to std's "absent binary ⇒ SKIP 0" adapter rule (BM-3): `bmad` is this operation, not an
 *     optional capability, so it fails with remediation rather than reporting a clean skip.
 *   - EMPTY stderr falls back to stdout and then to an explicit marker. A bare "failed (exit 1):" with
 *     nothing after the colon is a silent failure wearing a failure's clothes.
 */
function installerFailure(bin: string, r: { stdout: string; stderr: string; code: number }): string {
  const output = r.stderr.trim() !== "" ? r.stderr : r.stdout.trim() !== "" ? r.stdout : "(no output)";
  if (r.code === 127) {
    return (
      `bmad binary "${bin}" could not be launched (exit 127) — install bmad, put it on $PATH, or set ` +
      `$BMAD_BIN to its absolute path, then re-run. Launch error: ${output}`
    );
  }
  return `bmad install failed (exit ${r.code}): ${output}`;
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
      entries.push({ rel: relative(repoRoot, file), content: deps.fs.readIfExists(file) ?? "" });
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
