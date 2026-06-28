import { describe, expect, test } from "bun:test";

import { GLYPH, NO_ACTION, severity, type Severity } from "./severity";

describe("severity", () => {
  test("GLYPH has exactly the four levels with the canonical glyphs", () => {
    expect(GLYPH).toEqual({ ok: "✓", error: "✗", warn: "⚠", info: "ℹ" });
  });

  test("every level resolves to a non-empty glyph", () => {
    for (const level of severity.levels) {
      expect(GLYPH[level as Severity].length).toBeGreaterThan(0);
    }
  });

  test("severity bundle exposes levels + glyph + sentinel from one import", () => {
    expect(severity.levels).toEqual(["ok", "error", "warn", "info"]);
    expect(severity.glyph).toBe(GLYPH);
    expect(severity.NO_ACTION).toBe(NO_ACTION);
  });

  test("NO_ACTION is a unique symbol, distinct from any level string", () => {
    expect(typeof NO_ACTION).toBe("symbol");
    expect(NO_ACTION).not.toBe("ok");
    expect(severity.levels as readonly unknown[]).not.toContain(NO_ACTION);
  });
});
