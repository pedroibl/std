// RestoreContext.hook.test.ts — dormant PostCompact hook, no stdin. Proves: door resolves, always
// exits 0, and the report.lines() assembly + Tier-2 extractSections emit the restoration block when
// identity content is present. Hermetic: PAI_DIR is redirected to a temp tree.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = `${import.meta.dir}/RestoreContext.hook.ts`;
const dirs: string[] = [];

function freshPai(): string {
  const pai = mkdtempSync(join(tmpdir(), "restore-ctx-"));
  dirs.push(pai);
  return pai;
}

async function fire(paiDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PAI_DIR: paiDir },
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

describe("RestoreContext — dormant PostCompact, always exit 0", () => {
  test("empty PAI tree → exit 0, door resolved, no crash", async () => {
    const { code, stderr } = await fire(freshPai());
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
  });

  test("DA_IDENTITY present → Tier-2 sections restored via report.lines()", async () => {
    const pai = freshPai();
    mkdirSync(join(pai, "USER"), { recursive: true });
    writeFileSync(
      join(pai, "USER", "DA_IDENTITY.md"),
      "## My Identity\nI am Tomé, Pedro's DA.\n\n## Other\nunrelated\n",
    );
    const { code, stdout, stderr } = await fire(pai);
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
    expect(stdout).toContain("PostCompact Context Restoration");
    expect(stdout).toContain("DA Identity (Critical Sections)");
    expect(stdout).toContain("I am Tomé");
  });
});
