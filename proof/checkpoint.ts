#!/usr/bin/env bun
/**
 * checkpoint — Story 12.5 rewrite onto the std substrate (proof/ consumer; live cutover to
 * ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). Inspection and PREVIEW-ONLY rollback CLI for
 * ISC checkpoints. Behavior preserved.
 *
 * Substrate swaps:
 *   - the in-file `gitRun` wrapper → `std/git`. NOTE the benign delta: the source `gitRun` used
 *     `stdio:['ignore','pipe','pipe']` with NO trim and could THROW (carrying stderr detail no caller
 *     ever read); `std/git` uses `stdio:['ignore','pipe','ignore']` + whole-output `.trim()` and
 *     returns `""` on failure. This is behavior-preserving because the only reader (`findCommit`)
 *     reads stdout and re-trims per line — there was never a stderr contract to protect.
 *   - `findCommit` gains an explicit empty-string→null guard (`if (!out) return null;`), replacing the
 *     source's try/catch-throw-to-null, so the fail-soft-to-`null` contract is byte-preserved.
 *   - the state sidecar read (`.checkpoint-state.json`) → `fsx.loadJson`. `loadJson`'s normal contract
 *     softens BOTH "missing" and "unparseable" to its `fallback` — but the source distinguishes them
 *     (missing → silent "no checkpoints recorded", malformed → loud `error: malformed state` + exit 1).
 *     A `MALFORMED` sentinel (compared by reference, never producible by a real `JSON.parse`) recovers
 *     that exact distinction: `loadState` gates on `exists()` first (byte-identical to the source's
 *     `existsSync` guard), then only a `loadJson` result === the sentinel means "file existed but
 *     didn't parse".
 *   - the subcommand dispatch (`switch (sub)`) → `core/args` `positional` + `dispatch`.
 *
 * NOT swapped: the local `truncateDesc` (was `truncate`, renamed to avoid colliding with `std/core`'s
 * export). `std/core`'s `truncate(text,limit)` clips at `limit-3` chars and appends `"..."`; the
 * source clips at `n-1` and appends a single `'…'` character — different cut boundary AND different
 * ellipsis, so swapping would change `cmdList`'s padded-column bytes. Kept local, byte-identical to
 * the source (a considered-but-rejected substrate swap, not an oversight).
 *
 * Kept caller-local (D4): the `~/.claude/checkpoint-repos.txt` + `MEMORY/WORK` path roots, the ISC
 * grep pattern (`${iscId} (${slug}):`), `expandPath`, and the vendored `parseCriteriaList`
 * (`./isa-utils.ts` — the real shared edge dependency stays a relative import in the production tool).
 *
 * Rollback is PREVIEW-ONLY by design (per feedback_no_worktree_isolation_without_consent).
 * {{PRINCIPAL_NAME}} runs the destructive op himself if he wants the rollback.
 *
 * Subcommands:
 *   list <slug>                — show committed ISCs and their last SHAs per repo
 *   show <slug> <isc-id>       — show commit(s) for a specific ISC across allowlist repos
 *   rollback <slug> <isc-id>   — PREVIEW: print the git reset --hard <sha> command per repo
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { dispatch, positional } from "std/core";
import { exists, loadJson, readIfExists, resolveFrameworkDir } from "std/fsx";
import { git } from "std/git";
import { parseCriteriaList } from "./isa-utils";

// ── caller-local identity (D4) ──────────────────────────────────────────────────────────────────────

export interface Paths {
  /** Top of ~/.claude per spec — only ever READ, never written (no ContainmentGuard write concern). */
  allowlist: string;
  workDir: string;
}

export function defaultPaths(home: string = homedir()): Paths {
  return {
    allowlist: join(home, ".claude", "checkpoint-repos.txt"),
    workDir: join(resolveFrameworkDir(home), "MEMORY", "WORK"),
  };
}

