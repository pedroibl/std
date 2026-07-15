import { describe, expect, test } from "bun:test";

import { analyzeForRelationship } from "./RelationshipMemory.hook";

const HOOK = `${import.meta.dir}/RelationshipMemory.hook.ts`;

/** Fire the hook as the harness would — `bun RelationshipMemory.hook.ts` with `input` on stdin. */
async function fire(input: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

// Story 13.4 — the DEFER: analyzeForRelationship is multi-label membership with snippet-payload retention
// (5 independent named boolean tests, per-category arrays, per-category thresholds), NOT core.scoreRules'
// single max-score winner. These tests lock the multi-label outcome so the DEFER stays intentional.

describe("analyzeForRelationship — multi-label classifier (DEFERred from scoreRules)", () => {
  test("2+ positive user messages → an O (opinion) positive note", () => {
    const notes = analyzeForRelationship([
      { type: "user", text: "that was great work on the hook" },
      { type: "user", text: "awesome, that looks good to me" },
    ]);
    const positive = notes.find((n) => n.type === "O" && n.content.includes("positively"));
    expect(positive).toBeDefined();
    expect(positive?.confidence).toBe(0.7);
  });

  test("assistant SUMMARY line → a B (biographical) note", () => {
    const notes = analyzeForRelationship([
      { type: "assistant", text: "SUMMARY: shipped the memory cluster rewrite" },
    ]);
    const bio = notes.find((n) => n.type === "B");
    expect(bio).toBeDefined();
    expect(bio?.content).toContain("shipped the memory cluster");
  });

  test("multi-label: positives AND a summary in one batch produce BOTH note kinds (scoreRules would keep one)", () => {
    const notes = analyzeForRelationship([
      { type: "user", text: "this is excellent, really nice work here" },
      { type: "user", text: "perfect, that works great for me" },
      { type: "assistant", text: "SUMMARY: finished the deploy and verified it" },
    ]);
    expect(notes.some((n) => n.type === "O")).toBe(true);
    expect(notes.some((n) => n.type === "B")).toBe(true);
  });

  test("short (<10 char) entries are ignored", () => {
    expect(analyzeForRelationship([{ type: "user", text: "great" }])).toEqual([]);
  });
});

describe("fail-OPEN posture (AD-9.4 Rule 2) — NET-NEW null → exit 0", () => {
  test("empty stdin → exit 0, std/stdio import resolved (no 'Cannot find module')", async () => {
    const { code, stderr } = await fire("");
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
  });

  test("malformed JSON stdin → null → exit 0 (visible guard, not a thrown JSON.parse)", async () => {
    const { code, stderr } = await fire("{not json");
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
  });
});
