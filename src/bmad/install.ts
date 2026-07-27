// `std bmad install` — the install command (Story 2.2 lands the SCAFFOLD; Story 2.3 fills the body).
//
// WHAT 2.2 LANDS: the command's shape — parse flags, resolve the repo set, author the install LEG,
// run the batch, render, exit. Everything the family shares is already wired, so 2.3's whole job is
// inside `INSTALL_LEG.buildArgv` and the pipeline's filter bodies. Nothing else in this file moves.
//
// WHY THE FILE EXISTS A STORY EARLY (the shared-file hazard): if 2.3 had to CREATE and REGISTER this
// command, it would re-touch `src/cli/main.ts` and the `runBmad` router — files 2.5/2.6/2.7 also touch.
// Landing the scaffold now means each later story EXTENDS ITS OWN FILE and re-registers nothing.
//
// BM-15: the leg is built HERE and passed DOWN. The pipeline never authors a `bmad` argv, so the install
// rule and the update rule cannot leak into each other.

import { hasFlag } from "../core/index";
import { batchExit, renderBatch, runBatch } from "./batch";
import type { BmadDeps, InstallLeg } from "./deps";
import { loadManifest, selectRepos } from "./manifest";
import { parseBmadOpts } from "./opts";

/**
 * The install rule (BM-15). **PROVISIONAL in 2.2 — finalized in Story 2.3**, which replaces the body
 * with the materialized filtered custom-source (BM-12) and the real `--set` plumbing. It is authored as
 * a real leg rather than a stub so the argv genuinely flows repo → plan → render today.
 */
const INSTALL_LEG: InstallLeg = {
  kind: "install",
  buildArgv: (ctx) => [
    "install",
    "--directory",
    ctx.repo.path,
    ...ctx.opts.set.flatMap((s) => ["--set", `${s.module}.${s.key}=${s.value}`]),
  ],
};

/**
 * Run `std bmad install [flags]`. Dry-run by default; `--apply` gates every effect (none exists yet in
 * 2.2), and `--push` is separate. Returns the family exit code: 0 ok/skip, 1 any repo failed.
 *
 * A Manifest fault (missing file, bad entry, unknown `--repos` name, malformed `--set`) throws
 * `ManifestError` out of here; the `runBmad` router catches it and maps it to exit 1 in one place.
 *
 * `--json` is read straight off the argv rather than becoming a `BmadOpts` field: it is a RENDER choice,
 * not a run option, and nothing below the render layer should be able to branch on it.
 */
export async function runBmadInstall(argv: string[], deps: BmadDeps): Promise<number> {
  const opts = parseBmadOpts(argv);
  // The read goes through the seam (`deps.fs`), so a test injects a fake manifest without touching
  // the machine owner's real `~/.config/std/estate.toml` (BM-7).
  const repos = selectRepos(loadManifest({ manifestPath: deps.manifestPath, fs: deps.fs }), opts);
  const results = runBatch(repos, INSTALL_LEG, opts, deps);
  renderBatch("install", results, opts, deps, hasFlag(argv, "json"));
  return batchExit(results);
}
