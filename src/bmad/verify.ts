// `std bmad verify` — the standalone verification command (Story 2.6, FR-16/FR-15; BM-10/BM-16/BM-5).
//
// READ-ONLY WITHOUT A FLAG (NFR-5), and that is the whole point of the command. There is no `--apply`
// gate here because there is nothing to gate: the run issues `diff` (external, read-only), `deps.fs`
// reads, and 2.4's read-only `readGitPosture` (`rev-parse`/`rev-list`). {@link VerifyOpts} deliberately
// does NOT carry `apply` — passing `--apply` to `std bmad verify` changes nothing, and the field's
// absence is what makes "nobody can add a mutation gate without first widening the type" structural
// rather than a comment. Do not add one.
//
// THE PIPELINE FILTER IS A DIFFERENT THING. `pipeline.ts` calls the same {@link verifyRepo} engine inside
// its `if (opts.apply)` branch, so during an INSTALL the verification runs only under `--apply`. That is
// correct: in dry-run nothing has been installed yet, and diffing a pre-install tree would manufacture
// drift. The mode-independent path is this command.
//
// WHY THIS HAND-ROLLS ITS BATCH LOOP instead of calling 2.2's `runBatch` (a recorded deviation from
// BM-16's letter): `runBatch` delegates to `runRepoPipeline`, whose chain is
// `guard → backup → leg → verify → stage → commit → push`, and it requires an `InstallLeg`. A read-only
// command has no leg, and inventing a stub one would either be a lie (a `buildArgv` nobody executes) or
// drag backup and the installer into a command that must not write. BM-16's SEMANTICS are preserved
// exactly — sequential, Manifest declaration order, per-repo isolation, the loop continues past a
// failure, rows appended in order — and BM-5's boundary is preserved by exiting through 2.2's own
// `batchExit`. Nothing is re-rolled but the `for…of`.
//
// LAYERING: this module sits beside `install.ts`/`update.ts`/`deploy.ts` (it imports `./batch`, which
// imports `./pipeline`). The ENGINE lives one layer down in `bmad-verify.ts`, which `pipeline.ts`
// imports — keeping the two apart is what makes the slice a DAG. Importing `./cli` from anywhere in
// here re-forms the cycle `check:dep-root` rejects; `parseBmadOpts` lives in `./opts`.
//
// D4 identity-free: no repo, module or machine path literal — everything arrives via `deps` or the
// Manifest entry.

import { hasFlag } from "../core/index";
import { batchExit } from "./batch";
import { renderVerifyFindings, verifyRepo, BmadVerifyError, type VerifyFinding } from "./bmad-verify";
import type { BmadDeps, PlanProjection, RepoResult } from "./deps";
import { readGitPosture } from "./git-safety";
import { loadManifest, ManifestError, repoName, selectRepos } from "./manifest";

/**
 * The slice of `BmadOpts` a verify run reads. A structural SUBSET, declared here rather than imported:
 * a `BmadOpts` satisfies it, so `cli.ts` passes `parseBmadOpts(rest)` straight in with no cast.
 *
 * `apply`, `push` and `forceTrack` are absent BY DESIGN (NFR-5) — see this module's header.
 */
export interface VerifyOpts {
  /** `--repos a,b` — absent ⇒ the whole Manifest minus `source-only` (2.1's `selectRepos`). */
  repos?: string[];
  /** The selected skill set (BM-12 default + anything `--skills` added). The Faithfulness iteration set. */
  skills: string[];
}

/**
 * The honest projection for a command that plans nothing. Built FRESH per repo rather than shared from a
 * module constant — one mutable object referenced by every row is how a later edit to one row silently
 * rewrites the whole ledger.
 *
 * `planned` is required on every `RepoResult` (BM-14) and verify has no plan, so every field is at its
 * literal zero. Making the field optional would weaken 2.2's contract for `install`/`update`/`deploy`,
 * and inventing a `verified`/`findings` field would add a record field this story's AC11 forbids — the
 * divergences travel in `reason`, which 2.2 already declared for exactly this purpose.
 */
function emptyPlan(): PlanProjection {
  return { installArgv: [], backupPath: "", wouldStage: [], wouldCommit: false, wouldPush: false };
}

/** One repo's row plus the findings behind it, so the renderer can name divergences per repo (FR-15). */
interface VerifiedRepo {
  result: RepoResult;
  findings: VerifyFinding[];
}

