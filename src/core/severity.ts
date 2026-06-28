// Story 2.1 — the one severity vocabulary. Pure, runtime-neutral (D1): no env, no DOM, no I/O.
// Every consumer imports these so status output is byte-identical across the estate from one source.

/** The four status levels. A closed union — adding a level is a deliberate vocabulary change. */
export type Severity = "ok" | "error" | "warn" | "info";

/** Status glyph per level. One map, so `✓ ✗ ⚠ ℹ` never drift between a report and a note. */
export const GLYPH: Readonly<Record<Severity, string>> = {
  ok: "✓",
  error: "✗",
  warn: "⚠",
  info: "ℹ",
};

/**
 * Suppression sentinel: a check ran and found nothing worth emitting. A unique symbol — not a
 * Severity, not a string — so a renderer branches on it explicitly (`if (s === NO_ACTION) return`)
 * and can never confuse "nothing to say" with a real "ok" result.
 */
export const NO_ACTION: unique symbol = Symbol("std.severity.NO_ACTION");

/** The vocabulary as one value, so a consumer can `import { severity }` and get levels + glyphs + sentinel. */
export const severity = {
  levels: ["ok", "error", "warn", "info"] as const,
  glyph: GLYPH,
  NO_ACTION,
} as const;
