// The estate SOURCE side of `bmad install` (Story 2.3, AC1/AC3/AC4 — FR-6, BM-12/BM-13).
//
// Two jobs, both about the module this package SHIPS (`bmad-estate/`), never about a target repo:
//   1. `moduleGuard` — the FR-6 whole-run precondition. It validates the estate source ONCE, before the
//      batch, and aborts naming the offending skill. It is repo-INVARIANT by construction (nothing here
//      reads a repo), which is exactly why it is hoisted above `runBatch` instead of living in BM-4's
//      per-repo filter chain: a per-repo guard would back up and mutate repo #1 before discovering on
//      repo #2 that the family is half-present. BM-4's per-repo `guard` slot is 2.4's ancestor-conflict
//      and source-only concern, not this.
//   2. `materializeStaging` — the BM-12 filtered custom-source. `bmad install` decides WHAT to install
//      from `marketplace.plugins[0].skills`, NOT from which directories are on disk. That is proven, not
//      assumed: `dual-surface-proof.test.ts` installs the same on-disk tree twice and only the array
//      changes what lands ("the skills array is the gate, the on-disk dir is not"). So the filter is a
//      read-modify-WRITE of that array. Copying `marketplace.json` verbatim and relying on which dirs
//      were copied would leave the default array (jhon+epic) in place, and `--skills dev-the-loop` would
//      silently install nothing new — the default case passing only by accident.
//
// READ-ONLY vs WRITE is the mode split (AC6): `moduleGuard` runs in BOTH dry-run and `--apply`, so a dry
// run still surfaces a half-family truthfully while writing nothing. `materializeStaging` is the write,
// and it runs under `--apply` only.
//
// D1 core purity: a Bun edge — `node:path` is legal here. D4 identity-free: every path is derived from
// the injected `deps`; the only literals are the estate's own layout (`skills/`, `.claude-plugin/`) and
// the product's own skill-name prefix, which are this package's vocabulary, not a consumer's identity.

import { basename, join } from "node:path";

import { walkFiles } from "../fsx/index";
import { BmadError, type BmadDeps } from "./deps";

/** The estate module's skill root, relative to the injected `estateModulePath` (BM-13). */
const SKILLS_DIR = "skills";
/** The plugin descriptor `bmad install` reads to decide what to install (BM-12). */
const MARKETPLACE = join(".claude-plugin", "marketplace.json");

/**
 * The estate's skill-directory naming prefix. `--skills` accepts EITHER the full directory name
 * (`bmad-agent-dev-the-loop`) or the bare loop-family shorthand (`dev-the-loop`), because the flag's
 * documented vocabulary and the on-disk vocabulary differ by exactly this prefix and an operator
 * typing the shorthand must not get a "missing skill" abort for a skill that is right there.
 *
 * Resolution is EXACT-FIRST and fail-loud (see {@link resolveSkillDir}) — never a fuzzy match.
 */
const SKILL_PREFIX = "bmad-agent-";

/**
 * Reject anything that is not a single path segment BEFORE it is joined onto the estate path.
 *
 * `--skills ../../../etc` would otherwise `join` its way out of `<estate>/skills/`, and then both the
 * guard's existence check and the staging copy would happily operate on a tree outside the module. A
 * skill is one directory name; enforcing that here is the whole defense, and it is cheap.
 */
function assertPlainSegment(token: string): void {
  if (token === "" || token === "." || token === ".." || /[/\\]/.test(token)) {
    throw new BmadError(
      `invalid --skills value ${JSON.stringify(token)} — a skill is a single directory name under the ` +
        `estate module's ${SKILLS_DIR}/ (no path separators, no '.' or '..')`,
    );
  }
}

/** The on-disk candidates for a `--skills` token, in precedence order: exact name first, then prefixed. */
function candidateDirs(token: string): string[] {
  return token.startsWith(SKILL_PREFIX) ? [token] : [token, SKILL_PREFIX + token];
}

/**
 * Resolve one `--skills` token to the estate skill DIRECTORY NAME it names, or throw naming the token.
 *
 * Exact match wins over the prefixed form, so a real directory can never be shadowed by the shorthand
 * rule. A token that matches nothing fails loud listing every path that was probed — a "skill not found"
 * with no path is unactionable, and this error is the one an operator sees when the shipped payload is
 * incomplete.
 */
function resolveSkillDir(deps: BmadDeps, token: string): string {
  assertPlainSegment(token);
  const root = join(deps.estateModulePath, SKILLS_DIR);
  const probed = candidateDirs(token).map((name) => join(root, name));
  const found = probed.find((dir) => deps.fs.exists(dir));
  if (found === undefined) {
    throw new BmadError(
      `estate module incomplete: skill "${token}" is missing — probed ${probed.join(" and ")}. ` +
        `Aborting before any repo is touched (FR-6).`,
    );
  }
  return basename(found);
}

