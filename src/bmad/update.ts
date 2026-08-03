// `std bmad update` — the update command (Story 2.2 landed the SCAFFOLD; Story 2.5 fills the body).
//
// THE DELIVERABLE IS THE ASYMMETRY, NOT THE COMMAND. `update` is `install`'s pipeline with a different
// LEG (BM-4: commands differ ONLY in `leg`). It COMPOSES 2.3's module-guard / backup / staging /
// idempotency digest, 2.4's scoped-stage / commit / push gate and 2.6's verify filter, and
// re-implements none of them. What is genuinely new is exactly two things:
//
//   1. the leg emits TWO `bmad` invocations per repo instead of one, and
//   2. those two are DELIBERATELY NOT SYMMETRIC (FR-9):
//        · the MODULE leg carries `--custom-source` and `--action update`
//        · the BUILT-IN leg carries `--action quick-update` and NO `--custom-source`
//
// WHY THE ASYMMETRY EXISTS — `quick-update` HAS A BLIND SPOT, and this is measured, not assumed. Verified
// end to end against the real `bmad` 6.10.0 binary in a disposable repo: with a local estate-module edit
// pending, `bmad install --modules core,bmm --action quick-update --yes` exits 0, reports "Quick update
// complete!", and propagates the edit to the target ZERO times — the installed Surface file still holds
// the pre-edit bytes. Re-running with `--custom-source <staging> --action update` propagates it. So a
// `update` built on `quick-update` alone would report success estate-wide while silently shipping
// nothing, which is precisely the failure FR-9 exists to forbid.
//
// `quick-update` IS NOT A SUBCOMMAND — re-probed at dev time against 6.10.0, whose `bmad --help` lists
// exactly `install | status | uninstall | help`, and whose `bmad install --help` documents
// `--action <type>  Action type for existing installations: install, update, or quick-update`. Both legs
// are therefore `bmad install …` invocations. A `["quick-update", …]` argv exits 2/usage.
//
// D4 identity-free: no binary path, no repo path, no state-home literal — `bmadBin`, `estateModulePath`
// and `backupRoot` all arrive resolved on `deps`; the only literals are `bmad install`'s own flag names
// and the built-in module names, which are bmad's vocabulary, not a consumer's identity.

import { join } from "node:path";

import { hasFlag } from "../core/index";
import { batchExit, renderBatch, runBatch } from "./batch";
import type { BmadDeps, InstallLeg } from "./deps";
import { materializeStaging, moduleGuard, stagingPathFor } from "./estate-source";
import { DEFAULT_TOOLS, loadManifest, selectRepos } from "./manifest";
import { parseBmadOpts } from "./opts";

/**
 * The file every installed BMAD module carries at its root. It is the MODULE MARKER — the discriminator
 * that separates a module directory from `_bmad/`'s bookkeeping directories.
 *
 * A POSITIVE MARKER, deliberately, not a denylist of known non-modules. Measured 2026-08-03 across the
 * real estate: the 8 modules in use (`automator bmb bmm cis core gds tea wds`) all carry `config.yaml`;
 * the bookkeeping dirs (`_config`, `custom`, `scripts`) all lack it. So does `render`, which a fresh
 * `bmad install` creates and which appears in NO estate repo — the exact entry a hand-maintained denylist
 * would have missed on the day it was written. A denylist rots the moment `bmad` adds a directory; a
 * marker cannot.
 */
const MODULE_MARKER = "config.yaml";

