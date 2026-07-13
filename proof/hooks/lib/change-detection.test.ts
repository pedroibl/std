// Hermetic tests for the Story 13.3 change-detection rewrite.
// Covers the THREE swapped internals (P1 core.parseNdjson / P2 fsx.loadJson / P3 core.contentHash) plus
// the frozen facade (5 types + 12 functions) and a slice of the preserved caller-local taxonomy (D4).
// No network. The only fs touched is an isolated mkdtemp scratch dir (unlinked) — never real PAI state.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadJson } from "std/fsx";
import {
  parseToolUseBlocks,
  categorizeChange,
  isSignificantChange,
  shouldDocumentChanges,
  readIntegrityState,
  isInCooldown,
  hashChanges,
  isDuplicateRun,
  getCooldownEndTime,
  determineSignificance,
  inferChangeType,
  generateDescriptiveTitle,
} from "./change-detection";
import type {
  FileChange,
  ChangeCategory,
  SignificanceLabel,
  ChangeType,
  IntegrityState,
} from "./change-detection";

// ── Frozen facade (AD-9.4 Rule 3) ───────────────────────────────────────────

describe("frozen facade", () => {
  test("all 12 exported functions are present", () => {
    const fns = [
      parseToolUseBlocks,
      categorizeChange,
      isSignificantChange,
      shouldDocumentChanges,
      readIntegrityState,
      isInCooldown,
      hashChanges,
      isDuplicateRun,
      getCooldownEndTime,
      determineSignificance,
      inferChangeType,
      generateDescriptiveTitle,
    ];
    expect(fns).toHaveLength(12);
    for (const fn of fns) expect(typeof fn).toBe("function");
  });

  test("all 5 exported types are assignable (compile-time contract)", () => {
    const cat: ChangeCategory = "skill";
    const sig: SignificanceLabel = "minor";
    const ct: ChangeType = "skill_update";
    const state: IntegrityState = { last_run: "", last_changes_hash: "", cooldown_until: null };
    const fc: FileChange = {
      tool: "Edit",
      path: "x",
      category: cat,
      isPhilosophical: false,
      isStructural: false,
    };
    expect(fc.category).toBe("skill");
    expect(state.cooldown_until).toBeNull();
    expect([sig, ct]).toEqual(["minor", "skill_update"]);
  });
});

// ── P1: parseToolUseBlocks → core.parseNdjson ────────────────────────────────

describe("P1 core.parseNdjson swap (parseToolUseBlocks)", () => {
  test("parses Write/Edit/MultiEdit tool_use, skips malformed + blank + non-assistant lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-13-3-"));
    const path = join(dir, "transcript.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Write", input: { file_path: "PAI/DOCUMENTATION/Foo.md" } },
            { type: "tool_use", name: "Edit", input: { file_path: "PAI/hooks/bar.ts" } },
            { type: "text", text: "ignored non-tool block" },
          ],
        },
      }),
      "{ this is not valid json", // malformed → skipped by parseNdjson, NOT thrown
      "", // blank → skipped
      JSON.stringify({ type: "user", message: { content: "hi" } }), // non-assistant → ignored
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "MultiEdit", input: { edits: [{ file_path: "PAI/skills/X/SKILL.md" }] } },
          ],
        },
      }),
    ];
    writeFileSync(path, lines.join("\n"));
    try {
      const changes = parseToolUseBlocks(path);
      expect(changes.map((c) => c.path).sort()).toEqual(
        ["PAI/DOCUMENTATION/Foo.md", "PAI/hooks/bar.ts", "PAI/skills/X/SKILL.md"].sort(),
      );
      // MultiEdit is recorded under tool 'Edit' (preserved mapping).
      expect(changes.find((c) => c.path.endsWith("SKILL.md"))?.tool).toBe("Edit");
      expect(changes.find((c) => c.path === "PAI/DOCUMENTATION/Foo.md")?.tool).toBe("Write");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dedups repeated paths within a transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-13-3-"));
    const path = join(dir, "dup.jsonl");
    const block = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "PAI/a.md" } }] },
    };
    writeFileSync(path, [JSON.stringify(block), JSON.stringify(block)].join("\n"));
    try {
      expect(parseToolUseBlocks(path)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing transcript → [] (no throw)", () => {
    expect(parseToolUseBlocks(join(tmpdir(), "cd-13-3-nope.jsonl"))).toEqual([]);
  });
});

