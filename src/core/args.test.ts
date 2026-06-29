import { describe, expect, test } from "bun:test";

import { dispatch, flagValue, hasFlag, positional } from "./args";

describe("positional", () => {
  test("returns the first non-flag token", () => {
    expect(positional(["--web", "42", "--all"])).toBe("42");
  });
  test("returns empty string when there is no positional", () => {
    expect(positional(["--web"])).toBe("");
  });
});

describe("flagValue", () => {
  test("returns the value after --name (space form)", () => {
    expect(flagValue(["--title", "Hello"], "title")).toBe("Hello");
  });
  test("returns the value after --name= (equals form)", () => {
    expect(flagValue(["--title=Hello"], "title")).toBe("Hello");
  });
  test("equals form tolerates '=' inside the value", () => {
    expect(flagValue(["--filter=a=b"], "filter")).toBe("a=b");
  });
  test("--name= (empty equals) returns '' — distinguishable from absent", () => {
    expect(flagValue(["--title="], "title")).toBe("");
  });
  test("returns undefined when the flag is absent", () => {
    expect(flagValue(["--other", "x"], "title")).toBeUndefined();
  });
  test("returns undefined for a trailing --name with no following value", () => {
    expect(flagValue(["--title"], "title")).toBeUndefined();
  });
  test("equals form is preferred when both forms are present", () => {
    expect(flagValue(["--title=fromEquals", "--title", "fromSpace"], "title")).toBe("fromEquals");
  });
});

describe("hasFlag", () => {
  test("true when the bare flag is present", () => {
    expect(hasFlag(["issue", "list", "--all"], "all")).toBe(true);
  });
  test("false when the flag is absent", () => {
    expect(hasFlag(["issue", "list"], "all")).toBe(false);
  });
});

describe("dispatch", () => {
  test("runs the matching handler and returns its code", () => {
    expect(dispatch("build", { build: () => 0, test: () => 1 })).toBe(0);
  });
  test("returns the handler's non-zero code unchanged", () => {
    expect(dispatch("test", { build: () => 0, test: () => 1 })).toBe(1);
  });
  test("unknown command returns undefined (the edge decides what that means)", () => {
    expect(dispatch("nope", { build: () => 0 })).toBeUndefined();
  });
  test("does not resolve inherited Object.prototype keys as handlers", () => {
    expect(dispatch("constructor", { build: () => 0 })).toBeUndefined();
    expect(dispatch("toString", {})).toBeUndefined();
  });
});
