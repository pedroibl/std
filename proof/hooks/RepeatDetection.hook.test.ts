// RepeatDetection.hook.test.ts — proves the sync→async migration preserves BOTH exit paths:
//   • fail-OPEN null read (empty / malformed stdin) → exit 0 (a bad read never blocks a prompt)
//   • the DELIBERATE duplicate-prompt block → exit 2 (survives the conversion, stderr flushed)
// Hermetic: HOME is redirected to a temp dir so the real ~/.claude/PAI/MEMORY/STATE/last-prompt.json
// is never touched.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = `${import.meta.dir}/RepeatDetection.hook.ts`;
const homes: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "repeat-detect-"));
  mkdirSync(join(home, ".claude", "PAI", "MEMORY", "STATE"), { recursive: true });
  homes.push(home);
  return home;
}

async function fire(input: string, home: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

describe("RepeatDetection — sync→async, fail-OPEN null + preserved exit-2 block", () => {
  test("empty stdin → null → exit 0 (fail-open), door resolved", async () => {
    const { code, stderr } = await fire("", freshHome());
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
  });

  test("malformed JSON stdin → null → exit 0 (fail-open)", async () => {
    const { code } = await fire("{not json", freshHome());
    expect(code).toBe(0);
  });

  test("first prompt (no prior state) → exit 0 and writes state", async () => {
    const home = freshHome();
    const ev = JSON.stringify({ session_id: "S1", prompt: "please refactor the auth module to use rotating tokens" });
    const { code } = await fire(ev, home);
    expect(code).toBe(0);
    expect(existsSync(join(home, ".claude", "PAI", "MEMORY", "STATE", "last-prompt.json"))).toBe(true);
  });

  test("repeated identical prompt in same session → exit 2 (deliberate block preserved)", async () => {
    const home = freshHome();
    const ev = JSON.stringify({ session_id: "S1", prompt: "please refactor the auth module to use rotating tokens" });
    const first = await fire(ev, home); // saves state, exit 0
    expect(first.code).toBe(0);
    const second = await fire(ev, home); // similarity 1.0 ≥ 0.6 → exit 2
    expect(second.code).toBe(2);
    expect(second.stderr).toContain("REPEAT DETECTION");
  });

  test("short message (<20 chars) → exit 0, never blocks", async () => {
    const { code } = await fire(JSON.stringify({ session_id: "S1", prompt: "ok thanks" }), freshHome());
    expect(code).toBe(0);
  });

  test("<task-notification> is exempt → exit 0 even if repeated", async () => {
    const home = freshHome();
    const ev = JSON.stringify({ session_id: "S1", prompt: "<task-notification> watchdog for 13.8 review completed successfully" });
    await fire(ev, home);
    const { code } = await fire(ev, home);
    expect(code).toBe(0);
  });
});
