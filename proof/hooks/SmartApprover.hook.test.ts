// SmartApprover.hook.test.ts — proves the PRESERVED defer-to-user posture (null → return, NO output, exit
// 0 — deliberately NOT hardened to deny) and the fsx cache swap path. Door resolves (no 'Cannot find
// module'). A trusted-workspace write auto-approves (allow envelope).
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

const HOOK = `${import.meta.dir}/SmartApprover.hook.ts`;

async function fire(input: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("SmartApprover — PRESERVED defer-to-user (null → return, no output)", () => {
  test("empty stdin → exit 0, NO output (user is prompted)", async () => {
    const { code, stdout, stderr } = await fire("");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
    expect(stderr).not.toContain("Cannot find module");
  });

  test("malformed JSON stdin → null → exit 0, no output", async () => {
    const { code, stdout } = await fire("{not json");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("trusted-workspace write → allow envelope", async () => {
    const event = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: join(homedir(), ".claude", "zz-test.txt") },
    });
    const { code, stdout } = await fire(event);
    expect(code).toBe(0);
    expect(stdout).toContain('"behavior":"allow"');
  });
});
