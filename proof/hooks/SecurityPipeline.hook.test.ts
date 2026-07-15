// SecurityPipeline.hook.test.ts — proves the HARDENED fail-CLOSED posture (AD-9.4 Rule 2, the crux): a
// wired PreToolUse gate that cannot read its event must DENY (exit 2), and the std/stdio door resolves at
// runtime (no 'Cannot find module'). A benign event under a permissive temp PATTERNS.yaml still ALLOWS
// (exit 0) — proving the hardening did not turn the gate into deny-everything.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = `${import.meta.dir}/SecurityPipeline.hook.ts`;

async function fire(input: string, env?: Record<string, string>): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : process.env,
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "secpipe-"));
});
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("SecurityPipeline — HARDENED fail-CLOSED (null → exit 2)", () => {
  test("empty stdin → exit 2 (deny), std/stdio door resolved", async () => {
    const { code, stderr } = await fire("");
    expect(code).toBe(2);
    expect(stderr).not.toContain("Cannot find module");
    expect(stderr).toContain("fail-closed");
  });

  test("malformed JSON stdin → null → exit 2 (deny)", async () => {
    const { code, stderr } = await fire("{not json");
    expect(code).toBe(2);
    expect(stderr).not.toContain("Cannot find module");
  });

  test("benign Read event under a permissive PATTERNS.yaml → exit 0 (not deny-everything)", async () => {
    const dir = join(root, "USER", "SECURITY");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "PATTERNS.yaml"),
      `version: "1"\nbash:\n  trusted: []\n  blocked: []\n  confirm: []\n  alert: []\npaths:\n  zeroAccess: []\n  alertAccess: []\n  confirmAccess: []\n  readOnly: []\n  confirmWrite: []\n  noDelete: []\n`,
    );
    const event = JSON.stringify({ session_id: "s", tool_name: "Read", tool_input: { file_path: "/tmp/benign.txt" } });
    const { code, stderr } = await fire(event, { PAI_DIR: root });
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
  });
});