// Parser must match the hook's parser exactly: skip blanks and '#' lines, expand tilde / $HOME
// prefixes, treat the rest as absolute repo paths.
export function expandPath(p: string, home: string = homedir()): string {
  let s = p.trim();
  if (!s) return s;
  if (s.startsWith("~/")) s = join(home, s.slice(2));
  else if (s === "~") s = home;
  s = s.replace(/^\$HOME(\/|$)/, home + "$1");
  return s;
}

export function loadAllowlist(paths: Paths, home: string = homedir()): string[] {
  const raw = readIfExists(paths.allowlist);
  if (raw === null) return [];
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => expandPath(l, home));
}

// ── commit lookup (std/git; empty-string→null guard is the byte-preserved fail-soft contract) ───────

export interface CommitHit {
  sha: string;
  date: string;
  subject: string;
}

export function findCommit(repo: string, slug: string, iscId: string): CommitHit | null {
  const grepPattern = `${iscId} (${slug}):`;
  const out = git(repo, ["log", "--all", "-F", "--grep", grepPattern, "--pretty=format:%H\t%ci\t%s", "-n", "1"]);
  if (!out) return null; // fail-soft: covers both a hard git error AND a genuine "no match"
  const line = out.split("\n")[0]?.trim();
  if (!line) return null;
  const [sha, date, ...rest] = line.split("\t");
  return { sha, date, subject: rest.join("\t") };
}

export function slugPaths(paths: Paths, slug: string): { slugDir: string; isaPath: string; statePath: string } {
  const slugDir = join(paths.workDir, slug);
  return {
    slugDir,
    isaPath: join(slugDir, "ISA.md"),
    statePath: join(slugDir, ".checkpoint-state.json"),
  };
}

// ISA-derived ISC descriptions are best-effort: `list` needs them only as a human label and the spec
// explicitly requires `list` to keep working when the ISA is gone (the sidecar state remains
// authoritative for what was committed).
function loadIscDescriptions(isaPath: string): Map<string, string> {
  const map = new Map<string, string>();
  const raw = readIfExists(isaPath);
  if (raw === null) return map;
  try {
    for (const c of parseCriteriaList(raw)) map.set(c.id, c.description);
  } catch {
    // Unreadable / unparseable ISA — descriptions just won't render.
  }
  return map;
}

// ── state sidecar (fsx.loadJson + a reference-sentinel to recover the missing-vs-malformed split) ───

export interface CheckpointState {
  committed_iscs: string[];
  last_commit_sha: Record<string, string>;
}

const MALFORMED = Symbol("checkpoint-state-malformed");

export function loadState(statePath: string): CheckpointState | null {
  if (!exists(statePath)) return null;
  const raw = loadJson<Record<string, unknown> | typeof MALFORMED>(statePath, MALFORMED);
  if (raw === MALFORMED) return null; // file existed but JSON.parse failed
  return {
    committed_iscs: Array.isArray(raw.committed_iscs) ? (raw.committed_iscs as string[]) : [],
    last_commit_sha:
      raw.last_commit_sha && typeof raw.last_commit_sha === "object"
        ? (raw.last_commit_sha as Record<string, string>)
        : {},
  };
}

function truncateDesc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ── commands (console side effects + exit code, matching the OpinionTracker proof-consumer shape) ───

export function cmdList(paths: Paths, slug: string): number {
  const { isaPath, statePath } = slugPaths(paths, slug);
  if (!exists(statePath)) {
    console.log(`no checkpoints recorded for ${slug}`);
    return 0;
  }
  const state = loadState(statePath);
  if (!state) {
    console.error(`error: malformed state at ${statePath}`);
    return 1;
  }
  if (state.committed_iscs.length === 0) {
    console.log(`no checkpoints recorded for ${slug}`);
    return 0;
  }
  const descriptions = loadIscDescriptions(isaPath);

  console.log(`Checkpoints for ${slug}`);
  console.log("─".repeat(80));
  for (const id of state.committed_iscs) {
    const desc = descriptions.get(id) || "(description not in ISA.md)";
    console.log(`${id.padEnd(12)}  ${truncateDesc(desc, 60)}`);
  }
  console.log("");
  console.log("Last committed SHA per repo:");
  const repos = Object.keys(state.last_commit_sha);
  if (repos.length === 0) {
    console.log("  (none)");
  } else {
    for (const repo of repos) console.log(`  ${repo}: ${state.last_commit_sha[repo]}`);
  }
  return 0;
}