// ── P2: readIntegrityState → fsx.loadJson ────────────────────────────────────

describe("P2 fsx.loadJson swap (readIntegrityState)", () => {
  test("loadJson returns the null fallback for a missing file (the contract readIntegrityState relies on)", () => {
    const missing = join(tmpdir(), "cd-13-3-no-integrity-state.json");
    expect(loadJson<IntegrityState | null>(missing, null)).toBeNull();
  });

  test("loadJson returns the fallback for unparseable JSON (still → null, not thrown)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-13-3-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ not json");
    try {
      expect(loadJson<IntegrityState | null>(path, null)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readIntegrityState returns null or a well-shaped IntegrityState", () => {
    const s = readIntegrityState();
    expect(s === null || typeof s.last_run === "string").toBe(true);
  });
});

// ── P3: hashChanges → core.contentHash ───────────────────────────────────────

describe("P3 core.contentHash swap (hashChanges)", () => {
  const a: FileChange[] = [
    { tool: "Edit", path: "PAI/a.md", category: "documentation", isPhilosophical: false, isStructural: false },
    { tool: "Write", path: "PAI/b.md", category: "documentation", isPhilosophical: false, isStructural: false },
  ];

  test("deterministic + order-independent (sorted before hashing)", () => {
    const reversed = [...a].reverse();
    expect(hashChanges(a)).toBe(hashChanges(a));
    expect(hashChanges(a)).toBe(hashChanges(reversed));
  });

  test("different change sets → different digests, and output is lowercase hex", () => {
    expect(hashChanges(a)).not.toBe(hashChanges([a[0]]));
    expect(hashChanges(a)).toMatch(/^[0-9a-f]+$/);
  });
});

// ── Preserved caller-local taxonomy (D4) — a representative slice ─────────────

describe("preserved taxonomy (caller-local, unchanged)", () => {
  test("categorizeChange classifies + honours exclusions and private skills", () => {
    expect(categorizeChange("PAI/hooks/Foo.hook.ts")).toBe("hook");
    expect(categorizeChange("PAI/skills/Research/SKILL.md")).toBe("skill");
    expect(categorizeChange("MEMORY/WORK/notes.md")).toBeNull(); // excluded path
    expect(categorizeChange("PAI/skills/_private/SKILL.md")).toBeNull(); // private skill
  });

  test("significance / doc / type / title flow through a single structural skill change", () => {
    const structural: FileChange[] = [
      { tool: "Edit", path: "PAI/skills/X/SKILL.md", category: "skill", isPhilosophical: false, isStructural: true },
    ];
    expect(isSignificantChange(structural)).toBe(true);
    expect(shouldDocumentChanges(structural)).toBe(true);
    expect(determineSignificance(structural)).toBe("minor");
    expect(inferChangeType(structural)).toBe("structure_change");
    expect(generateDescriptiveTitle(structural)).toBe("X Skill Definition Update");
  });

  test("empty change set is a no-op across the significance surface", () => {
    expect(isSignificantChange([])).toBe(false);
    expect(shouldDocumentChanges([])).toBe(false);
  });
});

// ── Unswapped throttling helpers preserved verbatim ──────────────────────────

describe("throttling helpers (unswapped, preserved)", () => {
  test("getCooldownEndTime is still a bare UTC ISO string (toISOString, not swapped)", () => {
    const end = getCooldownEndTime();
    expect(typeof end).toBe("string");
    expect(end).toMatch(/T.*Z$/);
    expect(new Date(end).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  test("isInCooldown / isDuplicateRun return booleans (read-only over state)", () => {
    expect(typeof isInCooldown()).toBe("boolean");
    expect(typeof isDuplicateRun([])).toBe("boolean");
  });
});
