import { expect, test, describe } from "bun:test";

const HOOK = `${import.meta.dir}/IntegrityCheck.hook.ts`;

/** Run the hook as the harness would — `bun IntegrityCheck.hook.ts` with `input` piped to stdin. */
async function fire(input: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

describe("fail-OPEN posture (AD-9.4 Rule 2 — PRESERVED, stricter-than-null guard) — null → exit 0", () => {
  // readStdinJson returns null on empty/malformed; `!null?.transcript_path` → exit 0 BEFORE any delegate call.
  test("empty stdin → exit 0 (no transcript_path)", async () => {
    const { code } = await fire("");
    expect(code).toBe(0);
  });

  test("malformed JSON stdin → exit 0, std imports resolved (no 'Cannot find module')", async () => {
    const { code, stderr } = await fire("{not json");
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
  });

  test("valid JSON but missing transcript_path → exit 0 (stricter guard subsumes null-check)", async () => {
    const { code, stderr } = await fire(JSON.stringify({ session_id: "s1", hook_event_name: "SessionEnd" }));
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
  });

  test("empty-string transcript_path → exit 0 (falsy, guard catches it)", async () => {
    const { code } = await fire(JSON.stringify({ session_id: "s1", transcript_path: "", hook_event_name: "SessionEnd" }));
    expect(code).toBe(0);
  });
});
