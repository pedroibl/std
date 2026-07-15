// ContentScanner.hook.test.ts — proves the DOCUMENTED fail-OPEN EXCEPTION (this wired hook fires on
// PostToolUse, which cannot block): null → exit 0, NOT deny. Door resolves (no 'Cannot find module').
import { describe, expect, test } from "bun:test";

const HOOK = `${import.meta.dir}/ContentScanner.hook.ts`;

async function fire(input: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

describe("ContentScanner — DOCUMENTED fail-OPEN (PostToolUse cannot block; null → exit 0)", () => {
  test("empty stdin → exit 0, std/stdio door resolved", async () => {
    const { code, stderr } = await fire("");
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
  });

  test("malformed JSON stdin → null → exit 0", async () => {
    const { code } = await fire("{not json");
    expect(code).toBe(0);
  });

  test("benign WebFetch result → exit 0", async () => {
    const { code } = await fire(
      JSON.stringify({ session_id: "s", tool_name: "WebFetch", tool_input: { url: "https://x.example" }, tool_result: "Weather today is mild." }),
    );
    expect(code).toBe(0);
  });
});