/**
 * Run `std bmad verify [--repos a,b] [--skills x] [--json]`. Returns **0** (nothing diverged) or **1**
 * (at least one repo failed) — the family's exit contract (BM-1). `2` is unreachable here BY
 * CONSTRUCTION: `2` is the usage code and `verify` has no required argument, so the only `2` in this
 * family comes from `runBmad`'s unknown-subcommand handler.
 *
 * NEITHER GATE APPLIES TO VERIFY, and both omissions are deliberate:
 *   - `claudeTracked:false` (BM-17) — an installed-but-not-committed repo is still installed, so it is
 *     still verified. Adding `if (!repo.claudeTracked) continue` here would leave the estate's
 *     working-copy-only repos permanently unverified.
 *   - `role:'source-only'` (BM-11) — excluded from the DEFAULT set by 2.1's `selectRepos` and from the
 *     COMMIT loop by 2.4. Verify is neither, so an explicitly `--repos`-named source-only repo IS
 *     verified. Reading it is not operating on it.
 *
 * `--json` is read straight off the argv rather than becoming a `VerifyOpts` field, matching `install`:
 * it is a RENDER choice, and nothing below the render layer should be able to branch on it.
 */
export async function runBmadVerify(
  opts: VerifyOpts,
  argv: string[],
  deps: BmadDeps,
): Promise<number> {
  // MANIFEST/SELECTOR RESOLUTION, before any repo. `loadManifest`/`selectRepos` throw 2.1's
  // `ManifestError` — a missing or unparseable manifest, a `[[repos]]`-less file, a row missing a
  // required field, or an unknown `--repos` name. 2.1 declares the mapping as exit 1, and catching it
  // HERE (rather than leaning on `runBmad`'s catch) is what lets a caller invoke `runBmadVerify`
  // directly and get a code back instead of a throw. Anything else re-throws: an unclassified fault
  // must surface, never be flattened into an exit code.
  let repos;
  try {
    repos = selectRepos(loadManifest({ manifestPath: deps.manifestPath, fs: deps.fs }), opts);
  } catch (err) {
    if (err instanceof ManifestError) {
      deps.report.log(`✗ ${err.message}`);
      return 1;
    }
    throw err;
  }

  const verified: VerifiedRepo[] = [];
  for (const repo of repos) {
    let findings: VerifyFinding[];
    try {
      findings = await verifyRepo(repo.path, opts.skills, deps.estateModulePath, deps);
    } catch (err) {
      // A `diff` that could not run (exit ≥2, including 127/124) aborts THIS repo and only this repo —
      // the fault becomes its `failed` row and the loop continues, so a twelve-repo estate with one
      // broken entry reports eleven verified repos and one named failure (FR-15/BM-16). Without this
      // catch the throw escapes and the batch dies at repo #1.
      if (!(err instanceof BmadVerifyError)) throw err;
      findings = [{ severity: "error", id: "verify", message: err.message }];
    }

    const errors = findings.filter((f) => f.severity === "error");
    // Read-only posture (2.4). Safe here for the same reason it is safe in dry-run: `rev-parse` and
    // `rev-list` mutate nothing.
    const posture = readGitPosture(repo, deps);
    const result: RepoResult = {
      repo: repoName(repo),
      status: errors.length > 0 ? "failed" : "ok",
      branch: posture.branch,
      ahead: posture.ahead,
      planned: emptyPlan(),
      // OUTCOMES — `[]`/`false`/`false` always, by construction. Verify stages, commits and pushes nothing.
      stagedPaths: [],
      committed: false,
      pushed: false,
    };
    // The joined messages, so `reason` NAMES the diverging files. Never a count and never a boolean:
    // the operator's next action is to open the path this string carries.
    if (errors.length > 0) result.reason = errors.map((f) => f.message).join("; ");

    verified.push({ result, findings });
  }

  renderVerify(verified, deps, hasFlag(argv, "json"));
  return batchExit(verified.map((v) => v.result));
}

/**
 * Render the run through the `deps.report` seam (BM-7/AC6). No `console.*` anywhere: human markdown goes
 * through `deps.report.print` and the machine payload through `emitJson`, so the whole output path stays
 * injectable and a test can prove nothing escaped it.
 *
 * The JSON envelope matches `renderBatch`'s `{command, mode, repos}` shape so a consumer parses one
 * ledger form across the family. `mode` is the literal `"read-only"` — verify has no dry-run/apply axis
 * to report, and printing `"dry-run"` would imply an `--apply` that does something.
 */
function renderVerify(verified: readonly VerifiedRepo[], deps: BmadDeps, json: boolean): void {
  const results = verified.map((v) => v.result);

  if (json) {
    deps.report.emitJson({ command: "verify", mode: "read-only", repos: results });
    return;
  }

  const { p, toString } = deps.report.lines();
  p("# bmad verify — READ-ONLY");
  p();
  if (verified.length === 0) p("_No repos selected._");
  for (const { result, findings } of verified) {
    p(`## ${result.repo} — ${result.status}`);
    p();
    p(`- branch: ${result.branch} (${result.ahead === "no-upstream" ? "no upstream" : `${result.ahead} ahead`})`);
    p();
    // The fixed line format, and the per-repo tally it suppresses when clean.
    for (const line of renderVerifyFindings(findings)) p(line);
    p();
  }
  const failed = results.filter((r) => r.status === "failed").length;
  p(`${results.length} repo(s) verified · ${failed} failed`);

  deps.report.print(`${toString()}\n`);
}
