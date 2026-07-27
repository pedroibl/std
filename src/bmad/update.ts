// `std bmad update` — the update command (Story 2.2 lands the SCAFFOLD; Story 2.5 fills the body).
//
// Same shape as `install.ts` by design and DIFFERENT in exactly one place: the LEG (BM-15). Story 2.5
// replaces `UPDATE_LEG.buildArgv` with the real update rule (FR-9 — the module `--custom-source` plus
// the core/bmm `quick-update`), and touches nothing else in this file. That one-place divergence is the
// whole reason the leg is a parameter rather than a branch inside the pipeline.
//
// See `install.ts`'s header for why this file lands a story before its body (the shared-file hazard).

import { hasFlag } from "../core/index";
import { batchExit, renderBatch, runBatch } from "./batch";
import type { BmadDeps, InstallLeg } from "./deps";
import { loadManifest, selectRepos } from "./manifest";
import { parseBmadOpts } from "./opts";

/**
 * The update rule (BM-15). **PROVISIONAL in 2.2 — finalized in Story 2.5** (FR-9: the module
 * `--custom-source` leg plus core/bmm `quick-update`). `kind: 'update'` is already honest, so the
 * pipeline and the render distinguish an update run from an install run today.
 */
const UPDATE_LEG: InstallLeg = {
  kind: "update",
  buildArgv: (ctx) => [
    "update",
    "--directory",
    ctx.repo.path,
    ...ctx.opts.set.flatMap((s) => ["--set", `${s.module}.${s.key}=${s.value}`]),
  ],
};

/**
 * Run `std bmad update [flags]`. Dry-run by default; `--apply` gates every effect (none exists yet in
 * 2.2), `--push` separate. Returns 0 ok/skip, 1 if any repo failed. A Manifest fault throws
 * `ManifestError` and the router maps it to exit 1.
 */
export async function runBmadUpdate(argv: string[], deps: BmadDeps): Promise<number> {
  const opts = parseBmadOpts(argv);

  // PROVISIONAL-LEG FENCE — remove in Story 2.5, which authors the real update leg.
  // Story 2.3 made the shared pipeline actually shell the installer (BM-4: ONE per-repo filter chain),
  // which silently promoted `update --apply` from a no-op into a REAL estate-wide mutation running
  // 2.2's placeholder rule — no module guard, no materialized staging. `--apply` is fenced rather than
  // the pipeline branched on `leg.kind`; dry-run stays fully useful and still prints the exact argv.
  if (opts.apply) {
    deps.report.log(
      "std bmad update: --apply is not available yet — the update leg is provisional (Story 2.5).\n" +
        "Run without --apply to see the plan.",
    );
    return 2;
  }

  const repos = selectRepos(loadManifest({ manifestPath: deps.manifestPath, fs: deps.fs }), opts);
  const results = await runBatch(repos, UPDATE_LEG, opts, deps);
  renderBatch("update", results, opts, deps, hasFlag(argv, "json"));
  return batchExit(results);
}
