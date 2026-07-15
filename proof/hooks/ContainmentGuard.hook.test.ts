// ContainmentGuard.hook.test.ts — proves the HARDENED fail-CLOSED posture (null → exit 2) AND the
// sync→async migration (the awaited reader still flushes exit(2) before the process ends), plus the
// preserved containment behavior: a leak OUTSIDE the Z1-Z4 zones denies, a write INSIDE a zone allows.
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

const HOOK = `${import.meta.dir}/ContainmentGuard.hook.ts`;
const CLAUDE = join(homedir(), ".claude");

async function fire(input: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

describe("ContainmentGuard — HARDENED fail-CLOSED (null → exit 2) + sync→async migration", () => {
  test("empty stdin → exit 2 (deny), door resolved, flush intact", async () => {
    const { code, stderr } = await fire("");
    expect(code).toBe(2);
    expect(stderr).not.toContain("Cannot find module");
    expect(stderr).toContain("fail-closed");
  });

  test("malformed JSON stdin → null → exit 2 (deny)", async () => {
    const { code } = await fire("{not json");
    expect(code).toBe(2);
  });

  test("leak OUTSIDE the containment zones → exit 2 (deny)", async () => {
    // commands/ is under ~/.claude but is NOT a containment zone → identity string must be blocked.
    // NOTE: the hook only reads stdin + inspects the string; no file is ever written.
    const event = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: join(CLAUDE, "commands", "zz-leak-test.ts"), content: "const u = '/Users/daniel';" },
    });
    const { code } = await fire(event);
    expect(code).toBe(2);
  });

  test("write INSIDE a zone (PAI/USER/**) → exit 0 (allowed)", async () => {
    const event = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: join(CLAUDE, "PAI", "USER", "zz-test.md"), content: "contact daniel@ example" },
    });
    const { code } = await fire(event);
    expect(code).toBe(0);
  });

  test("non-Edit/Write tool → exit 0 (nothing to scan)", async () => {
    const { code } = await fire(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } }));
    expect(code).toBe(0);
  });
});
