import { describe, expect, test } from "bun:test";
import { bar } from "std/core";

// Story 12.2 — the in-repo oracle for algorithm.ts's IN-PLACE core.bar swap (Winston Q2: algorithm.ts
// is swapped in place at ~/.claude/PAI/TOOLS/, and THIS fixture certifies the byte-parity here in
// std-public so the promotion is proven without vendoring 1802 entangled lines).
//
// Each block reconstructs the ORIGINAL algorithm.ts call-site verbatim, then reconstructs the exact
// REPLACEMENT code (core.bar + the caller-owned suffix/sentinel), and asserts identical bytes — the two
// in-story proof consumers for the promotion (like glab was for core/args in 10.1).

describe("algorithm.ts Bar A (:1110-1114) — width 20, no brackets, trailing NN%", () => {
  // ORIGINAL closure — returns the track WITH the ` NN%` suffix baked in:
  const originalBarA = (p: number, t: number, w = 20): string => {
    const pct = t > 0 ? p / t : 0;
    const filled = Math.round(pct * w);
    return `${"█".repeat(filled)}${"░".repeat(w - filled)} ${Math.round(pct * 100)}%`;
  };
  // REPLACEMENT — core.bar renders the track; the caller re-adds the ` NN%` suffix.
  const newBarA = (p: number, t: number): string => {
    const pct = t > 0 ? p / t : 0;
    return `${bar(p, t, { width: 20, brackets: false })} ${Math.round(pct * 100)}%`;
  };

  test("byte-identical across the passing/total range", () => {
    for (const [p, t] of [[0, 10], [3, 10], [5, 10], [7, 13], [10, 10], [0, 0], [2, 7], [9, 9]] as const) {
      expect(newBarA(p, t)).toBe(originalBarA(p, t));
    }
  });

  test("the full progress line (as printed at :1125) matches", () => {
    const passing = 4;
    const total = 9;
    const original = `Progress: ${passing}/${total} ${originalBarA(passing, total)}`;
    const replaced = `Progress: ${passing}/${total} ${newBarA(passing, total)}`;
    expect(replaced).toBe(original);
  });
});

describe("algorithm.ts Bar B (:1671-1677, buildProgressBar) — width 10, brackets, green/grey, zero sentinel", () => {
  // ORIGINAL buildProgressBar, verbatim (incl. the total===0 sentinel).
  const originalBarB = (passing: number, total: number): string => {
    if (total === 0) return "[\x1b[90m----------\x1b[0m]";
    const width = 10;
    const filled = Math.round((passing / total) * width);
    const empty = width - filled;
    return `[\x1b[32m${"█".repeat(filled)}\x1b[90m${"░".repeat(empty)}\x1b[0m]`;
  };
  // REPLACEMENT — the caller keeps the zero-total sentinel; core.bar renders the colored track otherwise.
  const newBarB = (passing: number, total: number): string =>
    total === 0
      ? "[\x1b[90m----------\x1b[0m]"
      : bar(passing, total, { width: 10, fillColor: "\x1b[32m", emptyColor: "\x1b[90m" });

  test("byte-identical, including the zero-total sentinel", () => {
    for (const [p, t] of [[0, 0], [0, 8], [3, 8], [8, 8], [1, 3], [2, 5], [5, 7], [7, 7]] as const) {
      expect(newBarB(p, t)).toBe(originalBarB(p, t));
    }
  });

  test("the full criteria line (as printed at :1666) matches", () => {
    const passing = 3;
    const total = 7;
    const original = `  Criteria: ${originalBarB(passing, total)} ${passing}/${total}`;
    const replaced = `  Criteria: ${newBarB(passing, total)} ${passing}/${total}`;
    expect(replaced).toBe(original);
  });
});
