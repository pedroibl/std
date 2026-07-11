// fsx — the Bun-edge filesystem helper set (AD-9 plumbing topology), sibling to glab/proc/git/http.
//
// WHY: across the estate every tool re-hand-rolls the same fs moves — a recursive file walk, an
// idempotent mkdir, an absent-tolerant read, a fail-soft mtime read, a torn-write-proof write, and a typed
// JSON load/save. This slice is the one tested edge they collapse onto. The atomic-write half
// (`atomicWrite`/`saveJson`) is
// the Rule-of-Three trigger: it is already needed by `report` (stage+rename) and `cli` (repo-nav inline
// temp+rename) *in this repo*, so those two converge onto `fsx.atomicWrite` here (the AD-3 proof). The
// other four helpers ship + are tested now; their external PAI/Tools call-sites migrate in Epic 12.
//
// CONSUMER-AGNOSTIC (D4/NFR3 — the slice's one charter risk): every `root`/`path`/`dir` is a
// caller-supplied ARGUMENT. No MEMORY/`~/.claude`/`PAI_DIR`/STATE_DIR/SIDECAR/LEARNING path is baked,
// no model/voice/Pulse/env literal. The estate path is consumer identity and stays at the call-site.
//
// SYNC, by design (Decision 1): every consumer uses the sync `fs.*Sync` family and the in-repo
// convergence targets (`report/write.ts`, `cli/repo-nav.ts`) are sync, so `fsx` is sync — a drop-in for
// the byte-identical sync call-sites (same reasoning `git` 10.3 used to pick `execFileSync`). It is its
// own filesystem-axis edge: NOT built on `proc`/`http`.
//
// ERROR CONTRACT, split per-helper (Decision 2), grounded in how consumers behave:
//   - FAIL-SOFT on EXPECTED absence/corruption: `readIfExists` (missing→null), `loadJson`
//     (missing→fallback, unparseable→fallback), `walkFiles` (unreadable dir→skip) — every consumer
//     treats "not there yet / bad content" as "start from default / keep going".
//   - FAIL-LOUD on genuine I/O faults (FR5): `ensureDir`, `atomicWrite`, `saveJson` always; and the
//     read helpers re-throw a REAL fs error (permission, not-a-directory) rather than masking it —
//     `readIfExists` softens only ENOENT, and `loadJson` (built on `readIfExists`) softens only a
//     missing file or a JSON parse error. A broken filesystem must not look like an empty state
//     (Decision 2 amended 2026-06-29 per Sourcery review). A write that can't complete must surface,
//     not silently lose data (the `report/write.ts` discipline).
//
// CONCURRENCY & SINGLE-WRITER BOUNDARY (Epic-10 AI#3 / Epic-11 retro AI#4):
// These filesystem edges (atomicWrite/saveJson) guarantee safety against torn writes by writing
// to a sibling temp file and renameSync-ing. They operate under a SINGLE-WRITER scope (one CLI invocation
// or one bot execution runs at a time per workspace/backup). At this concurrency scale, they do NOT require
// unique random temp paths or locking primitives; a fixed sibling ".tmp" filename/directory is safe and
// simplifies state-cleanup. Later tool migrations and bot passes must accept this design constraint.
//
// node:fs is allowed here (a Bun edge); it is forbidden only in `core`.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Recursively enumerate every FILE under `root`, returning absolute paths for which `pred` returns true
 * (or all files when `pred` is omitted). Directories are descended, not returned.
 *
 * **Symlink-cycle-safe:** a `visited` set keyed by `realpathSync` means a symlink that points back up
 * the tree (`a/ → b/`, `b/loop → a/`) is seen once and skipped — the walk terminates instead of looping
 * forever. (This is the robust `ReferenceCheck.ts` template; the naive recursive walkers across the
 * estate have no such guard, so unifying on this is a strict improvement, never a regression.)
 *
 * **Always absolute:** `root` is `resolve`d on entry, so the returned paths are absolute regardless of
 * whether the caller passed an absolute or a relative root (the contract is absolute paths). Consumers
 * pass absolute estate roots; this just makes the relative case honor the same contract.
 *
 * **Fail-soft per directory:** an unreadable subdirectory (or one whose realpath can't be resolved) is
 * skipped, not thrown — partial enumeration beats aborting the whole walk. A non-directory `root` (a
 * file, a missing path, a broken symlink) yields `[]` by the same fail-soft rule — `walkFiles` walks a
 * directory TREE; it does not special-case a file handed in as the root (no consumer needs that, D2).
 * `root` is caller-supplied; no path is baked in.
 *
 * **Directory pruning (`opts.prune`):** a subtree whose directory satisfies `prune(dir)` is NOT descended
 * — the walk never reads its entries. This is a strict superset of the predicate: `pred` filters which
 * FILES are RETURNED (but every dir is still descended); `prune` stops whole DIRECTORY TREES from being
 * walked at all. It exists because folding a dir-exclusion into `pred` would keep correctness (excluded
 * files aren't returned) yet still descend `node_modules`/`.git`/… — a real perf regression on a
 * full-tree walk. The exclusion LISTS stay in the caller (identity, D4); `prune` is just the mechanism.
 * `prune` receives the absolute directory path; the root itself is a caller-chosen scan boundary and is
 * not prune-tested (a caller that wants to exclude the root simply passes a different one).
 */
export function walkFiles(
  root: string,
  pred?: (path: string) => boolean,
  opts?: { prune?: (dir: string) => boolean },
): string[] {
  const out: string[] = [];
  const stack: string[] = [resolve(root)];
  const visited = new Set<string>();
  const prune = opts?.prune;

  while (stack.length > 0) {
    const dir = stack.pop()!;

    // realpath first: the cycle guard. An unresolvable path (broken symlink, vanished dir) is skipped.
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // unreadable directory — skip, don't abort the walk
    }

    for (const entry of entries) {
      const full = join(dir, entry);
      let isDir: boolean;
      let isFile: boolean;
      try {
        const st = statSync(full); // follows symlinks — a symlinked dir descends and is cycle-guarded above
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue; // unstatable entry (e.g. broken symlink) — skip
      }
      if (isDir) {
        if (!prune || !prune(full)) stack.push(full); // pruned subtree is never descended
      } else if (isFile && (!pred || pred(full))) {
        out.push(full);
      }
    }
  }

  return out;
}

/**
 * Create `dir` (and any missing parents). Idempotent — `mkdirSync recursive` does not throw when the
 * directory already exists, so no exists-check is needed (an exists+mkdir pair is a needless TOCTOU).
 * Fail-loud: a real mkdir error (e.g. a permission denial) re-throws (FR5).
 */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Read a file's UTF-8 contents, or `null` if the file does not exist. The absent-tolerant read: a
 * missing file is an expected "not there yet" answer, not an error. A real read error on a file that
 * DOES exist still propagates (fail-loud, FR5) — only absence (`ENOENT`) is softened.
 *
 * ONE syscall, not an `existsSync`+`readFileSync` pair: that pair has a TOCTOU window (a file deleted
 * between the two calls would throw `ENOENT` instead of returning `null`, breaking this contract) and
 * costs an extra stat. The try/catch keys on the error code, so only absence becomes `null`.
 */
export function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err; // a real read error on an existing file surfaces (fail-loud, FR5)
  }
}

