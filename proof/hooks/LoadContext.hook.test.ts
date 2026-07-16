// LoadContext.hook.test.ts — WIRED SessionStart hook, no stdin. Proves: door resolves, always exits 0,
// and the adopted primitives work end-to-end — core.getMetaField reads the opinion **Confidence:** value
// (≥0.85 → injected), and fsx.loadJson + core.isoDate drive the active-work summary. Hermetic: PAI_DIR is
// redirected to a temp tree (settings.json is read from the real ~/.claude but has no dynamicContext
// toggles, so all sections default-enabled — verified at author time).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = `${import.meta.dir}/LoadContext.hook.ts`;
const dirs: string[] = [];

function freshPai(): string {
  const pai = mkdtempSync(join(tmpdir(), "load-ctx-"));
  dirs.push(pai);
  return pai;
}

async function fire(paiDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Ensure the subagent short-circuit does NOT fire, so context loading runs.
    env: { ...process.env, PAI_DIR: paiDir, CLAUDE_PROJECT_DIR: "", CLAUDE_AGENT_TYPE: undefined as unknown as string },
  });
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

describe("LoadContext — SessionStart, getMetaField + loadJson + isoDate adopts", () => {
  test("empty PAI tree → exit 0, door resolved, session-ready line", async () => {
    const { code, stdout, stderr } = await fire(freshPai());
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
    expect(stdout).toContain("PAI session");
  });

  test("high-confidence opinion (getMetaField ≥0.85) → injected into dynamic context", async () => {
    const pai = freshPai();
    mkdirSync(join(pai, "USER"), { recursive: true });
    writeFileSync(
      join(pai, "USER", "OPINIONS.md"),
      "### Systems beat discipline\n**Confidence:** 0.92\nsome body\n\n### Low one\n**Confidence:** 0.10\n",
    );
    const { code, stdout } = await fire(pai);
    expect(code).toBe(0);
    expect(stdout).toContain("Key Opinions (high confidence)");
    expect(stdout).toContain("Systems beat discipline (92%)");
    expect(stdout).not.toContain("Low one"); // 0.10 filtered out
  });

  test("active project progress (loadJson + isoDate) → active-work summary emitted", async () => {
    const pai = freshPai();
    mkdirSync(join(pai, "MEMORY", "STATE", "progress"), { recursive: true });
    writeFileSync(
      join(pai, "MEMORY", "STATE", "progress", "demo-progress.json"),
      JSON.stringify({
        project: "demo-project",
        status: "active",
        updated: "2026-07-16T00:00:00.000Z",
        objectives: ["ship it"],
        next_steps: ["merge"],
        handoff_notes: "wip",
      }),
    );
    const { code, stdout } = await fire(pai);
    expect(code).toBe(0);
    expect(stdout).toContain("ACTIVE WORK");
    expect(stdout).toContain("demo-project");
  });

  test("corrupt progress json → skipped, still exit 0 (loadJson fallback)", async () => {
    const pai = freshPai();
    mkdirSync(join(pai, "MEMORY", "STATE", "progress"), { recursive: true });
    writeFileSync(join(pai, "MEMORY", "STATE", "progress", "bad-progress.json"), "{not json");
    const { code } = await fire(pai);
    expect(code).toBe(0);
  });
});
