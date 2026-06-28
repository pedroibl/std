import { describe, expect, test } from "bun:test";

import { adapterVerdict, defaultCapability } from "./index";
import type { Capability, AdapterExec, ReviewAdapter } from "./index";

const present: Capability = () => true;
const absent: Capability = () => false;
const exit = (code: number): AdapterExec => () => code;
const boom: AdapterExec = () => {
  throw new Error("adapter exec must not run when the tool is absent");
};

describe("adapterVerdict (Story 4.4 AC1 — self-disable → SKIP, never 127)", () => {
  test("'none' always SKIPs (explicit no-op reviewer) — never probes or runs", () => {
    expect(adapterVerdict("none", absent, boom)).toBe("skip");
    expect(adapterVerdict("none", present, boom)).toBe("skip");
  });

  test("'coderabbit' is named-but-deferred → SKIP (no faked behavior)", () => {
    expect(adapterVerdict("coderabbit", present, boom)).toBe("skip");
  });

  test("'sourcery' ABSENT → SKIP, and the exec is never invoked (no 127-red)", () => {
    expect(adapterVerdict("sourcery", absent, boom)).toBe("skip");
  });

  test("'sourcery' PRESENT → exit 0 maps to pass", () => {
    expect(adapterVerdict("sourcery", present, exit(0))).toBe("pass");
  });

  test("'sourcery' PRESENT → non-zero maps to fail (a real review failure, distinct from absent)", () => {
    expect(adapterVerdict("sourcery", present, exit(1))).toBe("fail");
    expect(adapterVerdict("sourcery", present, exit(127))).toBe("fail");
  });
});

describe("defaultCapability (production probe shape)", () => {
  test("a deferred/none member is never 'available' through the probe (handled before probing)", () => {
    expect(defaultCapability("none")).toBe(false);
    expect(defaultCapability("coderabbit" as ReviewAdapter)).toBe(false);
  });

  test("'sourcery' requires BOTH binary and credential — no token ⇒ unavailable", () => {
    const saved = process.env.SOURCERY_CLI_TOKEN;
    delete process.env.SOURCERY_CLI_TOKEN;
    try {
      expect(defaultCapability("sourcery")).toBe(false); // cred absent ⇒ unavailable regardless of binary
    } finally {
      if (saved !== undefined) process.env.SOURCERY_CLI_TOKEN = saved;
    }
  });
});
