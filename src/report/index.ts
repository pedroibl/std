// report — Bun edge: render the core vocabulary as a markdown string.
//
// Builds on `core` only (never on the `glab`/`cn`/`dashkit` edges — edges don't import each other).
// The line-builder (FR7), the `--json` output contract (FR8), and atomic safe-write (FR9) are all live.

export { lines, type Lines } from "./p";
export { emitJson, jsonOutput, log } from "./json";
export { appendAudit, appendIfMissing, commitRename, safeWrite, stageWrite, writeIfAbsent } from "./write";
