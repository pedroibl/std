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
// SCOPE (2.2): the gate STRUCTURE and the plan threading land here. No filter BODY does. `--apply` in
// this story performs no real IO either — see the banner on the apply branch for which story fills what.
//
// D1 core purity: a Bun edge. D4: no path, repo, or binary literal — everything arrives via `deps`.

import { join } from "node:path";

import type { BmadDeps, InstallLeg, PlanProjection, RepoResult } from "./deps";
import { type BmadRepo, repoName } from "./manifest";
import type { BmadOpts } from "./opts";

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
    installArgv: leg.buildArgv({ repo, opts, deps }),
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
 */
export function runRepoPipeline(
  repo: BmadRepo,
  leg: InstallLeg,
  opts: BmadOpts,
  deps: BmadDeps,
): RepoResult {
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

  // APPLY. The ordered filter chain lands in this branch across the rest of Epic A, each filter
  // receiving the SAME `planned` object computed above:
  //
  //   guard   (2.3) — module-guard, FR-6
  //   backup  (2.3) — write `planned.backupPath`, FR-7/BM-8, then set `result.backupPath`
  //   leg     (2.3/2.5) — shell `deps.exec(deps.bmadBin, planned.installArgv)`
  //   verify  (2.6) — Parity/Faithfulness, BM-10
  //   stage   (2.4) — scoped staging → `result.stagedPaths`; gitignored ⇒ `skipped-gitignored`
  //   commit  (2.4) — commit-if-staged → `result.committed`
  //   push    (2.4) — gated on `planned.wouldPush` → `result.pushed`
  //
  // In 2.2 none of those bodies exists, so this branch returns the same-shaped row with `planned`
  // intact and every outcome still at its zero value. That is the point: the gate and the plan
  // threading are what this story lands, and they are provable without a single side effect.
  return result;
}
