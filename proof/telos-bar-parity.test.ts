// Story 12.4 — the FR21 bar-promotion certification (mirrors proof/algorithm-bar-parity.test.ts).
//
// 12.2 promoted `core.bar` from 4 sites and explicitly deferred TWO of them "to their own cluster":
//   - DAGrowth:146          `"#".repeat(round(c*10)).padEnd(10, ".")`
//   - OpinionTracker:314-16 `"█".repeat(round(c*10)) + "░".repeat(10 - round(c*10))`
// This is that cluster. This oracle asserts `core.bar` reproduces BOTH original inline formulas
// byte-for-byte across the Math.round boundaries — subsuming the last 2 of the 4 FR21 bar sites.
//
// The originals are reproduced here as the reference (NOT imported — they no longer exist as inline
// code once the proof rewrites adopt core.bar; this test freezes what they used to emit).

import { describe, expect, test } from "bun:test";
import { bar } from "std/core";

/** DAGrowth:146 verbatim — `#` fill, `.` pad-to-10, no brackets. */
function daGrowthBarOriginal(c: number): string {
  return "#".repeat(Math.round(c * 10)).padEnd(10, ".");
}

/** OpinionTracker:314-316 verbatim — `█` fill, `░` empty, double-repeat, no brackets. */
function opinionTrackerBarOriginal(c: number): string {
  return "█".repeat(Math.round(c * 10)) + "░".repeat(10 - Math.round(c * 10));
}

// c values chosen to exercise every Math.round boundary the two formulas can hit:
//   0     → round(0)   = 0   (empty track)
//   0.05  → round(0.5) = 1   (half-up: the smallest non-empty fill)
//   0.5   → round(5)   = 5   (mid)
//   0.95  → round(9.5) = 10  (half-up: saturates to full BEFORE c reaches 1)
//   1.0   → round(10)  = 10  (full track)
const CONFIDENCES = [0, 0.05, 0.5, 0.95, 1.0];

describe("core.bar parity — DAGrowth (# / . , padEnd, brackets:false)", () => {
  for (const c of CONFIDENCES) {
    test(`c=${c} reproduces "#".repeat(round(c*10)).padEnd(10,".")`, () => {
      const viaBar = bar(Math.round(c * 10), 10, {
        fillChar: "#",
        emptyChar: ".",
        brackets: false,
      });
      expect(viaBar).toBe(daGrowthBarOriginal(c));
      // width is exactly 10 glyphs in both
      expect(viaBar.length).toBe(10);
    });
  }

  test("the padEnd-vs-fill+empty equivalence holds at a fractional round-down (c=0.44 → round=4)", () => {
    const c = 0.44; // round(4.4) = 4
    expect(bar(Math.round(c * 10), 10, { fillChar: "#", emptyChar: ".", brackets: false })).toBe(
      daGrowthBarOriginal(c),
    );
  });
});

describe("core.bar parity — OpinionTracker (█ / ░ , double-repeat, brackets:false)", () => {
  for (const c of CONFIDENCES) {
    test(`c=${c} reproduces "█".repeat(round(c*10)) + "░".repeat(10-round(c*10))`, () => {
      const viaBar = bar(Math.round(c * 10), 10, {
        fillChar: "█",
        emptyChar: "░",
        brackets: false,
      });
      expect(viaBar).toBe(opinionTrackerBarOriginal(c));
    });
  }
});

describe("core.bar clamp — filled>total never overflows (both originals stay in [0,10])", () => {
  test("a confidence above 1.0 would overflow the naive double-repeat; core.bar clamps to full", () => {
    // Neither original clamps (c is a 0-1 confidence by contract), but core.bar's clamp means a
    // degenerate filled>total renders a full track rather than throwing on a negative repeat count.
    expect(bar(13, 10, { fillChar: "█", emptyChar: "░", brackets: false })).toBe("█".repeat(10));
    // The naive `"░".repeat(10 - 13)` would throw (RangeError: negative count) — core.bar does not.
    expect(() => "░".repeat(10 - 13)).toThrow();
  });
});
