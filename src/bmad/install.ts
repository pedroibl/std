// `std bmad install` — the install command (Story 2.2 landed the SCAFFOLD; Story 2.3 fills the body).
//
// WHAT 2.3 ADDS: the whole-run module guard (FR-6), the ONE staging-path computation the run threads
// everywhere (BM-12), the `--apply`-only materialization of the filtered custom-source, and the final
// FR-8 install rule. The command's SHAPE — parse, select, batch, render, exit — is 2.2's and is
// unchanged; nothing here re-registers a command (`cli.ts` already routes `install`).
//
// BM-15: the leg is built HERE and passed DOWN. The pipeline never authors a `bmad` argv, so the install
// rule and the update rule cannot leak into each other.
//
// THE ORDER IN `runBmadInstall` IS THE SAFETY CONTRACT, not a style choice — see its doc comment.
//
// D4 identity-free: no binary path, no repo path, no state-home literal. `bmadBin`, `estateModulePath`
// and `backupRoot` all arrive resolved on `deps`; the only literals are `bmad install`'s own flag names.

import { hasFlag } from "../core/index";
import { batchExit, renderBatch, runBatch } from "./batch";
import type { BmadDeps, InstallLeg } from "./deps";
import { materializeStaging, moduleGuard, stagingPathFor } from "./estate-source";
import { DEFAULT_TOOLS, loadManifest, selectRepos } from "./manifest";
import { parseBmadOpts } from "./opts";

/**
 * The FR-8 install rule (BM-15), closing over the run's single staging directory.
 *
 * THE ARGV IS FROZEN, and its first six-and-a-half tokens are byte-identical to the Epic-0 proof that
 * demonstrated a real dual-surface install (`dual-surface-proof.test.ts`):
 *
 *     bmad install --directory <repo> --modules core --custom-source <staging> --tools <a,b> --yes
 *
 * `--custom-source` is the CLOSED-OVER `stagingDir`, never a `ctx` field. `stagingPathFor` embeds
 * `deps.clock()`, so re-deriving it in here would, under the production clock, point the installer at a
 * directory `materializeStaging` never wrote — while every fixed-clock test still passed. Taking it as a
 * parameter makes the single computation structural.
 *
 * `ctx.deps` is deliberately NOT read: this rule needs no resolved path beyond the one it closed over,
 * and `buildArgv` runs before the `--apply` gate.
 *
 * `--set` is appended AFTER the frozen tokens, and only when the operator passed one. 2.2 parses
 * `--set m.k=v` and documents it as "passed through to bmad"; dropping it here would leave a parsed,
 * documented flag silently ignored, which is worse than not offering it. With no `--set` the argv is
 * exactly the frozen string.
 */
export function installLeg(stagingDir: string): InstallLeg {
  return {
    kind: "install",
    buildArgv: (ctx) => [
      "install",
      "--directory",
      ctx.repo.path,
      "--modules",
      "core",
      "--custom-source",
      stagingDir,
      // `--tools` is the RUN-level override; absent, it falls back to 2.1's `DEFAULT_TOOLS` (FR-4).
      // Imported, never re-declared: a second copy of the pair is exactly the AD-2 divergence where the
      // installer ships one toolset while the Manifest loader defaults to another.
      "--tools",
      (ctx.opts.tools ?? DEFAULT_TOOLS).join(","),
      "--yes",
      ...ctx.opts.set.flatMap((s) => ["--set", `${s.module}.${s.key}=${s.value}`]),
    ],
  };
}

/**
 * Run `std bmad install [flags]`. Dry-run by default; `--apply` gates every effect, and `--push` is
 * separate. Returns the family exit code: 0 ok/skip, 1 any repo failed.
 *
 * THE STEP ORDER IS THE CONTRACT (FR-6/BM-4/BM-12):
 *
 *   1. parse + select        — a bad flag or unknown repo fails loud before anything else happens.
 *   2. moduleGuard           — BOTH modes. Read-only, repo-invariant, and ABOVE the batch: a half-family
 *                              estate must abort before repo #1 is backed up, and a dry run must surface
 *                              that half-family just as loudly while writing nothing.
 *   3. stagingPathFor        — EXACTLY ONCE. See {@link installLeg}.
 *   4. materializeStaging    — `--apply` only. The first write of the run.
 *   5. runBatch              — sequential, fault-isolated (BM-16/FR-15).
 *   6. render + exit         — composes 2.2's shared `renderBatch`/`batchExit`.
 *
 * A `ManifestError` (missing file, bad entry, unknown `--repos`, malformed `--set`) or a `BmadError`
 * (incomplete estate module, illegal `--skills` value) propagates out of here; `runBmad` catches both
 * and maps them to exit 1 in one place. Neither is flattened into a `RepoResult` — they are whole-run
 * faults, and reporting them per-repo would imply the other repos were fine.
 *
 * `--json` is read straight off the argv rather than becoming a `BmadOpts` field: it is a RENDER choice,
 * not a run option, and nothing below the render layer should be able to branch on it.
 */
export async function runBmadInstall(argv: string[], deps: BmadDeps): Promise<number> {
  const opts = parseBmadOpts(argv);
  // The read goes through the seam (`deps.fs`), so a test injects a fake manifest without touching
  // the machine owner's real `~/.config/std/estate.toml` (BM-7).
  const repos = selectRepos(loadManifest({ manifestPath: deps.manifestPath, fs: deps.fs }), opts);

  // FR-6, whole-run precondition. Returns the RESOLVED estate directory names — resolving the operator's
  // `--skills` tokens once, here, is what keeps the guard and the staging descriptor naming one set.
  const skills = moduleGuard(deps, opts.skills);

  const stagingDir = stagingPathFor(deps);
  if (opts.apply) materializeStaging(deps, skills, stagingDir);

  const results = await runBatch(repos, installLeg(stagingDir), opts, deps);
  renderBatch("install", results, opts, deps, hasFlag(argv, "json"));
  return batchExit(results);
}
