import { describe, expect, test } from "bun:test";

import { shouldColorize } from "./colorize";

describe("shouldColorize", () => {
  test("colorizes on a TTY when color is not disabled", () => {
    expect(shouldColorize(false, true)).toBe(true);
  });

  test("never colorizes when NO_COLOR is set, even on a TTY", () => {
    expect(shouldColorize(true, true)).toBe(false);
  });

  test("never colorizes off a TTY (piped/redirected output)", () => {
    expect(shouldColorize(false, false)).toBe(false);
    expect(shouldColorize(true, false)).toBe(false);
  });
});
