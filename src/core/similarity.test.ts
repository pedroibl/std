import { describe, expect, test } from "bun:test";

import { charOverlap, jaccard, scoreRules, tokenize, type ScoreRule } from "./similarity";

describe("tokenize", () => {
  test("lowercases, splits on whitespace, drops punctuation and 1-char tokens", () => {
    expect(tokenize("Hello, World! a bc")).toEqual(["hello", "world", "bc"]);
  });

  test("keeps hyphens (part of the allowed set) but strips other punctuation", () => {
    expect(tokenize("co-op test.case")).toEqual(["co-op", "test", "case"]);
  });

  test("empty / all-punctuation input → []", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("!!! ?? .")).toEqual([]);
  });
});

describe("jaccard", () => {
  test("returns |A ∩ B| / |A ∪ B| over token sets", () => {
    // {alpha,bravo,charlie} vs {bravo,charlie,delta} → ∩=2, ∪=4 → 0.5
    expect(jaccard("alpha bravo charlie", "bravo charlie delta")).toBe(0.5);
  });

  test("disjoint → 0, identical → 1", () => {
    expect(jaccard("alpha bravo", "charlie delta")).toBe(0);
    expect(jaccard("alpha bravo", "bravo alpha")).toBe(1);
  });

  test("both-empty → 0 (no div-by-zero)", () => {
    expect(jaccard("", "")).toBe(0);
    expect(jaccard("!!!", "")).toBe(0);
  });
});

describe("charOverlap", () => {
  test("positional char-match ratio over the longer length", () => {
    // "abc" vs "abx": positions 0,1 match → 2 / 3
    expect(charOverlap("abc", "abx")).toBeCloseTo(2 / 3, 10);
  });

  test("same prefix, different length → matches / longer.length", () => {
    // "abc" vs "abcdef": 3 positional matches over longer length 6 → 0.5
    expect(charOverlap("abc", "abcdef")).toBe(0.5);
  });

  test("empty input → 0", () => {
    expect(charOverlap("", "abc")).toBe(0);
    expect(charOverlap("abc", "")).toBe(0);
  });
});

describe("scoreRules", () => {
  const rules: ScoreRule[] = [
    { label: "cli", patterns: [/\bcli\b/i, /command/i], weight: 1 },
    { label: "web", patterns: [/http/i, /browser/i], weight: 1 },
  ];

  test("ranks the winning label first with reasons", () => {
    const r = scoreRules("build a cli command tool", rules);
    expect(r.top?.label).toBe("cli");
    expect(r.ranked[0]!.score).toBe(2); // both cli patterns hit, weight 1
    expect(r.ranked[0]!.matched.length).toBe(2);
    expect(r.ranked.find((e) => e.label === "web")).toBeUndefined(); // no web hit
  });

  test("two rules sharing a label aggregate their scores (primary/secondary tiers)", () => {
    const tiered: ScoreRule[] = [
      { label: "health", patterns: [/\bvo2\b/i, /\bhrv\b/i], weight: 2 }, // primary
      { label: "health", patterns: [/sleep/i], weight: 1 }, // secondary
    ];
    const r = scoreRules("vo2 max and sleep quality", tiered);
    // primary: 1 hit * 2 = 2; secondary: 1 hit * 1 = 1 → aggregated 3
    expect(r.top).toEqual({ label: "health", score: 3 });
    expect(r.ranked[0]!.matched.length).toBe(2);
  });

  test("weight multiplies hits", () => {
    const weighted: ScoreRule[] = [{ label: "x", patterns: [/foo/], weight: 5 }];
    expect(scoreRules("foo", weighted).ranked[0]!.score).toBe(5);
  });

  test("margin and confidence derive from top vs runner-up", () => {
    const r = scoreRules("cli command http", rules); // cli=2, web=1
    expect(r.top?.score).toBe(2);
    expect(r.margin).toBe(1); // 2 - 1
    expect(r.confidence).toBeCloseTo(Math.min(1, (1 + 2 * 0.3) / 10), 10); // 0.16
  });

  test("tie between top labels → margin is 0 and confidence is low", () => {
    const r = scoreRules("cli command http browser", rules); // cli=2, web=2
    expect(r.ranked[0]!.score).toBe(2);
    expect(r.ranked[1]!.score).toBe(2);
    expect(r.margin).toBe(0); // 2 - 2
    expect(r.confidence).toBeCloseTo(Math.min(1, (0 + 2 * 0.3) / 10), 10); // 0.06
  });

  test("no rule matches → empty ranked, null top, 0 margin/confidence", () => {
    expect(scoreRules("nothing relevant here", rules)).toEqual({
      ranked: [],
      top: null,
      margin: 0,
      confidence: 0,
    });
    expect(scoreRules("anything", [])).toEqual({ ranked: [], top: null, margin: 0, confidence: 0 });
  });
});