/**
 * The FR-6 module guard (AC1) — validate the estate source for EVERY selected skill, once per run,
 * before any repo is backed up or shelled. Read-only: it calls `exists` and enumerates, and writes
 * nothing, which is what lets it run unchanged in dry-run.
 *
 * BOTH half-family shapes abort, and the distinction matters: an ABSENT `skills/<x>` is the obvious
 * case, but a PRESENT-BUT-EMPTY one is the same defect wearing a directory — it would sail past an
 * exists-only check, install a skill with no files, and report `ok`. The first offender throws; later
 * skills are not probed, because the run is over either way and the first name is the actionable one.
 *
 * RETURNS the resolved directory names rather than `void`: the `--skills` token an operator typed and
 * the directory name the marketplace array must carry are not always the same string (see
 * {@link SKILL_PREFIX}), and resolving twice — once to validate, once to stage — is how the two drift.
 * One resolution, threaded, is the same discipline the staging clock uses. The result is de-duplicated
 * (order-stable): `--skills dev-the-loop,bmad-agent-dev-the-loop` names one directory twice, and a
 * duplicate entry in the marketplace array is a malformed descriptor.
 */
export function moduleGuard(deps: BmadDeps, skills: string[]): string[] {
  const resolved: string[] = [];
  for (const token of skills) {
    const dir = resolveSkillDir(deps, token);
    const full = join(deps.estateModulePath, SKILLS_DIR, dir);
    if (walkFiles(full).length === 0) {
      throw new BmadError(
        `estate module incomplete: skill "${token}" is empty at ${full} (the directory exists but ` +
          `contains no files). Aborting before any repo is touched (FR-6).`,
      );
    }
    resolved.push(dir);
  }
  return [...new Set(resolved)];
}

/**
 * Where a run stages its filtered custom-source (BM-8's state home, `--apply` only).
 *
 * Derived as `backupRoot`'s SIBLING rather than added as a sixth resolved path on `BmadDeps`: BM-8
 * defines one state home for this family, and two independently-resolved fields could drift to two
 * different homes with nothing to catch it. One resolution, two uses.
 *
 * IT EMBEDS `deps.clock()`, so it must be called EXACTLY ONCE per run and the result THREADED to both
 * `materializeStaging` and the leg's `--custom-source`. Under the production clock (a live ISO
 * timestamp) a second call returns a different directory, and the installer would be pointed at a
 * staging tree that was never written. A fixed-clock test cannot see that; `install.test.ts` pins it
 * with a MONOTONIC clock instead.
 */
export function stagingPathFor(deps: BmadDeps): string {
  return join(stateHomeOf(deps.backupRoot), "staging", deps.clock());
}

/** `<state>/std/bmad-manager/backups` → `<state>/std/bmad-manager`. Purely lexical; no fs access. */
function stateHomeOf(backupRoot: string): string {
  const cut = Math.max(backupRoot.lastIndexOf("/"), backupRoot.lastIndexOf("\\"));
  return cut > 0 ? backupRoot.slice(0, cut) : backupRoot;
}

/**
 * Materialize the BM-12 filtered custom-source at `stagingDir` (AC3/AC4). `skills` are RESOLVED
 * directory names — {@link moduleGuard}'s return value, never the raw `--skills` tokens.
 *
 * The rewritten `plugins[0].skills` array IS the filter (see the module header). The skill directories
 * are copied too, because the descriptor must not point at paths that are absent from the tree it
 * ships — but copying them is not what selects them.
 *
 * READ AND VALIDATE FIRST, WRITE SECOND. A malformed `marketplace.json` must abort with nothing
 * written: a staging tree that exists but carries a half-built descriptor is worse than none, because
 * the installer would consume it.
 */
export function materializeStaging(deps: BmadDeps, skills: string[], stagingDir: string): void {
  const source = join(deps.estateModulePath, MARKETPLACE);
  const raw = deps.fs.readIfExists(source);
  if (raw === null) {
    throw new BmadError(
      `estate module incomplete: ${MARKETPLACE} not found at ${source} — the shipped payload is ` +
        `unusable as a --custom-source (BM-12).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BmadError(
      `estate module is unusable: ${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Validated rather than assumed: `plugins[0].skills` is the install gate, so an unexpected shape here
  // must fail loud. Assigning into `(parsed as any).plugins[0]` would throw a raw TypeError at best and
  // silently create a key on the wrong object at worst — either way the installer would then ship the
  // default set while the run reported success.
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
  const plugin = Array.isArray(plugins) ? plugins[0] : undefined;
  if (typeof plugin !== "object" || plugin === null) {
    throw new BmadError(
      `estate module is unusable: ${source} has no plugins[0] object — the BM-12 skills array has no home`,
    );
  }
  (plugin as Record<string, unknown>).skills = skills.map((s) => `./${SKILLS_DIR}/${s}`);

  deps.fs.ensureDir(join(stagingDir, ".claude-plugin"));
  deps.fs.atomicWrite(join(stagingDir, MARKETPLACE), `${JSON.stringify(parsed, null, 2)}\n`);
  for (const skill of skills) {
    deps.fs.cpDir(join(deps.estateModulePath, SKILLS_DIR, skill), join(stagingDir, SKILLS_DIR, skill));
  }
}