export function cmdShow(paths: Paths, slug: string, iscId: string): number {
  const allowlist = loadAllowlist(paths);
  if (allowlist.length === 0) {
    console.error(`no allowlist at ${paths.allowlist}`);
    return 1;
  }
  // Spec output format: one line per matching repo, "<repo>: <sha> <date> <subject>".
  let any = false;
  for (const repo of allowlist) {
    if (!exists(repo)) continue;
    const hit = findCommit(repo, slug, iscId);
    if (!hit) continue;
    any = true;
    console.log(`${repo}: ${hit.sha} ${hit.date} ${hit.subject}`);
  }
  if (!any) console.log(`no commit found for ${iscId} in ${slug}`);
  return 0;
}

export function cmdRollback(paths: Paths, slug: string, iscId: string): number {
  const allowlist = loadAllowlist(paths);
  if (allowlist.length === 0) {
    console.error(`no allowlist at ${paths.allowlist}`);
    return 1;
  }
  // PREVIEW ONLY. Every git verb on the next lines is a printed STRING — there is no git() call to
  // any destructive subcommand anywhere in this function.
  let any = false;
  for (const repo of allowlist) {
    if (!exists(repo)) continue;
    const hit = findCommit(repo, slug, iscId);
    if (!hit) continue;
    any = true;
    console.log(`REPO: ${repo}`);
    console.log(`TARGET: ${hit.sha} (${hit.subject})`);
    console.log("");
    console.log("To roll back to this checkpoint, run:");
    console.log(`  git -C ${repo} reset --hard ${hit.sha}`);
    console.log("");
    console.log(`WARNING: this discards all commits and uncommitted changes after ${hit.sha}.`);
    console.log(`Review with: git -C ${repo} log --oneline ${hit.sha}..HEAD`);
    console.log("");
  }
  if (!any) {
    console.log(`no commit found for ${iscId} in ${slug}`);
    return 0;
  }
  console.log("(no destructive operation performed — review and run the commands above manually)");
  return 0;
}

function usage(paths: Paths): void {
  console.log(`Usage:
  bun checkpoint.ts list <slug>
  bun checkpoint.ts show <slug> <isc-id>
  bun checkpoint.ts rollback <slug> <isc-id>

Allowlist: ${paths.allowlist}
Work dir:  ${paths.workDir}

Rollback is PREVIEW ONLY — prints the suggested git reset command per repo
and exits. No destructive git operation is ever executed by this CLI.`);
}

// ── CLI (positional/dispatch replace the switch(sub); slug/iscId stay plain positional indexing —
// there are no `--flag`s in this CLI's grammar) ───────────────────────────────────────────────────────

export function main(argv: string[] = process.argv.slice(2), paths: Paths = defaultPaths()): number {
  const [, slug, iscId] = argv;
  const command = positional(argv); // argv[0] — none of these tokens start with `--`

  return dispatch(
    command,
    {
      list: () => {
        if (!slug) {
          usage(paths);
          return 1;
        }
        return cmdList(paths, slug);
      },
      show: () => {
        if (!slug || !iscId) {
          usage(paths);
          return 1;
        }
        return cmdShow(paths, slug, iscId);
      },
      rollback: () => {
        if (!slug || !iscId) {
          usage(paths);
          return 1;
        }
        return cmdRollback(paths, slug, iscId);
      },
    },
    (cmd) => {
      usage(paths);
      return cmd === "" ? 0 : 1; // no subcommand at all → 0 (source: `if (!sub) { usage(); exit(0); }`)
    },
  );
}

if (import.meta.main) {
  process.exit(main());
}
