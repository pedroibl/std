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
  const handlers = { build: () => 0, test: () => 1 };
  const onUnknown = () => 2;

  test("runs the matching handler and returns its code", () => {
    expect(dispatch("build", handlers, onUnknown)).toBe(0);
  });
  test("returns the handler's non-zero code unchanged", () => {
    expect(dispatch("test", handlers, onUnknown)).toBe(1);
  });
  test("routes an unknown command to onUnknown (the edge decides)", () => {
    expect(dispatch("nope", handlers, onUnknown)).toBe(2);
  });
  test("a handler returning 0 is NOT mistaken for unknown (no undefined collision)", () => {
    let unknownRan = false;
    expect(dispatch("build", handlers, () => ((unknownRan = true), 2))).toBe(0);
    expect(unknownRan).toBe(false);
  });
  test("does not run inherited Object.prototype keys as handlers — falls through to onUnknown", () => {
    expect(dispatch("constructor", handlers, onUnknown)).toBe(2);
    expect(dispatch("toString", {}, onUnknown)).toBe(2);
  });
});
