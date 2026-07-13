import { describe, expect, test } from "bun:test";

import { buildFailureEvent } from "./tool-failure-tracker";

const HOOK = `${import.meta.dir}/tool-failure-tracker.ts`;

/** Run the hook as the harness would — `bun tool-failure-tracker.ts` with `input` piped to stdin. */
async function fire(input: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

// ToolFailureInput is caller-local (not exported); recover its type from the function signature.
type Input = Parameters<typeof buildFailureEvent>[0];

describe("buildFailureEvent — pure event shaping (P3 isoOffset + field mapping)", () => {
  const input: Input = {
    session_id: "s1",
    transcript_path: "/tmp/t",
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    error: "boom",
  };

  test("stamps a tz-offset ISO timestamp via isoOffset (Australia/Melbourne)", () => {
    const e = buildFailureEvent(input, new Date("2026-07-13T15:00:00Z"), "Australia/Melbourne");
    expect(e.timestamp).toBe("2026-07-14T01:00:00+10:00"); // AEST +10:00, day rolls over
    expect(e.event).toBe("tool_failure");
    expect(e.session_id).toBe("s1");
    expect(e.tool_name).toBe("Bash");
    expect(e.error).toBe("boom");
    expect(JSON.parse(e.tool_input_preview)).toEqual({ command: "ls" });
  });

  test("defaults missing tool_name/error and truncates a long input preview at 500", () => {
    const big = { command: "x".repeat(1000) };
    const e = buildFailureEvent(
      { session_id: "s2", tool_input: big } as unknown as Input,
      new Date("2026-07-13T00:00:00Z"),
      "UTC",
    );
    expect(e.tool_name).toBe("unknown");
    expect(e.error).toBe("unknown error");
    expect(e.tool_input_preview.endsWith("...")).toBe(true);
    expect(e.tool_input_preview.length).toBe(503); // 500 + "..."
    expect(e.timestamp).toBe("2026-07-13T00:00:00+00:00");
  });

  test("caps error at 1000 chars", () => {
    const e = buildFailureEvent(
      { session_id: "s3", error: "e".repeat(5000) } as unknown as Input,
      new Date("2026-07-13T00:00:00Z"),
      "UTC",
    );
    expect(e.error.length).toBe(1000);
  });
});

describe("fail-open posture (AD-9.4 Rule 2) — null → exit 0, no throw, no write", () => {
  // readStdinJson returns null for empty/malformed → the hook's visible branch exits 0 BEFORE any write.
  // (Runs the code in std-public where std/* self-resolves; the ~/.claude DOOR is proven live in Task 7.)
  test("empty stdin → exit 0", async () => {
    const { code } = await fire("");
    expect(code).toBe(0);
  });

  test("malformed JSON stdin → exit 0 (posture-neutral: silent, not a thrown error)", async () => {
    const { code, stderr } = await fire("{not json");
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module"); // the std imports resolved at runtime
  });
});