/**
 * Every built-in module actually installed in `repoPath` (AC3, BM-18, **BM-18.1**).
 *
 * ENUMERATED FROM DISK, NEVER INTERSECTED WITH A LITERAL. This function previously filtered a closed
 * `["core","bmm"]` constant, so it answered *"which of core and bmm are present"* rather than *"which
 * built-ins are present"* — and BM-18's measured semantics (`--action update` treats `--modules` as the
 * set that SHOULD EXIST) then **deleted every module it could not name**. Measured on the real estate
 * 2026-08-03: all 9 repos would have lost 2–5 modules each, 8 distinct modules at risk. An allowlist is
 * a hardcoded set wearing a probe's clothing, which BM-18's own rule forbids by name — *"never a
 * constant, never carried forward from another repo, never inherited from a planning document."*
 *
 * DETERMINISTIC ORDER, AND `core` LEADS. `deploy`'s byte-identity assertion against `update` (BM-18)
 * compares recorded argv, and `readdir` order is a filesystem detail rather than a contract — so an
 * unsorted probe puts that assertion at the filesystem's mercy. A plain `.sort()` would fix that but
 * would also emit `bmm,core` where every frozen argv in this slice reads `core,bmm`. `--modules` is a
 * SET, so the reordering is almost certainly inert to `bmad` — and "almost certainly" is not a standard
 * this rule gets to use, because being wrong here deletes modules from disk. Keeping `core` first is
 * free, so the value stays byte-identical to the shipped shape and no merged assertion has to be
 * rewritten to accommodate a helper.
 *
 * Naming an ABSENT built-in is the opposite hazard and is still prevented: enumeration cannot invent a
 * directory, so a repo deliberately running `core` alone never acquires `bmm` from an update.
 *
 * A READ, and therefore legal on the dry-run path: `buildPlan` already reads the filesystem through the
 * seam (`presentScopedPaths`), and FR-5's guarantee is that a dry run performs no WRITE and no subprocess.
 *
 * Closed over by {@link updateLeg} rather than reached through `ctx.deps`. `LegCtx.deps` is deliberately
 * narrowed to the resolved-VALUE members (2.2's `LegDeps`, and the runtime guard in `cli-dryrun.test.ts`
 * asserts the effect surface is absent from it) — that narrowing exists because `buildArgv` runs BEFORE
 * the `--apply` gate, and it is worth keeping. Handing the leg a single read-only probe function it can
 * call, instead of widening `LegDeps` to carry an `fs` slice, keeps the guard intact and keeps the reach
 * reviewable in one place: this function is the only filesystem the leg can touch.
 */
export function presentBuiltins(repoPath: string, deps: BmadDeps): string[] {
  const root = join(repoPath, "_bmad");
  const found = deps.fs
    .listDirs(root)
    .filter((name) => deps.fs.exists(join(root, name, MODULE_MARKER)))
    .sort();
  // `core` first, then the rest alphabetically — see the ordering note above.
  return found.includes("core") ? ["core", ...found.filter((m) => m !== "core")] : found;
}

/**
 * The FR-9 update rule (BM-15) — TWO invocations per repo, closing over the run's single staging dir.
 *
 * `--custom-source` is the CLOSED-OVER `stagingDir` — BM-12's materialized FILTERED staging tree, never
 * `deps.estateModulePath`. Pointing it at the unfiltered module would ship whatever that module's
 * `marketplace.json` array happens to name (the array IS the install gate, Epic-0-proven), defeating
 * `--skills` entirely. `stagingPathFor` embeds `deps.clock()`, so re-deriving it in here would, under
 * the production clock, point the installer at a directory `materializeStaging` never wrote — while
 * every fixed-clock test still passed. Taking it as a parameter makes the single computation structural.
 *
 * ORDER IS LOAD-BEARING: BUILT-IN FIRST, MODULE LAST. `bmad install` regenerates `_bmad/_config/
 * manifest.yaml`, `skill-manifest.csv`, `config.toml` and `bmad-help.csv` by design, and only the module
 * invocation knows about the custom source. A built-in-only regeneration running LAST could re-derive
 * those manifests from the built-in modules alone and drop the estate skills' entries. Running the module
 * leg last also means the state 2.6's verify filter inspects is the state the module leg produced.
 * No planning document mandates either order; this is 2.5's judgment call, recorded here.
 *
 * ⚠ BOTH INVOCATIONS PASS THE SAME PROBED `--modules` SET, AND THAT IS A CORRECTION TO THE FROZEN
 * EPIC-0 ARGV — MEASURED, NOT PREFERRED. The frozen install shape passes `--modules core`. Running the
 * module leg LAST with `--modules core` against a repo holding `core` AND `bmm` **DELETES `_bmad/bmm`
 * from disk**: verified against 6.10.0, where `bmad status` afterwards lists `core` alone and the `bmm`
 * directory is gone. `--action update` treats the `--modules` set as the set that should EXIST, not as a
 * set to add to. So the module leg must name every built-in that has to survive it. The degenerate case
 * — a repo with no built-in installed at all — falls back to `core`, the frozen default, because the
 * estate module still needs a host module to render alongside.
 */
