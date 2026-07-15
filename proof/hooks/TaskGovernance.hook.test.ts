// TaskGovernance.hook.test.ts — proves the HARDENED fail-CLOSED posture (null → exit 2, closing the
// pre-13.6 fail-OPEN where an unreadable event threw → exit 1 → task created anyway) AND the preserved
// quality gate. The audit log rides std/report appendJsonlEvent (N3: object, not pre-stringified) — the
// valid path writes ONE JSONL line under a temp PAI_DIR. Door resolves (no 'Cannot find module').
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = `${import.meta.dir}/TaskGovernance.hook.ts`;

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
  root = mkdtempSync(join(tmpdir(), "taskgov-"));
});
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("TaskGovernance — HARDENED fail-CLOSED (null → exit 2) + appendJsonlEvent audit", () => {
  test("empty stdin → exit 2 (deny), door resolved", async () => {
    const { code, stderr } = await fire("", { PAI_DIR: root });
    expect(code).toBe(2);
    expect(stderr).not.toContain("Cannot find module");
    expect(stderr).toContain("fail-closed");
  });

  test("malformed JSON stdin → null → exit 2 (deny)", async () => {
    const { code } = await fire("{not json", { PAI_DIR: root });
    expect(code).toBe(2);
  });

  test("short description → exit 2 (preserved quality gate)", async () => {
    const { code } = await fire(JSON.stringify({ task_id: "t1", task_description: "too short" }), { PAI_DIR: root });
    expect(code).toBe(2);
  });

  test("valid task → exit 0 + ONE JSONL audit line (object not double-encoded)", async () => {
    const event = JSON.stringify({
      task_id: "t2",
      task_subject: "Do a real thing",
      task_description: "This is a sufficiently long task description for the quality gate.",
      teammate_name: "agent-x",
      team_name: "team-y",
    });
    const { code } = await fire(event, { PAI_DIR: root });
    expect(code).toBe(0);

    const secRoot = join(root, "MEMORY", "SECURITY");
    const files = readdirSync(secRoot, { recursive: true }) as string[];
    const rel = files.find((f) => typeof f === "string" && f.endsWith("task-governance.jsonl"));
    expect(rel).toBeDefined();
    const line = readFileSync(join(secRoot, rel as string), "utf-8").trim();
    // N3: a single JSON object per line — NOT a JSON-string-of-a-JSON-string (no leading '"{').
    expect(line.startsWith("{")).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ event: "task_created", task_id: "t2", subject: "Do a real thing" });
  });
});
