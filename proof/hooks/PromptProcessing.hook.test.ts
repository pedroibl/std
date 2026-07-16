// PromptProcessing.hook.test.ts — the story's SIGNATURE exhaustive exit-path test (highest-blast hook).
// Asserts EVERY REACHABLE path exits 0 (never blocks a prompt) and that the async envelope (the
// emitAdditionalContext console.log) flushes BEFORE process.exit on the fast paths. Hermetic: PAI_DIR is
// redirected to a temp tree so session-names.json / WORK state land there (pushStateToTargets early-returns
// with no WORK json). NOTE (per story Testing Standards): we deliberately do NOT force a mid-try throw
// expecting the outer catch (:1071) to exit 0 — that path is pre-existing broken (block-scoped kvPush,
// validator E1) and out of scope. The kvPush try-scope is preserved (NOT hoisted).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = `${import.meta.dir}/PromptProcessing.hook.ts`;
const dirs: string[] = [];

function freshPai(): string {
  const pai = mkdtempSync(join(tmpdir(), "prompt-proc-"));
  dirs.push(pai);
  return pai;
}

async function fire(input: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PAI_DIR: freshPai() },
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("PromptProcessing — every reachable path exits 0 (async:true, never blocks)", () => {
  test("empty stdin → P1 null guard → exit 0, door resolved", async () => {
    const { code, stderr } = await fire("");
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
  });

  test("malformed JSON stdin → P1 null guard → exit 0 (no JSON.parse('') crash)", async () => {
    const { code } = await fire("{not json");
    expect(code).toBe(0);
  });

  test("no prompt (empty) → exit 0 (:823 guard)", async () => {
    const { code } = await fire(JSON.stringify({ session_id: "S1" }));
    expect(code).toBe(0);
  });

  test("no sessionId → exit 0 (:823 guard)", async () => {
    const { code } = await fire(JSON.stringify({ prompt: "build the whole PAI dashboard system now" }));
    expect(code).toBe(0);
  });

  test("explicit rating → MINIMAL fast-path → exit 0, envelope flushed", async () => {
    const { code, stdout } = await fire(JSON.stringify({ session_id: "S1", prompt: "8", transcript_path: "" }));
    expect(code).toBe(0);
    // emitAdditionalContext ran (console.log JSON) BEFORE process.exit → the async envelope flushed.
    expect(stdout).toContain("MINIMAL");
    expect(stdout).toContain("UserPromptSubmit");
  });

  test("positive praise → MINIMAL fast-path → exit 0, envelope flushed", async () => {
    const { code, stdout } = await fire(JSON.stringify({ session_id: "S1", prompt: "excellent", transcript_path: "" }));
    expect(code).toBe(0);
    expect(stdout).toContain("MINIMAL");
  });

  test("system text (<task-notification>) → skip fast-path → exit 0", async () => {
    const { code } = await fire(JSON.stringify({ session_id: "S1", prompt: "<task-notification> watchdog done", transcript_path: "" }));
    expect(code).toBe(0);
  });

  test("too-short prompt → MINIMAL fast-path → exit 0", async () => {
    const { code, stdout } = await fire(JSON.stringify({ session_id: "S1", prompt: "x", transcript_path: "" }));
    expect(code).toBe(0);
    expect(stdout).toContain("MINIMAL");
  });
});
