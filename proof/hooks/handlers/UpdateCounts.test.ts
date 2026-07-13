import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";

import {
  assembleCounts,
  classifySkills,
  countHooks,
  countWorkflowFiles,
  formatSummary,
  isWorkflowMd,
} from "./UpdateCounts";

describe("countHooks — the load-bearing rule: UNIQUE WIRED COMMANDS, not .hook.ts files", () => {
  test("counts distinct command strings across events; a command wired under 2 events counts once", () => {
    const settings = {
      hooks: {
        PostToolUse: [{ hooks: [{ command: "a.ts" }, { command: "b.ts" }] }],
        SessionEnd: [{ hooks: [{ command: "b.ts" }, { command: "c.ts" }] }], // b.ts repeats → dedup
      },
    };
    expect(countHooks(settings)).toBe(3); // a, b, c
  });

  test("skips malformed / non-array shapes and empty commands; {} → 0", () => {
    expect(countHooks({})).toBe(0);
    expect(countHooks({ hooks: {} })).toBe(0);
    expect(countHooks({ hooks: { E: "nope" } })).toBe(0);
    expect(countHooks({ hooks: { E: [{ hooks: [{ command: "" }] }] } })).toBe(0); // empty cmd not counted
    expect(countHooks(null)).toBe(0);
  });
});

describe("classifySkills — the `_`-prefix = private rule; dir + SKILL.md required", () => {
  test("splits public vs private, requires isDir && hasSkillMd, total = pub + priv", () => {
    const r = classifySkills([
      { name: "Art", isDir: true, hasSkillMd: true }, // public
      { name: "_CreateStdTool", isDir: true, hasSkillMd: true }, // private (_)
      { name: "NoMd", isDir: true, hasSkillMd: false }, // skipped (no SKILL.md)
      { name: "loose.md", isDir: false, hasSkillMd: true }, // skipped (not a dir)
    ]);
    expect(r).toEqual({ total: 2, pub: 1, priv: 1 });
  });
});

describe("isWorkflowMd — .md under any Workflows/ dir at any depth, filename excluded", () => {
  test("matches .md under Workflows/ (case-insensitive), rejects otherwise", () => {
    expect(isWorkflowMd("/s/Art/Workflows/Essay.md")).toBe(true);
    expect(isWorkflowMd("/s/Art/workflows/deep/x.md")).toBe(true); // case-insensitive, any depth
    expect(isWorkflowMd("/s/Art/Workflows/notes.txt")).toBe(false); // not .md
    expect(isWorkflowMd("/s/Art/SKILL.md")).toBe(false); // not under Workflows/
    expect(isWorkflowMd("/s/Workflows.md")).toBe(false); // Workflows is the filename, not a dir segment
  });
});

describe("assembleCounts / formatSummary — frozen shape + byte-exact summary", () => {
  const parts = {
    skills: { total: 5, pub: 3, priv: 2 },
    workflows: 7,
    hooks: 11,
    signals: 9,
    files: 42,
    work: 4,
    sessions: 100,
    research: 8,
    ratings: 20,
  };
  test("updatedAt is FROZEN UTC toISOString (NOT isoOffset)", () => {
    const c = assembleCounts(parts, new Date("2026-07-13T15:00:00.000Z"));
    expect(c.updatedAt).toBe("2026-07-13T15:00:00.000Z"); // UTC `…Z`, not a tz-offset
    expect(c.skills).toBe(5);
    expect(c.skillsPublic).toBe(3);
    expect(c.skillsPrivate).toBe(2);
  });
  test("summary line byte-exact", () => {
    const c = assembleCounts(parts, new Date("2026-07-13T00:00:00.000Z"));
    expect(formatSummary(c)).toBe(
      "[UpdateCounts] Updated: SK:3pu/2pv WF:7 HK:11 SIG:9 F:42 W:4 SESS:100 RES:8 RAT:20",
    );
  });
});

describe("countWorkflowFiles — NO-FOLLOW-SYMLINKS (the different-LLM-review 187→190 regression)", () => {
  // The original readdirSync+isDirectory() never descended a symlinked dir; walkFiles (statSync) does.
  // A symlinked skill dir (like ~/.claude/skills/_CreateStdTool → std-customisations) must NOT leak its
  // Workflows/*.md into the count. This fixture reproduces exactly that shape.
  const root = join(import.meta.dir, `__wf_fixture_${process.pid}`);
  const realSkill = join(root, "RealSkill");
  // The symlink target lives OUTSIDE the walked tree (mirrors _CreateStdTool → ~/Dev/std-customisations),
  // so its workflow is reachable ONLY by following the symlink — exactly the case the guard must exclude.
  const externalTarget = join(import.meta.dir, `__wf_external_${process.pid}`);

  beforeAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(externalTarget, { recursive: true, force: true });
    // A REAL skill dir with one workflow .md → counts.
    mkdirSync(join(realSkill, "Workflows"), { recursive: true });
    writeFileSync(join(realSkill, "Workflows", "Essay.md"), "# real");
    // An external target (outside root) with its own workflow, reached ONLY via the symlinked skill → must NOT count.
    mkdirSync(join(externalTarget, "Workflows"), { recursive: true });
    writeFileSync(join(externalTarget, "Workflows", "Leaked.md"), "# should not count");
    symlinkSync(externalTarget, join(root, "_SymlinkedSkill"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(externalTarget, { recursive: true, force: true });
  });

  test("counts only the real skill's workflow, prunes the symlinked skill (1, not 2)", () => {
    // 2 == the pre-fix defect (walkFiles follows the symlink); 1 == the original readdirSync semantics.
    expect(countWorkflowFiles(root)).toBe(1);
  });
});
