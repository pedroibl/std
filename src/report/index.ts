// report — Bun edge: render the core vocabulary as a markdown string.
//
// Builds on `core` only (never on the `glab`/`cn`/`dashkit` edges — edges don't import each other).
// The line-builder (FR7) and the `--json` output contract (FR8) are live; atomic safe-write (FR9)
// lands with its own story when a caller needs it.

export { lines, type Lines } from "./p";
export { emitJson, jsonOutput, log } from "./json";
