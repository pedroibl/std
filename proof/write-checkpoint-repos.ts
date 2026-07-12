#!/usr/bin/env bun
/**
 * write-checkpoint-repos — Story 12.5 rewrite onto the std substrate (proof/ consumer; live cutover
 * to ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). Discover git repos under dev roots and write
 * the ISC checkpoint allowlist (~/.claude/checkpoint-repos.txt). Behavior preserved.
 *
 * Substrate swaps:
 *   - the in-file `git(repo,args)` wrapper (byte-identical `-C` / 5s timeout / fail-soft `""` / `.trim()`)
 *     is DELETED — `std/git` is imported instead. Every call site (`rev-parse --is-inside-work-tree`,
 *     `branch --show-current`, `remote get-url`, `log -1 --format=%cr`, `status --porcelain`) routes
 *     through the imported `git` unchanged.
 *   - the allowlist write (backup + tmp + rename) → the backup-first `copyFileSync` step is LOAD-BEARING
 *     (it preserves the prior allowlist before an overwrite, and the source's write message points at
 *     the `.bak` file) so it stays a caller-side `copyFileSync` immediately BEFORE `fsx.atomicWrite`,
 *     which then does the identical tmp-write-then-rename (same `.tmp` suffix).
 *   - CLI flags (`--dry-run`/`--merge`/`--dirty`/`--no-annotate`/`--depth`) → `core/args`
 *     (`hasFlag`/`flagValue`).
 *
 * NOT ported to `fsx.walkFiles`: the repo-discovery walk here returns REPO-ROOT DIRECTORIES and stops
 * descending the instant it finds one (so a nested repo/submodule under an already-found repo is never
 * double-counted); `walkFiles` returns FILES and always descends every non-pruned directory — `prune`
 * only excludes subtrees by path, it can't also emit the pruned directory itself as a result. The two
 * shapes don't match, so `walk()` stays a local recursive function, ported near-verbatim from the
 * source. (A `walkDirs`-with-early-stop primitive is a candidate IF a second caller needs the same
 * "find matching dir, don't descend into it" shape — not built speculatively for one caller, D2.)
 * The multi-root positional list (`roots...`) also has no `core/args` equivalent — `positional()`
 * returns only the FIRST non-`--` token — so the roots filter stays local plumbing, same shape as the
 * source's `argv.filter(...)`.
 *
 * Kept caller-local (D4): STAGED/LIVE allowlist paths, DEFAULT_ROOTS/SKIP scan policy, the
 * allowlist-header text, `{{PRINCIPAL_NAME}}`.
 *
 * Rollback safety: this tool only WRITES the allowlist. It never runs a destructive git op —
 * discovery is read-only (readdir + index-only git queries).
 *
 * Usage:
 *   bun write-checkpoint-repos.ts [options] [roots...]
 *
 * Options:
 *   --dry-run        Print the generated file to stdout; write nothing.
 *   --merge          Keep existing entries the scan didn't rediscover (repos outside roots).
 *   --depth N        Max walk depth per root (default 4).
 *   --dirty          Annotate clean/dirty (scans the worktree — slow on large repos).
 *   --no-annotate    Omit the '# name — branch · remote · last commit' comment lines.
 *   roots...         Override the default scan roots (~/projects ~/Projects ~/Sites ~/Dev).
 */

import { copyFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { flagValue, hasFlag } from "std/core";
import { atomicWrite, exists, readIfExists } from "std/fsx";
import { git } from "std/git";

// ── caller-local identity (D4) ──────────────────────────────────────────────────────────────────────

export interface Paths {
  home: string;
  /** We STAGE the file at the home root and tell {{PRINCIPAL_NAME}} to `mv` it into ~/.claude — the
   * write stays outside ~/.claude (review-before-activate); the system only reads the LIVE copy. */
  staged: string;
  live: string;
}

export function defaultPaths(home: string = homedir()): Paths {
  return {
    home,
    staged: join(home, "checkpoint-repos.txt"),
    live: join(home, ".claude", "checkpoint-repos.txt"),
  };
}

// Dirs we never descend into — heavy, noisy, or never holding a tracked repo root.
const SKIP = new Set([
  "node_modules", ".git", "vendor", "dist", "build", "out", ".next", "target",
  ".venv", "venv", "__pycache__", ".cache", ".cargo", ".rustup", "Pods",
  "DerivedData", ".Trash", "Library", ".npm", ".bun", "coverage", ".turbo",
]);

export function defaultRoots(home: string = homedir()): string[] {
  return ["projects", "Projects", "Sites", "Dev", "code", "work"]
    .map((d) => join(home, d))
    .filter(exists);
}

// ── canonicalize: resolve symlinks + true on-disk casing; fall back to input ───────────────────────
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// A repo qualifies only if it's a real work tree (excludes bare repos — the checkpoint hook needs a
// worktree to `git status` / `reset`).
export function isWorkTree(dir: string): boolean {
  return git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

// ── tree walk: find repo roots, stop descending once one is found (see header note) ────────────────
export function walk(dir: string, depth: number, found: string[]): void {
  if (depth < 0) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // permission / vanished dir — skip
  }
  // `.git` may be a directory (normal repo) OR a file (worktree / submodule).
  if (entries.some((e) => e.name === ".git")) {
    found.push(dir);
    return; // repo root: don't descend (avoids double-counting submodules)
  }
  for (const e of entries) {
    // isDirectory() is false for symlinks → symlinked dirs are skipped (no loops).
    if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".")) {
      walk(join(dir, e.name), depth - 1, found);
    }
  }
}

// ── render one repo's metadata comment ──────────────────────────────────────────────────────────────
// Leads with the repo's short name so each block reads as a labelled header, then the git facts.
// The path on the next line is the only thing the parser consumes.
export function annotation(repo: string, dirty: boolean): string {
  const name = basename(repo);
  const branch = git(repo, ["branch", "--show-current"]) || "detached";
  let remote = git(repo, ["remote", "get-url", "origin"]);
  if (!remote) remote = git(repo, ["remote", "get-url", git(repo, ["remote"]).split("\n")[0] || "origin"]);
  remote = remote.replace(/^git@([^:]+):/, "$1/").replace(/^https?:\/\//, "").replace(/\.git$/, "") || "(no remote)";
  const last = git(repo, ["log", "-1", "--format=%cr"]) || "no commits";
  const parts = [branch, remote, last];
  if (dirty) parts.push(git(repo, ["status", "--porcelain"]).length ? "✗ dirty" : "✓ clean");
  return `# ${name} — ${parts.join(" · ")}`;
}

export function collapse(p: string, home: string): string {
  return p === home ? "~" : p.startsWith(home + "/") ? "~/" + p.slice(home.length + 1) : p;
}

// ── merge: preserve existing entries the scan didn't rediscover ────────────────────────────────────
// Reads from the LIVE allowlist (the one the system actually uses), so a re-run never drops repos
// added by hand outside the scan roots.
export function existingPaths(paths: Paths): string[] {
  const src = exists(paths.live) ? paths.live : paths.staged;
  const raw = readIfExists(src);
  if (raw === null) return [];
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) =>
      l.startsWith("~/")
        ? join(paths.home, l.slice(2))
        : l === "~"
          ? paths.home
          : l.replace(/^\$HOME(\/|$)/, paths.home + "$1"),
    );
}

// ── scan + render (paths/roots injected so the caller — CLI or test — owns the environment) ────────

export interface ScanOpts {
  roots: string[];
  maxDepth: number;
  merge: boolean;
  dirty: boolean;
  annotate: boolean;
  paths: Paths;
}

export interface ScanResult {
  output: string;
  repos: string[];
  skippedBare: number;
}

