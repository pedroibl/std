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
  const repos = selectRepos(loadManifest({ manifestPath: deps.manifestPath, fs: deps.fs }), opts);
  const results = runBatch(repos, UPDATE_LEG, opts, deps);
  renderBatch("update", results, opts, deps, hasFlag(argv, "json"));
  return batchExit(results);
}
