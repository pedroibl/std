import { describe, expect, test } from "bun:test";

import { lines } from "./p";

describe("lines() — the p() markdown line-builder (FR7)", () => {
  test("an untouched builder renders an empty string", () => {
    const { toString } = lines();
    expect(toString()).toBe("");
  });

  test("a single pushed line renders as itself", () => {
    const { p, toString } = lines();
    p("# Title");
    expect(toString()).toBe("# Title");
  });

  test("multiple lines join with a newline", () => {
    const { p, toString } = lines();
    p("# Title");
    p("- a");
    p("- b");
    expect(toString()).toBe("# Title\n- a\n- b");
  });

  test("a bare p() pushes a blank line (paragraph break)", () => {
    const { p, toString } = lines();
    p("# Title");
    p();
    p("body");
    expect(toString()).toBe("# Title\n\nbody");
  });

  test("toString() is non-destructive — repeated calls are stable", () => {
    const { p, toString } = lines();
    p("one");
    p("two");
    expect(toString()).toBe("one\ntwo");
    expect(toString()).toBe("one\ntwo");
  });

  test("each builder owns an independent buffer", () => {
    const a = lines();
    const b = lines();
    a.p("from a");
    b.p("from b");
    expect(a.toString()).toBe("from a");
    expect(b.toString()).toBe("from b");
  });

  test("preserves explicit empty-string pushes verbatim", () => {
    const { p, toString } = lines();
    p("");
    p("");
    expect(toString()).toBe("\n");
  });
});
