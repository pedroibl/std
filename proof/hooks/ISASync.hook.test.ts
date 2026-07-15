import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = `${import.meta.dir}/ISASync.hook.ts`;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Run the hook as the harness would — `bun ISASync.hook.ts` with `input` piped to stdin. `env` overrides
 *  PAI_DIR so every filesystem side-effect lands in a temp tree, never Pedro's real ~/.claude. */
async function fire(input: string, env?: Record<string, string>): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

function tempPaiDir(): string {
  const root = mkdtempSync(join(tmpdir(), "isasync-fire-"));
  roots.push(root);
  return join(root, "PAI");
}

describe("fail-OPEN posture (AD-9.4 Rule 2) — null stdin → exit 0 + door resolves", () => {
  test("empty stdin → exit 0", async () => {
    const { code } = await fire("");
    expect(code).toBe(0);
  });

  test("malformed JSON stdin → exit 0, std/* imports resolved (envelope flushes past the await)", async () => {
    const { code, stderr } = await fire("{not json");
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
  });
});

describe("filter — a non-MEMORY/WORK path writes nothing", () => {
  test("Write to an unrelated file → exit 0, no work.json created", async () => {
    const paiDir = tempPaiDir();
    const input = JSON.stringify({
      tool_input: { file_path: "/some/other/place/notes.md" },
      session_id: "s-x",
    });
    const { code } = await fire(input, { PAI_DIR: paiDir });
    expect(code).toBe(0);
    expect(existsSync(join(paiDir, "MEMORY", "STATE", "work.json"))).toBe(false);
  });
});

describe("happy path — a real ISA write syncs the session into work.json (side-effect lands)", () => {
  test(
    "Write to MEMORY/WORK/<slug>/ISA.md → work.json gains the session (collapsed facade round-trip)",
    async () => {
      const paiDir = tempPaiDir();
      const slug = "my-sess";
      const isaPath = join(paiDir, "MEMORY", "WORK", slug, "ISA.md");
      mkdirSync(join(paiDir, "MEMORY", "WORK", slug), { recursive: true });
      writeFileSync(
        isaPath,
        `---
isa: true
slug: ${slug}
phase: build
progress: 1/2
title: "Prove the sync"
---

# Prove the sync

## ISC Criteria
- [x] ISC-1: first
- [ ] ISC-2: second
`,
      );

      const input = JSON.stringify({ tool_input: { file_path: isaPath }, session_id: "sess-uuid-1" });
      const { code, stderr } = await fire(input, { PAI_DIR: paiDir });

      expect(code).toBe(0);
      expect(stderr).not.toContain("Cannot find module"); // door resolves at runtime
      const workJsonPath = join(paiDir, "MEMORY", "STATE", "work.json");
      expect(existsSync(workJsonPath)).toBe(true);
      const registry = JSON.parse(readFileSync(workJsonPath, "utf-8"));
      expect(registry.sessions[slug]).toBeDefined();
      expect(registry.sessions[slug].phase).toBe("build");
      expect(registry.sessions[slug].task).toBe("Prove the sync");
      // parseFrontmatter shape-adapt worked (scalar fields), parseCriteriaList ran through the facade:
      expect(registry.sessions[slug].criteria.map((c: any) => c.id)).toEqual(["ISC-1", "ISC-2"]);
      expect(registry.sessions[slug].progress).toBe("1/2");
    },
    20000,
  );
});
