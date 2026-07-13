import { describe, expect, test } from "bun:test";

import {
  buildActivityEvent,
  captureGroundTruth,
  gitSnapshot,
  truncate,
  type GitSnapshot,
  type SnapshotFn,
} from "./ToolActivityTracker.hook";

const HOOK = `${import.meta.dir}/ToolActivityTracker.hook.ts`;

/** Run the hook as the harness would — `bun ToolActivityTracker.hook.ts` with `input` piped to stdin. */
async function fire(input: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

// A hermetic snapshot fn — never touches real git.
const cleanRepo: SnapshotFn = () => ({ head: "abc1234", dirty: false });
const dirtyRepo: SnapshotFn = () => ({ head: "def5678", dirty: true });
const notRepo: SnapshotFn = () => undefined;

const FIXED = new Date("2026-07-13T15:00:00Z");
const TZ = "Australia/Melbourne";

describe("truncate — bounded preview (caps preserved verbatim)", () => {
  test("passes short strings through", () => {
    expect(truncate("hello", 500)).toBe("hello");
  });
  test("truncates + appends the marker at the cap", () => {
    const out = truncate("x".repeat(600), 500);
    expect(out).toBe("x".repeat(500) + "...[truncated]");
    expect(out.length).toBe(500 + "...[truncated]".length);
  });
});

describe("buildActivityEvent — pure event shaping (P3 isoOffset + FROZEN keys)", () => {
  test("stamps a tz-offset ISO timestamp (P3) and preserves the exact event keys", () => {
    const ev = buildActivityEvent(
      { session_id: "s1", tool_name: "Read", tool_input: { file_path: "/x/a.ts" } },
      FIXED,
      TZ,
      notRepo,
    );
    // P3: AEST +10:00 — UTC 15:00 rolls the day to the 14th.
    expect(ev.timestamp).toBe("2026-07-14T01:00:00+10:00");
    expect(ev.event).toBe("tool_use");
    expect(ev.source).toBe("tool-activity");
    expect(ev.type).toBe("tool_use");
    expect(ev.session_id).toBe("s1");
    expect(ev.tool_name).toBe("Read");
    // Read is not a write/bash tool → no ground_truth key emitted.
    expect("ground_truth" in ev).toBe(false);
  });

  test("tool_input_preview truncates at 300 with a bare '...' (not the [truncated] marker)", () => {
    const bigInput = { note: "z".repeat(1000) };
    const ev = buildActivityEvent(
      { session_id: "s2", tool_name: "Read", tool_input: bigInput },
      FIXED,
      TZ,
      notRepo,
    );
    const preview = ev.tool_input_preview as string;
    expect(preview.length).toBe(303); // 300 chars + '...'
    expect(preview.endsWith("...")).toBe(true);
    expect(preview.endsWith("[truncated]")).toBe(false);
  });

  test("short tool_input_preview is emitted whole", () => {
    const ev = buildActivityEvent(
      { session_id: "s3", tool_name: "Grep", tool_input: { pattern: "foo" } },
      FIXED,
      TZ,
      notRepo,
    );
    expect(ev.tool_input_preview).toBe(JSON.stringify({ pattern: "foo" }));
  });

  test("missing tool_name → 'unknown'; absent tool_input → empty preview, no ground_truth", () => {
    const ev = buildActivityEvent({ session_id: "s4" }, FIXED, TZ, notRepo);
    expect(ev.tool_name).toBe("unknown");
    expect(ev.tool_input_preview).toBe("");
    expect("ground_truth" in ev).toBe(false);
  });

  test("Write tool emits ground_truth with file_path + content caps + injected git snapshot", () => {
    const ev = buildActivityEvent(
      {
        session_id: "s5",
        tool_name: "Write",
        tool_input: { file_path: "/x/b.ts", content: "c".repeat(700) },
      },
      FIXED,
      TZ,
      dirtyRepo,
    );
    const gt = ev.ground_truth as Record<string, unknown>;
    expect(gt.file_path).toBe("/x/b.ts");
    expect((gt.content_preview as string).length).toBe(500 + "...[truncated]".length);
    expect(gt.content_bytes).toBe(700);
    expect(gt.git).toEqual({ head: "def5678", dirty: true });
  });

  test("Edit tool captures a bounded diff (old/new capped at 500)", () => {
    const ev = buildActivityEvent(
      {
        session_id: "s6",
        tool_name: "Edit",
        tool_input: {
          file_path: "/x/c.ts",
          old_string: "o".repeat(600),
          new_string: "n".repeat(600),
        },
      },
      FIXED,
      TZ,
      cleanRepo,
    );
    const gt = ev.ground_truth as Record<string, unknown>;
    const diff = gt.diff as { removed: string; added: string };
    expect(diff.removed).toBe("o".repeat(500) + "...[truncated]");
    expect(diff.added).toBe("n".repeat(500) + "...[truncated]");
    expect(gt.git).toEqual({ head: "abc1234", dirty: false });
  });

  test("git snapshot omitted when the injected snapshot returns undefined (non-repo cwd)", () => {
    const ev = buildActivityEvent(
      { session_id: "s7", tool_name: "Write", tool_input: { file_path: "/x/d.ts" } },
      FIXED,
      TZ,
      notRepo,
    );
    const gt = ev.ground_truth as Record<string, unknown>;
    expect(gt.file_path).toBe("/x/d.ts");
    expect("git" in gt).toBe(false);
  });
});

describe("captureGroundTruth — Bash tool_response extraction (800-cap + exit_code shapes)", () => {
  test("captures command + stdout/stderr previews (800) + byte counts", () => {
    const gt = captureGroundTruth(
      "Bash",
      { command: "echo hi" },
      { stdout: "s".repeat(1000), stderr: "e".repeat(1000), exit_code: 0 },
      notRepo,
    ) as Record<string, unknown>;
    expect(gt.command).toBe("echo hi");
    expect((gt.stdout_preview as string).length).toBe(800 + "...[truncated]".length);
    expect(gt.stdout_bytes).toBe(1000);
    expect((gt.stderr_preview as string).length).toBe(800 + "...[truncated]".length);
    expect(gt.exit_code).toBe(0);
  });

  test("accepts the camelCase exitCode shape too", () => {
    const gt = captureGroundTruth(
      "Bash",
      { command: "ls" },
      { exitCode: 2 },
      notRepo,
    ) as Record<string, unknown>;
    expect(gt.exit_code).toBe(2);
  });

  test("non-write / non-bash tool yields undefined ground_truth", () => {
    expect(captureGroundTruth("Read", { file_path: "/x/e.ts" }, undefined, notRepo)).toBeUndefined();
  });
});

describe("gitSnapshot — std/git fail-soft contract (real git over the std-public repo)", () => {
  test("returns a head + dirty for a real repo (this cwd IS a git repo)", () => {
    const snap: GitSnapshot = gitSnapshot(import.meta.dir);
    expect(snap).toBeDefined();
    expect(typeof snap?.head).toBe("string");
    expect((snap?.head ?? "").length).toBeGreaterThan(0);
    expect(typeof snap?.dirty).toBe("boolean");
  });

  test("non-repo cwd → undefined (fail-soft: empty head)", () => {
    expect(gitSnapshot("/")).toBeUndefined();
  });
});

describe("fail-open posture (AD-9.4 Rule 2 — unchanged) — null stdin → exit 0", () => {
  test("empty stdin → exit 0", async () => {
    const { code } = await fire("");
    expect(code).toBe(0);
  });
  test("malformed JSON stdin → exit 0, std imports resolved (no 'Cannot find module')", async () => {
    const { code, stderr } = await fire("{not json");
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
  });
});
