// report — atomic safe-write helpers (FR9). Bun edge of the core vocabulary.
//
// WHY: a report that overwrites its output in place can leave a half-written, corrupt file if the
// process dies mid-write. The fix is stage-then-rename: write the new content to a temp sibling, then
// `rename` it over the target — atomic on the same filesystem, so a reader sees either the old file or
// the whole new one, never a torn write. Around that core sit the absent/append helpers a report needs:
// create-once (`writeIfAbsent`), idempotent block-append (`appendIfMissing`), and a best-effort audit
// trail (`appendAudit`).
//
// FAIL-LOUD (FR5), with ONE specified exception: `safeWrite`/`stageWrite`/`commitRename`/
// `writeIfAbsent`/`appendIfMissing` re-throw on real I/O errors. `appendAudit` is BEST-EFFORT per FR9 —
// an audit log must never take down the operation it records — so it (and only it) swallows its errors.
//
// node:fs is allowed here (a Bun edge); it is forbidden only in `core`. All paths are caller-supplied
// arguments — no path/repo identity is baked in (D4/NFR3), the same discipline the future `fsx` slice
// will inherit.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** Create a file's parent directory if missing (recursive). Shared prelude for the writers. */
function ensureParent(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Stage `content` to a temp sibling (`<path>.tmp`) and return its path. Creates parent dirs. The first
 * half of the atomic pair — pair with `commitRename`.
 *
 * NOTE (Epic 10 / AD-9): `stageWrite`+`commitRename` here and the inline temp+rename in
 * `src/cli/repo-nav.ts` are the ≥2 consumers that justify a shared `fsx.atomicWrite`. Converge THERE
 * (the plumbing slice), not here — don't build `fsx` speculatively from one story (D2).
 */
export function stageWrite(path: string, content: string): string {
  ensureParent(path);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  return tmp;
}

/** Atomically move a staged temp over the target (atomic on the same filesystem). Pairs with `stageWrite`. */
export function commitRename(tmp: string, path: string): void {
  renameSync(tmp, path);
}

/**
 * The FR9 entry point: read the current content (or `null` if the file is absent), hand it to `render`,
 * and write the result atomically (stage → rename). A failure mid-write leaves the original intact.
 */
export function safeWrite(path: string, render: (current: string | null) => string): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  const next = render(current);
  const tmp = stageWrite(path, next);
  commitRename(tmp, path);
}

/**
 * Create-once write with O_CREAT|O_EXCL semantics (`openSync(path, "wx")`). Returns `true` if it wrote,
 * `false` if the file already existed (a graceful skip — never an `EEXIST` throw). Any other error
 * re-throws (fail-loud).
 */
export function writeIfAbsent(path: string, content: string): boolean {
  ensureParent(path);
  let fd: number;
  try {
    fd = openSync(path, "wx"); // wx = O_CREAT | O_EXCL | O_WRONLY
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Marker-gated append: append `block` only if `marker` is not already present in the file. Idempotent —
 * a second call with the same marker is a no-op. Returns `true` if it appended. An absent file counts as
 * "marker missing" (the block is the first content). The caller owns any leading/trailing newline in
 * `block` and `marker`.
 */
export function appendIfMissing(path: string, marker: string, block: string): boolean {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current.includes(marker)) return false;
  ensureParent(path);
  appendFileSync(path, block);
  return true;
}

/** Default audit-log rotation threshold: 1 MiB. */
const AUDIT_MAX_BYTES = 1024 * 1024;

/**
 * Append one JSONL record (`JSON.stringify(record)\n`). Size-rotated: when the log reaches `maxBytes`
 * the current file is rolled to `<path>.1` (replacing any prior `.1`) before the new line is written, so
 * the live log never grows unbounded. BEST-EFFORT (FR9): this never throws — an audit/telemetry write
 * must not break the operation it records. This is the deliberate, FR9-specified exception to fail-loud
 * (FR5); do not "fix" it into a re-throw.
 */
export function appendAudit(path: string, record: unknown, maxBytes: number = AUDIT_MAX_BYTES): void {
  try {
    ensureParent(path);
    if (existsSync(path) && statSync(path).size >= maxBytes) {
      const rolled = `${path}.1`;
      if (existsSync(rolled)) rmSync(rolled);
      renameSync(path, rolled);
    }
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch {
    // best-effort: swallow — a failed audit write must not break the caller (FR9).
  }
}
