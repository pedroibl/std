import { describe, expect, test } from "bun:test";

import { configValue, tryParse } from "./config";

describe("configValue", () => {
  test("returns the present value", () => {
    expect(configValue("prod", "dev")).toBe("prod");
  });

  test("falls back when absent or empty", () => {
    expect(configValue(undefined, "dev")).toBe("dev");
    expect(configValue(null, "dev")).toBe("dev");
    expect(configValue("", "dev")).toBe("dev");
  });

  test("fallback keeps the caller's type (e.g. a number default)", () => {
    expect(configValue(undefined, 8080)).toBe(8080);
    expect(configValue("9090", 8080)).toBe("9090");
  });
});

describe("tryParse", () => {
  test("returns the parsed value on success", () => {
    expect(tryParse(() => JSON.parse('{"a":1}'))).toEqual({ a: 1 });
  });

  test("degrades to null when the parse throws — never crashes the caller", () => {
    expect(tryParse(() => JSON.parse("{not json"))).toBeNull();
  });
});
