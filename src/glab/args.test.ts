import { describe, expect, test } from "bun:test";

import { flagValue, hasFlag, positional } from "./args";

describe("positional", () => {
  test("returns the first non-flag token", () => {
    expect(positional(["--web", "42", "--all"])).toBe("42");
  });
  test("returns empty string when there is no positional", () => {
    expect(positional(["--web"])).toBe("");
  });
});

describe("flagValue", () => {
  test("returns the value after --name", () => {
    expect(flagValue(["--title", "Hello"], "title")).toBe("Hello");
  });
  test("returns undefined when the flag is absent", () => {
    expect(flagValue(["--other", "x"], "title")).toBeUndefined();
  });
});

describe("hasFlag", () => {
  test("true when the flag is present", () => {
    expect(hasFlag(["issue", "list", "--all"], "all")).toBe(true);
  });
  test("false when the flag is absent", () => {
    expect(hasFlag(["issue", "list"], "all")).toBe(false);
  });
});