export function updateLeg(stagingDir: string, builtinsOf: (repoPath: string) => string[]): InstallLeg {
  return {
    kind: "update",
    buildArgv: (ctx) => {
      const tools = (ctx.opts.tools ?? DEFAULT_TOOLS).join(",");
      // `--set` rides BOTH invocations, exactly as 2.3's install leg appends it: 2.2 parses and
      // documents the flag, and honoring it on only one half of an update would apply an operator's
      // setting to the built-ins and not the estate module (or the reverse) with nothing to say so.
      const setFlags = ctx.opts.set.flatMap((s) => ["--set", `${s.module}.${s.key}=${s.value}`]);
      const present = builtinsOf(ctx.repo.path);
      // See the ⚠ above: the set that must survive the run, never a hardcoded `core,bmm`.
      const modules = present.length > 0 ? present.join(",") : "core";

      const argv: string[][] = [];

      // ── invocation 1 — BUILT-IN: the `quick-update` fast path ────────────────────────────────────
      // NO `--custom-source`, and that ABSENCE is the point: it is exactly the blind spot the module
      // leg below exists to cover, and the regression guard in `update.test.ts` asserts it is absent.
      // Adding one here would make that guard vacuous. Skipped entirely when no built-in is installed —
      // there is nothing to quick-update, and naming an absent module would install it.
      if (present.length > 0) {
        argv.push([
          "install",
          "--directory",
          ctx.repo.path,
          "--modules",
          modules,
          "--action",
          "quick-update",
          "--tools",
          tools,
          "--yes",
          ...setFlags,
        ]);
      }

      // ── invocation 2 — MODULE: the update rule proper ────────────────────────────────────────────
      // The full `--custom-source` at BM-12's filtered staging dir, plus `--action update` (NOT
      // `--action install`, which means "treat as fresh", and NOT `quick-update`, which is the blind
      // spot). `update` is the semantic that re-reads the custom source. LAST, so it has the final word
      // on the regenerated manifests.
      argv.push([
        "install",
        "--directory",
        ctx.repo.path,
        "--modules",
        modules,
        "--custom-source",
        stagingDir,
        "--tools",
        tools,
        "--action",
        "update",
        "--yes",
        ...setFlags,
      ]);

      return argv;
    },
  };
}

/**
 * Run `std bmad update [flags]` (FR-9/FR-10). Dry-run by default; `--apply` gates every effect, and
 * `--push` is separate and never implied. Returns the family exit code: 0 ok/skip, 1 any repo failed.
 *
 * THE STEP ORDER IS THE CONTRACT, and it is deliberately `runBmadInstall`'s order (BM-4 — the two
 * commands differ only in their leg):
 *
 *   1. parse + select        — a bad flag or unknown repo fails loud before anything else happens.
 *   2. moduleGuard           — BOTH modes. Read-only, repo-invariant, and ABOVE the batch: a half-family
 *                              estate must abort before repo #1 is backed up, and a dry run must surface
 *                              that half-family just as loudly while writing nothing.
 *   3. stagingPathFor        — EXACTLY ONCE. See {@link updateLeg}.
 *   4. materializeStaging    — `--apply` only, so a dry run never creates the staging dir even though
 *                              the plan it prints names that path (the plan is INTENT, BM-14).
 *   5. runBatch              — sequential, fault-isolated (BM-16/FR-15).
 *   6. render + exit         — composes 2.2's shared `renderBatch`/`batchExit`.
 *
 * A `ManifestError` (missing file, bad entry, unknown `--repos`, malformed `--set`) or a `BmadError`
 * (incomplete estate module, illegal `--skills` value, an unusable `marketplace.json` out of
 * `materializeStaging`) propagates out of here; `runBmad` catches both and maps them to exit 1 in ONE
 * place. Neither is caught locally and neither is flattened into a `RepoResult` — they are whole-run
 * faults raised before any repo is touched, and reporting them per-repo would imply the others were fine.
 * A raw fs fault (`EACCES`/`ENOSPC` out of the staging write) is neither, so it propagates all the way
 * out as the real bug it is rather than being mapped to a tidy exit code.
 *
 * THE FENCE 2.3 PUT HERE IS GONE, and its two tripwire tests went with it in the same commit. It made
 * `--apply` return exit 2 while the leg was 2.2's placeholder; the leg below is the real one.
 */
export async function runBmadUpdate(argv: string[], deps: BmadDeps): Promise<number> {
  const opts = parseBmadOpts(argv);
  // The read goes through the seam (`deps.fs`), so a test injects a fake manifest without touching
  // the machine owner's real `~/.config/std/estate.toml` (BM-7).
  const repos = selectRepos(loadManifest({ manifestPath: deps.manifestPath, fs: deps.fs }), opts);

  // FR-6, whole-run precondition. Returns the RESOLVED estate directory names — resolving the operator's
  // `--skills` tokens once, here, is what keeps the guard and the staging descriptor naming one set.
  const skills = moduleGuard(deps, opts.skills);

  const stagingDir = stagingPathFor(deps);
  if (opts.apply) materializeStaging(deps, skills, stagingDir);

  const leg = updateLeg(stagingDir, (repoPath) => presentBuiltins(repoPath, deps));
  const results = await runBatch(repos, leg, opts, deps);
  renderBatch("update", results, opts, deps, hasFlag(argv, "json"));
  return batchExit(results);
}
