import { describe, expect, test } from "bun:test";

import { getLearningCategory, isLearningCapture } from "./learning-utils";

// Story 13.4 — learning-utils is DEFAULT-keep-caller-local (AC4): the map's "→ scoreRules" is DEFERred
// because getLearningCategory is FIRST-GROUP-WITH-ANY-HIT / ALGORITHM-priority, NOT max-score. Both
// exports are FROZEN with a wider consumer set than the cluster (WCL, SatisfactionCapture, and the
// SessionHarvester/ProjectsHarvester harvesters import them), so these tests lock the byte-stable behavior.

describe("getLearningCategory — ALGORITHM-first priority (why scoreRules is DEFERred)", () => {
  test("the DEFER case: 1 ALGORITHM hit + 3 SYSTEM hits → ALGORITHM (scoreRules would say SYSTEM)", () => {
    // "wrong approach" is a lone ALGORITHM indicator; "hook", "config", "typescript" are 3 SYSTEM hits.
    // First-group-priority returns ALGORITHM on the first algorithm match; max-score would pick SYSTEM.
    const text = "wrong approach in the hook config using typescript";
    expect(getLearningCategory(text)).toBe("ALGORITHM");
  });

  test("system-only text → SYSTEM", () => {
    expect(getLearningCategory("the hook crashed, module not found in bun")).toBe("SYSTEM");
  });

  test("no indicators → default ALGORITHM (learnings reflect task quality)", () => {
    expect(getLearningCategory("we shipped the thing and it was fine")).toBe("ALGORITHM");
  });

  test("comment is folded into the analyzed text (frozen 2nd param)", () => {
    // content alone is system-ish; the comment carries the ALGORITHM signal → ALGORITHM wins first.
    expect(getLearningCategory("deploy path issue", "the wrong approach was taken")).toBe("ALGORITHM");
  });
});

describe("isLearningCapture — 2+ indicators threshold (FROZEN — harvesters import it)", () => {
  test("2+ learning indicators → true", () => {
    // "bug" (group 1) + "fixed" (group 2) = 2 distinct indicators.
    expect(isLearningCapture("we hit a bug and then fixed it")).toBe(true);
  });

  test("fewer than 2 indicators → false", () => {
    expect(isLearningCapture("just a normal sentence with nothing notable")).toBe(false);
  });

  test("summary + analysis args fold into the checked text (frozen signature)", () => {
    expect(isLearningCapture("plain text", "root cause found", "resolved the error")).toBe(true);
  });
});
