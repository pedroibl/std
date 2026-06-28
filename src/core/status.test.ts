import { describe, expect, test } from "bun:test";

import { emptyCounts, statusLine, type Counts } from "./status";

describe("emptyCounts", () => {
  test("is a complete closed record, all levels zeroed", () => {
    expect(emptyCounts()).toEqual({ ok: 0, error: 0, warn: 0, info: 0 });
  });
});

describe("statusLine", () => {
  test("renders non-zero levels most-urgent-first with shared glyphs", () => {
    const c: Counts = { ok: 5, error: 2, warn: 1, info: 0 };
    expect(statusLine(c)).toBe("✗ 2  ⚠ 1  ✓ 5");
  });

  test("omits zero levels", () => {
    expect(statusLine({ ok: 0, error: 1, warn: 0, info: 0 })).toBe("✗ 1");
  });

  test("an all-zero tally renders empty (suppressible)", () => {
    expect(statusLine(emptyCounts())).toBe("");
  });

  test("AD-2: a caller-local field via intersection is accepted and ignored by the renderer", () => {
    // A single caller needs a `skipped` count; it stays local via intersection, never in core's Counts.
    type LocalCounts = Counts & { skipped: number };
    const c: LocalCounts = { ...emptyCounts(), error: 1, skipped: 9 };
    expect(statusLine(c)).toBe("✗ 1"); // `skipped` is invisible to the shared renderer
  });
});
