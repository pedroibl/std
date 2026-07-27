// `std bmad deploy` — the deploy command (Story 2.2 lands the SCAFFOLD; Story 2.7 fills the body).
//
// Deploy composes the leg ACROSS the Manifest (FR-17) rather than applying one fixed rule per repo, so
// 2.7's change is larger than 2.5's: it will likely compose or select a leg per repo. What 2.2 fixes now
// is that it still reports in the SAME `RepoResult` ledger, exits by the SAME rule, and passes through
// the SAME apply gate — a deploy cannot invent its own dry-run semantics.
//
// See `install.ts`'s header for why this file lands a story before its body (the shared-file hazard).

import { hasFlag } from "../core/index";
import { batchExit, renderBatch, runBatch } from "./batch";
import type { BmadDeps, InstallLeg } from "./deps";
import { loadManifest, selectRepos } from "./manifest";
import { parseBmadOpts } from "./opts";

/**
 * The deploy rule (BM-15). **PROVISIONAL in 2.2 — finalized in Story 2.7** (FR-17: compose the leg
 * across the Manifest). `kind` is `'install'` because {@link InstallLeg} admits only `install`/`update`
 * and a deploy materializes an install into each target; 2.7 revisits that if the composed rule needs
 * a third kind — which is a spine change (BM-15), not a local one.
 */
const DEPLOY_LEG: InstallLeg = {
  kind: "install",
  buildArgv: (ctx) => [
    "install",
    "--directory",
    ctx.repo.path,
    ...ctx.opts.set.flatMap((s) => ["--set", `${s.module}.${s.key}=${s.value}`]),
  ],
};

/**
 * Run `std bmad deploy [flags]`. Dry-run by default; `--apply` gates every effect (none exists yet in
 * 2.2), `--push` separate. Returns 0 ok/skip, 1 if any repo failed. A Manifest fault throws
 * `ManifestError` and the router maps it to exit 1.
 */
export async function runBmadDeploy(argv: string[], deps: BmadDeps): Promise<number> {
  const opts = parseBmadOpts(argv);
  const repos = selectRepos(loadManifest({ manifestPath: deps.manifestPath, fs: deps.fs }), opts);
  const results = await runBatch(repos, DEPLOY_LEG, opts, deps);
  renderBatch("deploy", results, opts, deps, hasFlag(argv, "json"));
  return batchExit(results);
}
