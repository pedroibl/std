// report — the `--json` output contract (FR8). Bun edge of the core vocabulary.
//
// WHY: a report can render for humans (markdown) or for machines (JSON). FR8 fixes the machine mode's
// discipline: the structured payload is the ONLY thing on stdout, and every diagnostic goes to stderr,
// so `bun run … --json | jq` / `| grep` never has to step over a log line. This mirrors the cli slice's
// `--json` invariant (`makeShellExec` quiet routes step output to stderr so std's JSON owns stdout) —
// the same principle, owned independently. report does NOT import cli; edges share `core` only.
//
// PURE/EDGE SPLIT: `jsonOutput` is pure (a value → its JSON string), so the output SHAPE is unit-testable
// without capturing stdout — the lesson from cli's `jsonResult`. `emitJson`/`log` are the thin writers
// that route the two streams. process I/O is allowed here (a Bun edge), never in `core`.

/**
 * Serialize a value to the `--json` stdout payload: pretty 2-space JSON (FR8). Pure — no I/O.
 * The report's own data shape, not cli's `{command,steps,verdict,exit}` — each edge owns its payload.
 */
export function jsonOutput(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/** Write the machine-readable payload to stdout — under `--json` this is the ONLY thing on stdout. */
export function emitJson(data: unknown): void {
  process.stdout.write(`${jsonOutput(data)}\n`);
}

/** Diagnostics go to stderr, so stdout stays clean for `jq`/`grep` in either mode. */
export function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}
