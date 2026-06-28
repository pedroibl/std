import { describe, expect, test } from "bun:test";

import { emitJson, jsonOutput, log } from "./json";

/** Capture raw writes to BOTH process streams (so nothing leaks to the test console), restoring after. */
function capture(fn: () => void): { out: string; err: string } {
  const originals = { stdout: process.stdout.write, stderr: process.stderr.write };
  const buf = { out: "", err: "" };
  process.stdout.write = ((c: string) => ((buf.out += String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => ((buf.err += String(c)), true)) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stdout.write = originals.stdout;
    process.stderr.write = originals.stderr;
  }
  return buf;
}

describe("jsonOutput — the pure --json payload serializer (FR8)", () => {
  test("pretty-prints with a 2-space indent", () => {
    expect(jsonOutput({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  test("round-trips through JSON.parse for objects, arrays, primitives", () => {
    for (const value of [{ x: [1, 2], y: "s" }, [1, "a", null], "str", 42, true, null]) {
      expect(JSON.parse(jsonOutput(value))).toEqual(value);
    }
  });

  test("is pure — no trailing newline (that's the writer's job)", () => {
    expect(jsonOutput({})).toBe("{}");
  });
});

describe("emitJson / log — the stdout/stderr stream split (FR8)", () => {
  test("emitJson writes the payload (+newline) to stdout ONLY", () => {
    const { out, err } = capture(() => emitJson({ ok: true }));
    expect(out).toBe('{\n  "ok": true\n}\n');
    expect(err).toBe(""); // nothing leaked to stderr
  });

  test("log writes to stderr ONLY — stdout stays clean for jq/grep", () => {
    const { out, err } = capture(() => log("harvesting…"));
    expect(err).toBe("harvesting…\n");
    expect(out).toBe(""); // nothing leaked to stdout
  });

  test("under --json, stdout carries only the JSON even while logs fire", () => {
    const { out, err } = capture(() => {
      log("step 1");
      emitJson({ result: "done" });
      log("step 2");
    });
    expect(out).toBe('{\n  "result": "done"\n}\n'); // ONLY the payload
    expect(err).toBe("step 1\nstep 2\n"); // all diagnostics
    expect(JSON.parse(out)).toEqual({ result: "done" }); // stdout is machine-parseable
  });
});
