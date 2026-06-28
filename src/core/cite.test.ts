import { describe, expect, test } from "bun:test";

import { cite } from "./cite";

describe("cite", () => {
  test("wraps a path in backticks", () => {
    expect(cite("scripts/glab.ts")).toBe("`scripts/glab.ts`");
  });

  test("is copy-pasteable — no surrounding whitespace", () => {
    expect(cite("a/b.md")).toBe("`a/b.md`");
  });

  test("handles an empty path without crashing", () => {
    expect(cite("")).toBe("``");
  });
});
