import { describe, expect, test } from "bun:test";

import { spawnCapture } from "./index";

describe("spawnCapture — stdout / stderr / code capture", () => {
  test("captures stdout and a zero exit code", async () => {
    const r = await spawnCapture("echo", ["hello"]);
    expect(r.stdout).toBe("hello\n");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });

  test("captures stderr and a nonzero exit code (passed through verbatim)", async () => {
    const r = await spawnCapture("sh", ["-c", "echo oops >&2; exit 3"]);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("oops\n");
    expect(r.code).toBe(3);
  });
});

describe("spawnCapture — stdin passthrough", () => {
  test("writes opts.stdin to the child and closes it (cat round-trips)", async () => {
    const r = await spawnCapture("cat", [], { stdin: "piped input\nsecond line" });
    expect(r.stdout).toBe("piped input\nsecond line");
    expect(r.code).toBe(0);
  });

  test("no stdin provided: stdin is closed so a reader exits cleanly (cat → empty)", async () => {
    const r = await spawnCapture("cat", []);
    expect(r.stdout).toBe("");
    expect(r.code).toBe(0);
  });
});

describe("spawnCapture — env passthrough", () => {
  test("forwards opts.env verbatim to the child", async () => {
    const r = await spawnCapture("sh", ["-c", "echo $STD_PROC_PROBE"], {
      env: { STD_PROC_PROBE: "forwarded", PATH: process.env.PATH ?? "" },
    });
    expect(r.stdout).toBe("forwarded\n");
    expect(r.code).toBe(0);
  });
});

describe("spawnCapture — timeout → SIGTERM → sentinel 124", () => {
  test("kills a long process on timeout and resolves with code 124", async () => {
    const r = await spawnCapture("sleep", ["5"], { timeout: 50 });
    expect(r.code).toBe(124);
  });

  test("no timeout: process runs to completion (timer never fires)", async () => {
    const r = await spawnCapture("echo", ["done"]);
    expect(r.stdout).toBe("done\n");
    expect(r.code).toBe(0);
  });
});

describe("spawnCapture — never rejects (the linchpin)", () => {
  test("a nonexistent command resolves with sentinel 127 and an error in stderr (does not throw)", async () => {
    const r = await spawnCapture("std-proc-no-such-binary-xyz", ["arg"]);
    expect(r.code).toBe(127);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(r.stdout).toBe("");
  });

  test("the returned promise resolves (never rejects) across timeout, nonzero, and launch-failure paths", async () => {
    // If any of these rejected, Promise.all would reject and the test would fail.
    const results = await Promise.all([
      spawnCapture("sh", ["-c", "exit 7"]),
      spawnCapture("sleep", ["5"], { timeout: 30 }),
      spawnCapture("std-proc-no-such-binary-xyz", []),
    ]);
    expect(results.map((r) => r.code)).toEqual([7, 124, 127]);
  });
});