export function scan(opts: ScanOpts): ScanResult {
  const found: string[] = [];
  for (const root of opts.roots) {
    if (!exists(root)) {
      console.error(`skip (missing root): ${root}`);
      continue;
    }
    walk(root, opts.maxDepth, found);
  }

  // Qualify (work trees only), canonicalize, and dedup on the real path. `seen` guards against
  // processing the same repo twice (case-variant or symlinked).
  const qualified = new Set<string>();
  const seen = new Set<string>();
  let skippedBare = 0;
  for (const dir of found) {
    const real = canonical(dir);
    if (seen.has(real)) continue;
    seen.add(real);
    if (isWorkTree(real)) qualified.add(real);
    else skippedBare++;
  }
  if (opts.merge) {
    for (const p of existingPaths(opts.paths)) {
      if (!exists(p)) continue;
      const real = canonical(p);
      if (seen.has(real)) continue;
      seen.add(real);
      qualified.add(real);
    }
  }

  const repos = [...qualified].sort();

  const rule = "# " + "═".repeat(78);
  const header = [
    rule,
    "#  checkpoint-repos.txt — ISC checkpoint allowlist",
    rule,
    "#  Gates which repositories the ISC checkpoint system (CheckpointPerISC.hook.ts",
    "#  + Checkpoint.ts) may inspect and roll back.",
    "#",
    "#  Generated by write-checkpoint-repos.ts — re-run to refresh. Manual edits are",
    "#  overwritten on the next run unless you pass --merge.",
    "#",
    "#  Format   one repo path per line; blank lines and '#' comments are ignored;",
    "#           '~/' and '$HOME' expand to the home directory.",
    `#  Roots    ${opts.roots.map((r) => collapse(r, opts.paths.home)).join(", ")}  (depth ${opts.maxDepth})`,
    `#  Repos    ${repos.length} work tree${repos.length === 1 ? "" : "s"}` +
      (skippedBare ? `  (${skippedBare} bare repo${skippedBare === 1 ? "" : "s"} skipped)` : ""),
    rule,
    "",
  ];

  const body: string[] = [];
  for (const repo of repos) {
    if (opts.annotate) body.push(annotation(repo, opts.dirty));
    body.push(collapse(repo, opts.paths.home), "");
  }
  const output = header.concat(body).join("\n").replace(/\n+$/, "\n");

  return { output, repos, skippedBare };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────

export function main(argv: string[] = process.argv.slice(2), paths: Paths = defaultPaths()): number {
  const dryRun = hasFlag(argv, "dry-run");
  const merge = hasFlag(argv, "merge");
  const dirty = hasFlag(argv, "dirty");
  const annotate = !hasFlag(argv, "no-annotate");
  const depthVal = flagValue(argv, "depth");
  const maxDepth = depthVal !== undefined ? Math.max(0, parseInt(depthVal, 10) || 4) : 4;
  // Roots: every non-flag positional token, excluding the `--depth` value slot. `core/args`'
  // `positional()` returns only the FIRST such token, so the multi-root list stays local (see header).
  const depthIdx = argv.indexOf("--depth");
  const rootArgs = argv.filter((a, i) => !a.startsWith("--") && (depthIdx === -1 || i !== depthIdx + 1));


  // Expand ~, filter to existing, canonicalize, then dedup — so case-variant roots (~/projects vs
  // ~/Projects on a case-insensitive FS) are walked exactly once.
  const roots = [
    ...new Set(
      (rootArgs.length ? rootArgs : defaultRoots(paths.home))
        .map((r) => (r.startsWith("~/") ? join(paths.home, r.slice(2)) : r))
        .filter(exists)
        .map(canonical),
    ),
  ];

  const { output, repos, skippedBare } = scan({ roots, maxDepth, merge, dirty, annotate, paths });

  if (dryRun) {
    process.stdout.write(output);
    console.error(`\n[dry-run] ${repos.length} repos found, ${skippedBare} bare skipped. Nothing written.`);
  } else {
    // Backup-first copy is LOAD-BEARING (preserves the prior allowlist before an overwrite) — kept as
    // a caller-side copyFileSync BEFORE atomicWrite, which then does the tmp-write + rename.
    if (exists(paths.staged)) copyFileSync(paths.staged, paths.staged + ".bak");
    atomicWrite(paths.staged, output);
    console.error(
      `Wrote ${repos.length} repos to ${collapse(paths.staged, paths.home)}` +
        (skippedBare ? ` (${skippedBare} bare repos skipped)` : "") +
        (exists(paths.staged + ".bak") ? `  [backup: ${collapse(paths.staged, paths.home)}.bak]` : "") +
        `\n\nReview it, then activate with:\n  mv ~/checkpoint-repos.txt ~/.claude/`,
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
