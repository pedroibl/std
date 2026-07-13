import { describe, expect, test } from "bun:test";

import { dispatch, dispatchAsync, flagValue, hasFlag, positional } from "./args";

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
  test("passes the unknown command name into onUnknown", () => {
    let seen = "";
    dispatch("nope", handlers, (cmd) => ((seen = cmd), 2));
    expect(seen).toBe("nope");
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

describe("dispatchAsync", () => {
  const handlers = {
    build: async () => 0,
    test: async () => 1,
  };
  const onUnknown = async () => 2;

  test("runs the matching handler and resolves to its code", async () => {
    expect(await dispatchAsync("build", handlers, onUnknown)).toBe(0);
  });
  test("resolves to the handler's non-zero code unchanged", async () => {
    expect(await dispatchAsync("test", handlers, onUnknown)).toBe(1);
  });
  test("routes an unknown command to onUnknown (the edge decides)", async () => {
    expect(await dispatchAsync("nope", handlers, onUnknown)).toBe(2);
  });
  test("passes the unknown command name into onUnknown", async () => {
    let seen = "";
    await dispatchAsync("nope", handlers, async (cmd) => ((seen = cmd), 2));
    expect(seen).toBe("nope");
  });
  test("accepts a SYNC onUnknown (Promise<number> | number) — a bare number edge handler works", async () => {
    expect(await dispatchAsync("nope", handlers, (cmd) => (cmd === "nope" ? 3 : 2))).toBe(3);
  });
  test("a handler resolving to 0 is NOT mistaken for unknown (no undefined collision)", async () => {
    let unknownRan = false;
    expect(await dispatchAsync("build", handlers, async () => ((unknownRan = true), 2))).toBe(0);
    expect(unknownRan).toBe(false);
  });
  test("awaits the handler — the returned promise settles after the handler's work completes", async () => {
    let done = false;
    const slow = { go: async () => (await Promise.resolve(), (done = true), 0) };
    expect(await dispatchAsync("go", slow, async () => 2)).toBe(0);
    expect(done).toBe(true);
  });
  test("does not run inherited Object.prototype keys as handlers — falls through to onUnknown", async () => {
    expect(await dispatchAsync("constructor", handlers, onUnknown)).toBe(2);
    expect(await dispatchAsync("toString", {}, onUnknown)).toBe(2);
  });
});
