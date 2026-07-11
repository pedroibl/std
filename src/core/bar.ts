// Story 12.2 — `bar`: the one progress-bar renderer the estate re-rolls everywhere. It was slated to
// arrive "with dashkit" (FR21), but the Rule-of-Three fired earlier — `algorithm.ts` re-rolls it TWICE
// in one file (a local closure + `buildProgressBar`), and `OpinionTracker`/`DAGrowth` inline the same
// skeleton: 4 call-sites across 3 files. So `bar` promotes now (Winston, 2026-07-12: promote + split
// FR21 — only `bar` moves early; `parseSprint`/`summarize` stay sprint-domain in Epic 8, which later
// *imports* this instead of promoting it).
//
// Pure (D1/NFR1): zero node:*/fs/DOM/network, no process/document, no clock. It renders a fixed-width
// track of fill/empty glyphs from a filled/total ratio, optionally bracket-wrapped and optionally
// color-wrapped. ANSI color codes are PLAIN STRING ARGUMENTS the caller passes — `bar` never reads a
// tty or env, so `shouldColorize` (which does read env) stays at the edge. The `%`/count SUFFIX and any
// zero-total SENTINEL are caller-owned (they differ per site: ` NN%`, ` NN/NN`, `[----------]`), never
// baked in here (D4 — no consumer policy in core).

export interface BarOpts {
  /** Track width in glyphs. Default 10. */
  width?: number;
  /** Filled-run glyph. Default `█`. */
  fillChar?: string;
  /** Empty-run glyph. Default `░`. */
  emptyChar?: string;
  /** Wrap the track in `[` … `]`. Default `true`. */
  brackets?: boolean;
  /** ANSI prefix emitted before the filled run (e.g. `"\x1b[32m"`); omitted → no color. */
  fillColor?: string;
  /** ANSI prefix emitted before the empty run (e.g. `"\x1b[90m"`); omitted → no color. */
  emptyColor?: string;
}

/**
 * Render a progress bar of `width` glyphs for `filled / total`. The fill count is
 * `round(filled/total * width)`, clamped to `[0, width]` (so `total === 0` → empty track and
 * `filled > total` → full track — neither throws, unlike a raw `"░".repeat(width - filled)` on an
 * unclamped overflow). When either color is set, a single `\x1b[0m` reset closes the track. Brackets
 * (default) wrap the whole track.
 *
 * The suffix (` NN%`, ` NN/NN`), the zero-total sentinel, and the decision to colorize all stay with
 * the caller — `bar` renders only the track.
 */
export function bar(filled: number, total: number, opts: BarOpts = {}): string {
  const { width = 10, fillChar = "█", emptyChar = "░", brackets = true, fillColor, emptyColor } = opts;
  const ratio = total > 0 ? filled / total : 0;
  const f = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const track =
    (fillColor ?? "") +
    fillChar.repeat(f) +
    (emptyColor ?? "") +
    emptyChar.repeat(width - f) +
    (fillColor || emptyColor ? "\x1b[0m" : "");
  return brackets ? `[${track}]` : track;
}
