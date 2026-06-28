import { describe, expect, test } from "bun:test";

import { classify, toResult, type Result } from "./result";

const KNOWN = ["ENOENT", "EACCES"] as const;

describe("classify", () => {
  test("returns a typed error when the code is known", () => {
    const e = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(classify(e, KNOWN)).toEqual({ code: "ENOENT", message: "missing" });
  });

  test("re-throws (fail-loud) when the code is unknown", () => {
    const e = Object.assign(new Error("boom"), { code: "EOTHER" });
    expect(() => classify(e, KNOWN)).toThrow("boom");
  });

  test("re-throws a value carrying no code at all", () => {
    expect(() => classify(new Error("plain"), KNOWN)).toThrow("plain");
  });
});

describe("toResult", () => {
  test("wraps success as ok:true", () => {
    const r: Result<number, { code: (typeof KNOWN)[number]; message: string }> = toResult(
      () => 42,
      KNOWN,
    );
    expect(r).toEqual({ ok: true, value: 42 });
  });

  test("wraps a known failure as ok:false", () => {
    const r = toResult(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }, KNOWN);
    expect(r).toEqual({ ok: false, error: { code: "EACCES", message: "denied" } });
  });

  test("lets an unknown failure propagate — never silently swallowed", () => {
    expect(() =>
      toResult(() => {
        throw Object.assign(new Error("unexpected"), { code: "EWILD" });
      }, KNOWN),
    ).toThrow("unexpected");
  });
});
