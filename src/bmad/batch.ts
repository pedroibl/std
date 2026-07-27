// The batch layer — run the pipeline across the selected repos, aggregate the ledger, decide the exit
// code, and render the result (Story 2.2, AC7; BM-5/BM-16).
//
// SEQUENTIAL, IN MANIFEST ORDER (BM-16). No `Promise.all`, no concurrency, ever. Two reasons, both
// safety: the operations these repos will perform in 2.3–2.7 are git mutations, and interleaved git
// output across N repos is unreadable at exactly the moment a human needs to read it; and reproducible
// order means a re-run of the same Manifest reports in the same order, so two runs are diffable.
//
// FAULT ISOLATION (FR-15): one repo's failure does not abort the batch. It becomes that repo's own
// `status:'failed'` row and the loop CONTINUES, so a 12-repo estate with one bad entry reports 11
// successes and one named failure rather than stopping at the first fault. The run still exits 1.
//
// RULE-OF-THREE (D2): this module exists because `install`/`update`/`deploy` are three real callers of
// the same iteration + the same exit rule + the same render. It was not created speculatively.
//
// D4: no repo, path, or binary literal — everything arrives via `deps` or the Manifest.

import type { BmadDeps, InstallLeg, PlanProjection, RepoResult } from "./deps";
import { type BmadRepo, repoName } from "./manifest";
import type { BmadOpts } from "./opts";
import { runRepoPipeline } from "./pipeline";

/**
 * Run every selected repo through {@link runRepoPipeline}, in Manifest order, and collect the ledger.
 *
 * A throw from one repo is caught and recorded as that repo's `failed` row (with the message as
 * `reason`) rather than propagating — that is the FR-15 isolation contract. A fault the batch cannot
 * attribute to a repo (a malformed Manifest, a bad `--set` token, an incomplete estate module) is NOT
 * caught here: it is raised before the batch starts and the router maps it to exit 1.
 *
 * ASYNC SINCE 2.3 (the C4 cascade): `runRepoPipeline` shells the installer, so it returns a promise and
 * this loop awaits it. The `for…of` + `await` shape is deliberate and load-bearing — `Promise.all` would
 * interleave N repos' git and installer output at exactly the moment a human needs to read it, and would
 * make two runs of the same Manifest report in different orders. BM-16 is sequential, always.
 */
export async function runBatch(
  repos: BmadRepo[],
  leg: InstallLeg,
  opts: BmadOpts,
  deps: BmadDeps,
): Promise<RepoResult[]> {
  const results: RepoResult[] = [];
  for (const repo of repos) {
    try {
      results.push(await runRepoPipeline(repo, leg, opts, deps));
    } catch (err) {
      results.push(failedResult(repo, opts, err));
    }
  }
  return results;
}

/**
 * The ledger row for a repo whose pipeline threw. `planned` is required on every row, but the throw may
 * have happened DURING plan construction, so there is no real projection to report — an empty one is
 * used, with `wouldPush` still carrying the run's intent. The empty `installArgv` is the honest signal
 * that nothing was planned, and `reason` names the fault.
 */
function failedResult(repo: BmadRepo, opts: BmadOpts, err: unknown): RepoResult {
  const empty: PlanProjection = {
    installArgv: [],
    backupPath: "",
    wouldStage: [],
    wouldCommit: false,
    wouldPush: opts.push,
  };
  return {
    repo: repoName(repo),
    status: "failed",
    branch: repo.branch ?? "(unknown)",
    ahead: repo.hasUpstream ? 0 : "no-upstream",
    planned: empty,
    stagedPaths: [],
    committed: false,
    pushed: false,
    reason: err instanceof Error ? err.message : String(err),
  };
}

/**
 * The family's batch exit code (BM-5): `1` if ANY repo failed, else `0`. A `skipped-gitignored` repo is
 * NOT a failure (FR-13/BM-17) — it is a reported, expected outcome, so it exits 0.
 */
export function batchExit(results: RepoResult[]): number {
  return results.some((r) => r.status === "failed") ? 1 : 0;
}

/**
 * Render the batch (AC5). COMPOSES `src/report`'s shipped primitives through the `deps.report` seam —
 * `lines()` for the markdown accumulator, `emitJson` for the machine payload. Neither is re-implemented
 * here (NFR-4), and no `console.*` is used: human markdown goes through `deps.report.print`, so the whole
 * output path stays injectable (BM-7/AC6).
 *
 * Under `--json` the structured payload is the ONLY thing on stdout, matching `src/report`'s contract.
 *
 * Shared by all three command scaffolds — the Rule-of-Three third caller. What each command owns is its
 * LEG (BM-15); what they share is how a `RepoResult[]` reads, and that must not drift between them.
 */
export function renderBatch(
  command: string,
  results: RepoResult[],
  opts: BmadOpts,
  deps: BmadDeps,
  json: boolean,
): void {
  const mode = opts.apply ? "apply" : "dry-run";

  if (json) {
    deps.report.emitJson({ command, mode, repos: results });
    return;
  }

  const { p, toString } = deps.report.lines();
  p(`# bmad ${command} — ${opts.apply ? "APPLY" : "DRY RUN"}`);
  p();
  if (!opts.apply) {
    p("No changes were made. Re-run with `--apply` to execute this exact plan.");
    p();
  }
  if (results.length === 0) {
    p("_No repos selected._");
  }
  for (const r of results) {
    p(`## ${r.repo} — ${r.status}`);
    p();
    p(`- branch: ${r.branch} (${r.ahead === "no-upstream" ? "no upstream" : `${r.ahead} ahead`})`);
    // `planned.*` are INTENTS, and the wording says so — never print an intent as if it were an outcome.
    p(`- would run: \`${r.planned.installArgv.join(" ")}\``);
    p(`- would back up to: ${r.planned.backupPath || "(none)"}`);
    p(`- would stage: ${r.planned.wouldStage.length > 0 ? r.planned.wouldStage.join(", ") : "(none)"}`);
    p(`- would commit: ${r.planned.wouldCommit ? "yes" : "no"}`);
    p(`- would push: ${r.planned.wouldPush ? "yes" : "no"}`);
    // The one OUTCOME line, printed only when a backup was actually written (2.3/FR-7). Kept visually
    // distinct from the `would back up to:` intent above it: an operator reversing an install needs to
    // know which of the two is a real path on disk, and conflating them is how a restore targets nothing.
    if (r.backupPath !== undefined) p(`- backed up to: ${r.backupPath}`);
    if (r.reason !== undefined) p(`- reason: ${r.reason}`);
    p();
  }
  const failed = results.filter((r) => r.status === "failed").length;
  p(`${results.length} repo(s) planned · ${failed} failed · mode: ${mode}`);

  deps.report.print(`${toString()}\n`);
}
