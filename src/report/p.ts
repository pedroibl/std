// report — the markdown line-builder (FR7). Bun edge of the core vocabulary.
//
// WHY: every markdown renderer in the estate (loom's report-builder, the PAI/Tools reports the
// extraction track will rewrite) grows the same shape by hand — push lines into an array, then
// `join("\n")`. This lifts that inert primitive out so a renderer composes a report uniformly
// instead of re-rolling the accumulator. It is the foundation the rest of `report` (--json, FR8;
// atomic write, FR9) and the E11–E14 render layer build on.
//
// PURE: this module touches no `node:*`, fs, or network — a markdown string is just text. It lives
// in `src/report/` (the Bun-edge namespace) rather than `core` because rendering markdown is a
// markdown-edge concern, not cross-runtime vocabulary (the Obsidian edges render DOM, not strings).
// `cite`/`statusLine`/`Counts` it composes with stay in `core` and are imported, never re-declared.

/** A push-lines-then-join markdown builder. */
export interface Lines {
  /** Push one line onto the buffer. A bare `p()` pushes a blank line (a paragraph break). */
  p(line?: string): void;
  /** Join every pushed line with `"\n"`. Non-destructive — callable repeatedly. */
  toString(): string;
}

/**
 * Create a fresh line-builder. The push function takes the loom-compatible `p(x = "")` signature so
 * existing call sites (`p("# heading"); p(""); p("- bullet")`) port unchanged.
 *
 *   const { p, toString } = lines();
 *   p("# Title"); p(""); p("- item");
 *   const md = toString();   // "# Title\n\n- item"
 *
 * An untouched builder renders `""`, so a caller can build conditionally and emit nothing.
 */
export function lines(): Lines {
  const buf: string[] = [];
  return {
    // `line: string = ""` keeps the buffer strictly string lines: the default fires on both `p()` and
    // an explicit `p(undefined)`, so neither can push a non-string (it would join as "undefined").
    p: (line: string = "") => {
      buf.push(line);
    },
    toString: () => buf.join("\n"),
  };
}