/**
 * Whether `path` exists (any type — file, directory, or other), via a fail-soft `statSync`. Returns
 * `false` for a missing path OR any unstatable one (a broken symlink, an unreadable parent): for an
 * existence probe "can't tell" and "not there" are the same answer. The sibling to {@link statMtime} —
 * the resolution ladders across the estate probe candidate paths dozens of times, and this is the one
 * tested primitive they collapse onto instead of a raw `existsSync` at each edge. `path` is
 * caller-supplied; no path is baked in. (A caller that must distinguish a real fs fault from absence
 * should `statSync` directly.)
 */
export function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false; // missing / unstatable → treated as absent
  }
}

/**
 * Modification time of `path` in milliseconds since the epoch (`statSync(path).mtimeMs`), or `0` when the
 * file is missing or unstatable. Fail-soft by design (mirrors `readIfExists`/`walkFiles`): the estate's
 * mtime readers use it to rank files by recency, and `0` sorts a vanished/unreadable file LAST (oldest)
 * rather than aborting the scan — the same `mtime 0 → sorts last` contract the harvester reads at its edge.
 * It softens ANY stat error (ENOENT, a broken symlink, an unreadable parent), because for a recency rank
 * "can't tell when" and "not there" are the same answer: unranked. A caller that must distinguish a real
 * fs fault from absence should `statSync` directly.
 */
export function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0; // missing / unstatable → sorts last under a recency rank
  }
}

/**
 * Write `content` to `path` atomically: ensure the parent dir, write to a temp sibling (`<path>.tmp`),
 * then `rename` it over the target. The rename is atomic on the same filesystem, so a reader sees either
 * the whole old file or the whole new one — never a torn partial — even if the process dies mid-write.
 * On success no `.tmp` is left behind. Fail-loud: a real I/O error re-throws (FR5).
 *
 * (This is the extraction map's `writeFileAtomic`, named `atomicWrite` to match the in-repo proof
 * consumers — `report` and `cli` — that import it.)
 */
export function atomicWrite(path: string, content: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Read + `JSON.parse` `path` and return the typed result. The two EXPECTED failures soften to
 * `fallback`: a **missing file** and **unparseable contents** (a JSON parse error) — every JSON-state
 * consumer treats "not there yet / corrupt" as "start from the default". A GENUINE fs fault (permission,
 * not-a-directory, …) is NOT masked — it surfaces (fail-loud, FR5), so a real environment problem is not
 * silently swallowed as an empty state. Composed on `readIfExists`, so the read half shares its discipline
 * (ENOENT→soft, real error→throw); only the `JSON.parse` step adds the corrupt→fallback softening.
 * The caller owns the shape via `T`; no validation beyond a successful parse.
 */
export function loadJson<T>(path: string, fallback: T): T {
  const raw = readIfExists(path); // ENOENT→null; a real fs error (EACCES/ENOTDIR/…) re-throws here
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback; // unparseable JSON → start from default
  }
}

/**
 * Serialize `value` as pretty-printed JSON (2-space indent, trailing newline) and write it via
 * `atomicWrite` — so saved state is torn-write-proof too. Fail-loud (inherits `atomicWrite`'s contract).
 */
export function saveJson(path: string, value: unknown): void {
  atomicWrite(path, JSON.stringify(value, null, 2) + "\n");
}
