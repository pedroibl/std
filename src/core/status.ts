// Story 2.3 — the one shared status record and its renderer. Pure (D1).
//
// AD-2 (the closed record): `Counts` is ONE flat closed record of fields shared by ≥2 callers — a
// tally with exactly one slot per Severity, every slot always present (never a bag of optionals). A
// renderer therefore never guesses a missing key. A field only ONE caller needs stays caller-local
// via TS intersection (`Counts & { mine: number }`) — invisible to std's renderers. That intersection
// is the forcing function: when a second caller needs the same extra field, it earns promotion here.
//
// OQ1 / Rule-of-Three: a richer per-item "Stat" record (label + value + presentation hints) lives at
// exactly one edge today (a DOM stat card), and its presentation fields are an edge concern, not pure
// vocabulary — so it is deliberately NOT promoted into core yet. `Counts` is the shape ≥2 callers share.

import type { Severity } from "./severity";
import { GLYPH } from "./severity";

/** A tally by severity — the one flat closed record. Every level is always present (default 0). */
export type Counts = Record<Severity, number>;

/** A zeroed tally, so a caller starts from a complete closed record and only increments. */
export function emptyCounts(): Counts {
  return { ok: 0, error: 0, warn: 0, info: 0 };
}

// Most-urgent-first: a reader scans left-to-right and hits failures before noise.
const ORDER: readonly Severity[] = ["error", "warn", "info", "ok"];

/**
 * One-line severity summary, e.g. `✗ 2  ⚠ 1`. Renders only non-zero levels, in urgency order, with the
 * shared GLYPH map. An all-zero tally renders `""` so a caller can suppress a noise-free line entirely.
 * Accepts any `Counts` superset (`Counts & {…}`) — caller-local fields are ignored by construction.
 */
export function statusLine(counts: Counts): string {
  return ORDER.filter((level) => counts[level] > 0)
    .map((level) => `${GLYPH[level]} ${counts[level]}`)
    .join("  ");
}
