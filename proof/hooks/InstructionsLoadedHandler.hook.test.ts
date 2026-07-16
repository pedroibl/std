// InstructionsLoadedHandler.hook.test.ts — dormant InstructionsLoaded hook. Proves: door resolves,
// always exits 0 (fail-open), stdin is consumed+discarded, and the adopted report.appendJsonlEvent
// writes the integrity log. Hermetic: PAI_DIR is redirected so the baseline/log land in a temp tree.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = `${import.meta.dir}/InstructionsLoadedHandler.hook.ts`;
const dirs: string[] = [];

function freshPai(): string {
  const pai = mkdtempSync(join(tmpdir(), "instr-loaded-"));
  dirs.push(pai);
  return pai;
}

async function fire(input: string, paiDir: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PAI_DIR: paiDir },
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("InstructionsLoadedHandler — dormant, fail-open, appendJsonlEvent side-effect", () => {
  test("first run → exit 0, door resolved, baseline logged via appendJsonlEvent", async () => {
    const pai = freshPai();
    const { code, stderr } = await fire(JSON.stringify({ event: "instructions-loaded" }), pai);
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
    const log = readFileSync(join(pai, "MEMORY", "STATE", "instruction-integrity.jsonl"), "utf-8");
    expect(log).toContain("baseline_created");
  });

  test("empty stdin (discard tolerates it) → exit 0", async () => {
    const { code } = await fire("", freshPai());
    expect(code).toBe(0);
  });
});
