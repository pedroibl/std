import { describe, expect, test } from "bun:test";
import { bar } from "./bar";

// Story 12.2 — `bar` is the promotion oracle: it must byte-subsume all four re-rolled call-sites the
// Rule-of-Three is built on. Each block below reconstructs the ORIGINAL site's exact output with plain
// string ops, then asserts `bar(...)` produces identical bytes. If a future edit to `bar` drifts any
// site, one of these fails.

describe("bar — byte-parity vs the four re-rolled call-sites", () => {
  // ── Bar A — algorithm.ts:1110-1114 ──
  // const bar = (p,t,w=20) => { pct = t>0?p/t:0; filled=round(pct*w);
  //   return `${"█".repeat(filled)}${"░".repeat(w-filled)} ${round(pct*100)}%`; }
  // In-scope adoption: bar(p,t,{width:20,brackets:false}) + caller appends ` NN%`.
  test("Bar A — width 20, no brackets, no color (suffix stays caller-side)", () => {
    const barA = (p: number, t: number, w = 20): string => {
      const pct = t > 0 ? p / t : 0;
      const filled = Math.round(pct * w);
      return `${"█".repeat(filled)}${"░".repeat(w - filled)}`;
    };
    for (const [p, t] of [[0, 10], [3, 10], [5, 10], [7, 13], [10, 10], [1, 3]] as const) {
      expect(bar(p, t, { width: 20, brackets: false })).toBe(barA(p, t));
    }
    // And the full caller line = bar + suffix, reproduced end-to-end.
    const pct = 7 / 13;
    const line = `${bar(7, 13, { width: 20, brackets: false })} ${Math.round(pct * 100)}%`;
    expect(line).toBe(`${barA(7, 13)} ${Math.round(pct * 100)}%`);
  });

  // ── Bar B — algorithm.ts:1671-1677 (buildProgressBar) ──
  // total===0 → "[\x1b[90m----------\x1b[0m]" (caller sentinel); else
  //   width=10; filled=round(passing/total*10); empty=width-filled;
  //   return `[\x1b[32m${"█"*filled}\x1b[90m${"░"*empty}\x1b[0m]`
  test("Bar B — width 10, brackets, green fill / grey empty", () => {
    const barB = (passing: number, total: number): string => {
      if (total === 0) return "[\x1b[90m----------\x1b[0m]";
      const width = 10;
      const filled = Math.round((passing / total) * width);
      const empty = width - filled;
      return `[\x1b[32m${"█".repeat(filled)}\x1b[90m${"░".repeat(empty)}\x1b[0m]`;
    };
    const callBarB = (passing: number, total: number): string =>
      total === 0
        ? "[\x1b[90m----------\x1b[0m]" // caller-owned zero-total sentinel
        : bar(passing, total, { width: 10, fillColor: "\x1b[32m", emptyColor: "\x1b[90m" });
    for (const [p, t] of [[0, 8], [3, 8], [8, 8], [1, 3], [2, 5], [5, 7]] as const) {
      expect(callBarB(p, t)).toBe(barB(p, t));
    }
    // zero-total: sentinel path (caller), never bar() — assert both agree on the sentinel string.
    expect(callBarB(0, 0)).toBe(barB(0, 0));
  });

  // ── OpinionTracker.ts:314-316 (Rule-of-Three witness, migrates in the DA/opinion cluster) ──
  // bar var = '█'*round(c*10) + '░'*(10-round(c*10)); call-site wraps `[${bar}]` and appends ` NN%`.
  // Bracket-provenance (Winston flag): the witness builds the INNER run with no brackets, so compare
  // bar(...,{brackets:false}) to the inner run — NOT to a bracket-wrapped form.
  test("OpinionTracker witness — inner run, brackets false (default █/░)", () => {
    const inner = (c: number): string =>
      "█".repeat(Math.round(c * 10)) + "░".repeat(10 - Math.round(c * 10));
    for (const c of [0, 0.15, 0.4, 0.55, 0.9, 1]) {
      expect(bar(Math.round(c * 10), 10, { brackets: false })).toBe(inner(c));
    }
  });

  // ── DAGrowth.ts:146 (Rule-of-Three witness) ──
  // bar var = "#".repeat(round(c*10)).padEnd(10, "."); call-site wraps `[${bar}]`.
  // padEnd(10,".") ≡ ".".repeat(10-f) for f≤10 (confidence∈[0,1] keeps round(c*10)≤10).
  test("DAGrowth witness — '#'/'.' glyphs, inner run, brackets false", () => {
    const inner = (c: number): string => "#".repeat(Math.round(c * 10)).padEnd(10, ".");
    for (const c of [0, 0.15, 0.4, 0.55, 0.9, 1]) {
      expect(bar(Math.round(c * 10), 10, { fillChar: "#", emptyChar: ".", brackets: false })).toBe(
        inner(c),
      );
    }
  });
});

describe("bar — edge cases", () => {
  test("total=0 → all-empty track (ratio guarded, no divide-by-zero)", () => {
    expect(bar(5, 0, { width: 10, brackets: false })).toBe("░".repeat(10));
    expect(bar(0, 0, { width: 4, brackets: false })).toBe("░".repeat(4));
  });

  test("filled>total clamps to full width (no negative repeat / no throw)", () => {
    // The original barB would throw on "░".repeat(negative); bar clamps to a full track instead.
    expect(bar(15, 10, { width: 10, brackets: false })).toBe("█".repeat(10));
    expect(() => bar(15, 10, { width: 10 })).not.toThrow();
  });

  test("width 1", () => {
    expect(bar(0, 10, { width: 1, brackets: false })).toBe("░");
    expect(bar(10, 10, { width: 1, brackets: false })).toBe("█");
    expect(bar(4, 10, { width: 1, brackets: false })).toBe("░"); // round(0.4)=0
    expect(bar(6, 10, { width: 1, brackets: false })).toBe("█"); // round(0.6)=1
  });

  test("default opts = width 10, █/░, brackets on, no color", () => {
    expect(bar(5, 10)).toBe(`[${"█".repeat(5)}${"░".repeat(5)}]`);
    expect(bar(5, 10)).not.toContain("\x1b["); // no ANSI unless a color opt is passed
  });

  test("a single color still closes with one reset", () => {
    expect(bar(3, 10, { width: 5, fillColor: "\x1b[32m", brackets: false })).toBe(
      `\x1b[32m${"█".repeat(2)}${"░".repeat(3)}\x1b[0m`,
    );
  });

  test("no color → no reset emitted", () => {
    expect(bar(3, 10, { width: 5, brackets: false })).not.toContain("\x1b[0m");
  });
});
