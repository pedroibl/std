// report — Bun edge: render the core vocabulary as a markdown string.
//
// Builds on `core` only (never on the `glab`/`cn`/`dashkit` edges — edges don't import each other).
// The line-builder (FR7) is the first primitive; `--json` (FR8) and atomic safe-write (FR9) land
// with their own stories when a caller needs them.

export { lines, type Lines } from "./p";
