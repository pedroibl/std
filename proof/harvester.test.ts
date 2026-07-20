// Self-test for the converged harvester (Story 11.1 / AC3 + AC7).
//
// Hermetic: a JSONL fixture written into a mkdtemp projects root + temp MEMORY
// dirs (no real ~/.claude reads), mirroring the Epic-10 fixture discipline.
// Asserts harvest parity vs the ProjectsHarvester project-tagged baseline modulo
// the three intentional deltas (Δ1 cross-session dedup / Δ2 queue trailing
// newline / Δ3 unified attribution), plus mine `sourceLine` correctness, the
// per-session >0.8-overlap dedup, and the dormant provenance seam.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildDigest,
  catalogPathFromArgv,
  defaultRoots,
  discoverSessions,
  harvestSession,
  loadCatalog,
  main,
  provenanceOf,
  queueCandidate,
  reduceLearnings,
  resolveDigestPath,
  runHarvest,
  runMine,
  targetFromArgv,
  unknownFlags,
  type HarvestedLearning,
  type MinedMemory,
  type Roots,
  type SessionRef,
} from "./harvester";

import type { Catalog } from "./skill-classifier";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type Entry = { type: "user" | "assistant"; content: string; timestamp: string };

function jsonl(entries: Entry[]): string {
  return entries
    .map((e) => JSON.stringify({ type: e.type, message: { content: e.content }, timestamp: e.timestamp }))
    .join("\n");
}

// Triggers, by design: 1 correction (user, →ALGORITHM via "approach"),
// 1 error (assistant, →SYSTEM via "module", passes isLearningCapture),
// 1 insight (assistant, →ALGORITHM). Plus mining: a decision (3 pattern hits)
// and a preference (2 hits), each >200 chars so confidence clears 0.3.
const CORRECTION = "Actually, I meant the other approach — let me clarify what I actually wanted here.";
const ERROR =
  "Error: the build failed because the module was not found; I then fixed it and resolved the broken import path.";
const INSIGHT = "Key insight: caching the lookup result avoids the repeated expensive call on every pass.";
const DECISION =
  "We decided to go with Postgres for the store. The decision is to migrate next sprint, and we chose Postgres over MySQL for its JSON support and the operational maturity it brings to the whole team here.";
const PREFERENCE =
  "Always use bun for this repo, never npm. The rule is to prefer bun when running any script, because bun runs TypeScript directly and keeps the toolchain consistent across every single project we maintain here.";

let root: string;
let roots: Roots;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harvester-proof-"));
  roots = {
    projectsRoot: join(root, "projects"),
    learningDir: join(root, "LEARNING"),
    queueDir: join(root, "queue"),
  };
  mkdirSync(roots.projectsRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSession(project: string, sid: string, body: string): string {
  const dir = join(roots.projectsRoot, project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sid}.jsonl`);
  writeFileSync(path, body);
  return path;
}

// ---------------------------------------------------------------------------
// Harvest path — project-tagged parity + Δ3 attribution
// ---------------------------------------------------------------------------

test("harvest writes project-tagged learning files with the unified attribution (Δ3)", () => {
  writeSession(
    "proj-alpha",
    "aaaaaaaa-0000-0000-0000-000000000001",
    jsonl([
      { type: "user", content: CORRECTION, timestamp: "2026-06-01T10:00:00.000Z" },
      { type: "assistant", content: ERROR, timestamp: "2026-06-01T10:01:00.000Z" },
      { type: "assistant", content: INSIGHT, timestamp: "2026-06-01T10:02:00.000Z" },
    ]),
  );

  const n = runHarvest(roots, {});
  expect(n).toBe(3); // correction + error + insight

  const files = allLearningFiles(roots);
  // Project-tagged filename: <date>_<time>_<type>_<project>_<sid8>.md
  const correction = files.find((f) => f.name.includes("_correction_proj-alpha_aaaaaaaa"));
  expect(correction).toBeDefined();

  const body = readFileSync(correction!.path, "utf-8");
  // Parity with the ProjectsHarvester frontmatter, modulo Δ3 attribution.
  expect(body).toContain("# Correction Learning");
  expect(body).toContain("**Project Slug:** proj-alpha");
  expect(body).toContain("**Category:** ALGORITHM");
  expect(body).toContain(CORRECTION); // raw .slice(0,500) — gap #3, no truncation
  expect(body).toContain("*Harvested by harvester from projects/ transcript*"); // Δ3
  expect(body).not.toContain("ProjectsHarvester");
  expect(body).not.toContain("SessionHarvester");

  // error learning → SYSTEM category (via "module"); proves getLearningCategory edge logic stayed.
  const error = files.find((f) => f.name.includes("_error_proj-alpha_"));
  expect(error).toBeDefined();
  expect(readFileSync(error!.path, "utf-8")).toContain("**Category:** SYSTEM");
});

// ---------------------------------------------------------------------------
// Δ1 — cross-session learnings dedup now applied for everyone
// ---------------------------------------------------------------------------

test("cross-session dedup collapses an identical learning across sessions, keeping the earliest (Δ1)", () => {
  // Same insight text in two different sessions (different projects even) →
  // one learning survives. ProjectsHarvester would have written both.
  writeSession(
    "proj-alpha",
    "aaaaaaaa-0000-0000-0000-000000000001",
    jsonl([{ type: "assistant", content: INSIGHT, timestamp: "2026-06-01T09:00:00.000Z" }]),
  );
  writeSession(
    "proj-beta",
    "bbbbbbbb-0000-0000-0000-000000000002",
    jsonl([{ type: "assistant", content: INSIGHT, timestamp: "2026-06-02T09:00:00.000Z" }]),
  );

  const n = runHarvest(roots, {});
  expect(n).toBe(1); // deduped from 2 → 1

  // The survivor keeps the EARLIER timestamp (2026-06-01).
  const files = allLearningFiles(roots).filter((f) => f.name.includes("_insight_"));
  expect(files.length).toBe(1);
  expect(readFileSync(files[0].path, "utf-8")).toContain("**Timestamp:** 2026-06-01T09:00:00.000Z");
});

test("reduceLearnings is a no-op when there is nothing to dedup", () => {
  const a: HarvestedLearning = {
    sessionId: "s1",
    project: "p",
    timestamp: "2026-06-01T00:00:00.000Z",
    category: "ALGORITHM",
    type: "insight",
    context: "",
    content: "one",
    source: "x",
  };
  const b: HarvestedLearning = { ...a, content: "two" };
  expect(reduceLearnings([a, b]).length).toBe(2);
});

// ---------------------------------------------------------------------------
// Mine path — sourceLine, provenance seam, Δ2, >0.8 dedup
// ---------------------------------------------------------------------------

test("mine stamps the correct raw sourceLine, carries the provenance seam, and writes Δ2 trailing newline", () => {
  // DECISION sits on raw line 2 (1-based). A blank line 3 would be dropped by
  // parseNdjson — the manual counter must still report line 2 for the decision.
  const sid = "cccccccc-0000-0000-0000-000000000003";
  const body = [
    JSON.stringify({ type: "user", message: { content: "hello there, just a short opener line" }, timestamp: "2026-06-03T10:00:00.000Z" }),
    JSON.stringify({ type: "assistant", message: { content: DECISION }, timestamp: "2026-06-03T10:01:00.000Z" }),
    "",
    JSON.stringify({ type: "assistant", message: { content: PREFERENCE }, timestamp: "2026-06-03T10:02:00.000Z" }),
  ].join("\n");
  writeSession("proj-alpha", sid, body);

  const total = runMine(roots, {});
  expect(total).toBe(2); // 1 decision + 1 preference

  const queueFiles = readdirSync(roots.queueDir).filter((f) => f.endsWith(".json"));
  expect(queueFiles.length).toBe(2);

  const decisionFile = queueFiles.find((f) => f.includes("_decision_"));
  expect(decisionFile).toBeDefined();
  // Filename encodes the raw 1-based line: decision is line 2.
  expect(decisionFile).toContain("_L2.json");

  const raw = readFileSync(join(roots.queueDir, decisionFile!), "utf-8");
  // Δ2 — saveJson appends a trailing newline; the originals did not.
  expect(raw.endsWith("}\n")).toBe(true);

  const candidate = JSON.parse(raw);
  // Project-tagged candidate shape (ProjectsHarvester parity).
  expect(candidate.tags).toContain("project:proj-alpha");
  expect(candidate.project).toBe("proj-alpha");
  // Dormant Epic-15 provenance seam — the full tuple is present.
  expect(candidate.provenance).toEqual({
    sessionId: sid,
    sourceLine: 2,
    timestamp: "2026-06-03T10:01:00.000Z",
    projectSlug: "proj-alpha",
  });

  // The preference candidate landed on raw line 4.
  expect(queueFiles.find((f) => f.includes("_preference_"))).toContain("_L4.json");
});

test("per-session >0.8 char-overlap dedup keeps one of two near-identical mined candidates", () => {
  // Two identical DECISION lines in the SAME session → charOverlap = 1.0 > 0.8.
  const sid = "dddddddd-0000-0000-0000-000000000004";
  const body = jsonl([
    { type: "assistant", content: DECISION, timestamp: "2026-06-04T10:00:00.000Z" },
    { type: "assistant", content: DECISION, timestamp: "2026-06-04T10:05:00.000Z" },
  ]);
  const path = writeSession("proj-alpha", sid, body);

  const ref: SessionRef = { path, project: "proj-alpha", mtime: 0 };
  const { mined } = harvestSession(ref, readFileSync(path, "utf-8"));
  const decisions = mined.filter((m) => m.memoryType === "decision");
  expect(decisions.length).toBe(1); // collapsed from 2 → 1
});

// ---------------------------------------------------------------------------
// Discovery — per-project --recent default, project slug from parent dir
// ---------------------------------------------------------------------------

test("discoverSessions tags each session with its parent-dir project slug", () => {
  writeSession("proj-alpha", "aaaaaaaa-0000-0000-0000-000000000001", jsonl([{ type: "user", content: CORRECTION, timestamp: "2026-06-01T10:00:00.000Z" }]));
  writeSession("proj-beta", "bbbbbbbb-0000-0000-0000-000000000002", jsonl([{ type: "user", content: CORRECTION, timestamp: "2026-06-02T10:00:00.000Z" }]));

  const refs = [...discoverSessions(roots.projectsRoot, {})];
  expect(refs.length).toBe(2);
  expect(new Set(refs.map((r) => r.project))).toEqual(new Set(["proj-alpha", "proj-beta"]));
});

test("per-project --recent keeps the newest N per project, not N globally", () => {
  // alpha gets 3 sessions, beta gets 1. --recent 2 → 2 from alpha + 1 from beta = 3.
  for (let i = 1; i <= 3; i++) {
    const p = writeSession("proj-alpha", `aaaaaaaa-0000-0000-0000-00000000000${i}`, jsonl([{ type: "user", content: CORRECTION, timestamp: "2026-06-01T10:00:00.000Z" }]));
    // stagger mtime so "newest 2" is deterministic
    const t = new Date(2026, 5, i).getTime() / 1000;
    utimesSync(p, t, t);
  }
  writeSession("proj-beta", "bbbbbbbb-0000-0000-0000-000000000009", jsonl([{ type: "user", content: CORRECTION, timestamp: "2026-06-02T10:00:00.000Z" }]));

  const refs = [...discoverSessions(roots.projectsRoot, { recent: 2 })];
  const alpha = refs.filter((r) => r.project === "proj-alpha");
  const beta = refs.filter((r) => r.project === "proj-beta");
  expect(alpha.length).toBe(2); // capped per-project
  expect(beta.length).toBe(1);
});

test("discoverSessions on a missing root is fail-soft (empty), not a throw", () => {
  expect([...discoverSessions(join(root, "does-not-exist"), {})].length).toBe(0);
});

// ---------------------------------------------------------------------------
// CLI guards — both branches return BEFORE any harvest, so these are hermetic.
// ---------------------------------------------------------------------------

test("main(--help) returns 0", () => {
  expect(main(["--help"])).toBe(0);
});

test("main rejects an unknown flag with exit code 2", () => {
  expect(main(["--bogus"])).toBe(2);
  expect(main(["--recent", "5", "--nope=1"])).toBe(2);
});

// ---------------------------------------------------------------------------

function allLearningFiles(r: Roots): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  walk(r.learningDir);
  return out;

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(".md")) out.push({ name: e, path: full });
    }
  }
}

// ---------------------------------------------------------------------------
// RT-2 framework-dir resolution (AD-9.3)
// ---------------------------------------------------------------------------

describe("RT-2 framework-dir resolution (AD-9.3)", () => {
  // ambient shell may export a real PAI_DIR / CLAUDE_PROJECTS_ROOT — control them explicitly + restore.
  const KEYS = ["LIFEOS_DIR", "PAI_DIR", "HOME", "CLAUDE_PROJECTS_ROOT"] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("LIFEOS_DIR wins over PAI_DIR; projectsRoot hangs off dirname(frameworkDir)", () => {
    process.env.LIFEOS_DIR = "/life";
    process.env.PAI_DIR = "/pai";
    delete process.env.CLAUDE_PROJECTS_ROOT;
    const r = defaultRoots();
    expect(r.learningDir).toBe(join("/life", "MEMORY", "LEARNING"));
    expect(r.queueDir).toBe(join("/life", "MEMORY", "KNOWLEDGE", "_harvest-queue"));
    // projectsRoot lives beside the framework dir (claude-home), not under it.
    expect(r.projectsRoot).toBe(join(dirname("/life"), "projects"));
  });

  test("PAI_DIR honored when LIFEOS_DIR unset", () => {
    delete process.env.LIFEOS_DIR;
    process.env.PAI_DIR = "/pai";
    delete process.env.CLAUDE_PROJECTS_ROOT;
    expect(defaultRoots().learningDir).toBe(join("/pai", "MEMORY", "LEARNING"));
  });

  test("neither env set → resolver falls back to LIFEOS under a fresh temp home", () => {
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    delete process.env.CLAUDE_PROJECTS_ROOT;
    const home = mkdtempSync(join(tmpdir(), "rt2-"));
    process.env.HOME = home;
    try {
      const r = defaultRoots();
      expect(r.learningDir).toBe(join(home, ".claude", "LIFEOS", "MEMORY", "LEARNING"));
      expect(r.queueDir).toBe(join(home, ".claude", "LIFEOS", "MEMORY", "KNOWLEDGE", "_harvest-queue"));
      expect(r.projectsRoot).toBe(join(home, ".claude", "projects"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("legacy PAI tree present → resolver picks PAI", () => {
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    delete process.env.CLAUDE_PROJECTS_ROOT;
    const home = mkdtempSync(join(tmpdir(), "rt2-"));
    mkdirSync(join(home, ".claude", "PAI"), { recursive: true });
    process.env.HOME = home;
    try {
      const r = defaultRoots();
      expect(r.learningDir).toBe(join(home, ".claude", "PAI", "MEMORY", "LEARNING"));
      expect(r.projectsRoot).toBe(join(home, ".claude", "projects"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Digest / --target (Story 15.1)
// ---------------------------------------------------------------------------

describe("--target repo-scoped digest (15.1)", () => {
  // AC1 — the unknown-flag guard accepts `--target`. Tested against `unknownFlags` directly rather
  // than `main`, because `main` calls `defaultRoots()` unconditionally and would mine the real tree.
  test("AC1: --target is allowlisted; a neighbouring typo is still rejected", () => {
    expect(unknownFlags(["--mine", "--target", "/tmp/x", "--dry-run"])).toEqual([]);
    expect(unknownFlags(["--mine", "--target=/tmp/x"])).toEqual([]);
    expect(unknownFlags(["--mine", "--targett", "/tmp/x"])).toEqual(["--targett"]);
  });

  test("AC3: the digest carries all four provenance fields plus confidence, grouped by project", () => {
    const sid = "dddddddd-0000-0000-0000-000000000015";
    const body = [
      JSON.stringify({ type: "user", message: { content: "hello there, just a short opener line" }, timestamp: "2026-07-03T10:00:00.000Z" }),
      JSON.stringify({ type: "assistant", message: { content: DECISION }, timestamp: "2026-07-03T10:01:00.000Z" }),
    ].join("\n");
    writeSession("proj-alpha", sid, body);
    const target = mkdtempSync(join(tmpdir(), "harvester-target-"));

    try {
      expect(runMine(roots, {}, { target })).toBe(1);

      const digest = readFileSync(join(target, "docs", "session-digest.md"), "utf-8");
      expect(digest).toContain("# Session digest");
      expect(digest).toContain("`proj-alpha`"); // grouped by project
      expect(digest).toContain(`session \`${sid}\``);
      expect(digest).toContain("line 2");
      expect(digest).toContain("2026-07-03T10:01:00.000Z");
      expect(digest).toContain("project `proj-alpha`");
      expect(digest).toMatch(/\d+% confidence/); // noise stays visible (flag-don't-fix)
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("AC3: buildDigest is pure and renders one derivation of the provenance tuple", () => {
    const mem: MinedMemory = {
      sessionId: "eeeeeeee-0000-0000-0000-000000000015",
      project: "proj-beta",
      timestamp: "2026-07-04T09:00:00.000Z",
      memoryType: "decision",
      content: "We decided to keep the digest a pure renderer.",
      context: "ctx",
      confidence: 0.75,
      sourcePattern: "decided to",
      sourceLine: 7,
    };
    const md = buildDigest(new Map([["proj-beta", [mem]]]));
    const prov = provenanceOf(mem);
    expect(prov).toEqual({
      sessionId: mem.sessionId,
      sourceLine: 7,
      timestamp: mem.timestamp,
      projectSlug: "proj-beta",
    });
    expect(md).toContain("75% confidence");
    expect(md).toContain(`session \`${prov.sessionId}\` · line 7`);
    expect(md).not.toContain("_No candidates mined._");
  });

  test("AC4: the guard rejects a target inside queueDir or learningDir, and allows a sibling", () => {
    expect(() => resolveDigestPath(roots, roots.queueDir)).toThrow(/own write dir/);
    expect(() => resolveDigestPath(roots, join(roots.queueDir, "nested"))).toThrow(/own write dir/);
    expect(() => resolveDigestPath(roots, roots.learningDir)).toThrow(/own write dir/);
    // Segment-aware: a sibling that merely shares a prefix is NOT inside.
    expect(resolveDigestPath(roots, `${roots.queueDir}-public`)).toBe(
      join(`${roots.queueDir}-public`, "docs", "session-digest.md"),
    );
    // `--target ../repo` is legitimate — resolve() normalizes it, no `..` string check.
    expect(resolveDigestPath(roots, join(root, "sub", ".."))).toBe(join(root, "docs", "session-digest.md"));
  });

  // Doctrine-tier cross-LLM review (grok-4.5, 2026-07-20) MINOR — the guard checked only the target
  // BASE, so a target whose `docs/` subdir IS a forbidden dir slipped the final write path through.
  test("AC4: the guard also rejects when the FINAL write path lands in a forbidden dir", () => {
    const sneaky = { ...roots, learningDir: join(root, "sneaky", "docs") };
    // The base `<root>/sneaky` is outside learningDir, but the write path <root>/sneaky/docs/... is not.
    expect(() => resolveDigestPath(sneaky, join(root, "sneaky"))).toThrow(/own write dir/);
  });

  test("AC5: --dry-run --target writes zero files (neither digest nor queue)", () => {
    const sid = "ffffffff-0000-0000-0000-000000000015";
    writeSession(
      "proj-alpha",
      sid,
      JSON.stringify({ type: "assistant", message: { content: DECISION }, timestamp: "2026-07-05T10:00:00.000Z" }),
    );
    const target = mkdtempSync(join(tmpdir(), "harvester-target-"));

    try {
      expect(runMine(roots, {}, { dryRun: true, target })).toBe(1);
      expect(existsSync(join(target, "docs"))).toBe(false);
      expect(readdirSync(target).length).toBe(0);
      expect(existsSync(roots.queueDir)).toBe(false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("AC3: a zero-candidate target writes an explicit empty-state digest, not a stray empty file", () => {
    const target = mkdtempSync(join(tmpdir(), "harvester-target-"));
    try {
      // No sessions at all — the early-return path still emits.
      expect(runMine(roots, {}, { target })).toBe(0);
      const digest = readFileSync(join(target, "docs", "session-digest.md"), "utf-8");
      expect(digest).toContain("# Session digest");
      expect(digest).toContain("_No candidates mined._");
      expect(digest.trim().length).toBeGreaterThan(0);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Digest hardening — cross-LLM review findings (15.1, Forge pass)
// ---------------------------------------------------------------------------

describe("--target digest hardening (15.1 review)", () => {
  function mem(over: Partial<MinedMemory> = {}): MinedMemory {
    return {
      sessionId: "11111111-0000-0000-0000-000000000015",
      project: "proj-alpha",
      timestamp: "2026-07-06T10:00:00.000Z",
      memoryType: "decision",
      content: "We decided X.",
      context: "ctx",
      confidence: 0.5,
      sourcePattern: "decided",
      sourceLine: 3,
      ...over,
    };
  }

  // MAJOR #1 — `mem.content` is a RAW transcript slice, so newlines are the norm. Verbatim
  // interpolation would forge sibling headings, detach the provenance sub-bullet from its entry,
  // and could emit the empty-state sentinel from inside a non-empty digest.
  test("multi-line candidate content is collapsed to one line and cannot forge digest structure", () => {
    const hostile = "We decided X.\n\n## Injected heading\n\n- injected bullet\n\n_No candidates mined._";
    const md = buildDigest(new Map([["proj-alpha", [mem({ content: hostile })]]]));

    // Exactly two headings: the document title and the one real project heading.
    expect(md.split("\n").filter((l) => l.startsWith("## "))).toEqual(["## proj/alpha (`proj-alpha`)"]);
    // The sentinel never appears at line start in a non-empty digest.
    expect(md.split("\n").some((l) => l.trim() === "_No candidates mined._")).toBe(false);
    // The provenance sub-bullet is still adjacent to its entry.
    const lines_ = md.split("\n");
    const entry = lines_.findIndex((l) => l.startsWith("- **[decision]**"));
    expect(lines_[entry + 1].trim().startsWith("- session")).toBe(true);
    expect(lines_[entry]).toContain("## Injected heading"); // collapsed inline, not a heading
  });

  // Doctrine-tier cross-LLM review (grok-4.5, 2026-07-20) MAJOR — the fix above sanitized `content`
  // and stopped there. `timestamp`/`sessionId`/`projectSlug` are equally transcript-derived, so the
  // identical structural break was still reachable through any of them. Every field is asserted here
  // so a future edit cannot re-open the hole one field at a time.
  test("EVERY transcript-derived provenance field is collapsed, not just content", () => {
    const hostile = "\n## Injected heading\n\n- forged bullet\n";
    for (const field of ["timestamp", "sessionId", "project"] as const) {
      const md = buildDigest(new Map([["proj-alpha", [mem({ [field]: `real-value${hostile}` })]]]));
      expect(md.split("\n").filter((l) => l.startsWith("## "))).toEqual(["## proj/alpha (`proj-alpha`)"]);
      expect(md.split("\n").some((l) => l.trim() === "- forged bullet")).toBe(false);
      const ls = md.split("\n");
      const entry = ls.findIndex((l) => l.startsWith("- **[decision]**"));
      expect(ls[entry + 1].trim().startsWith("- session")).toBe(true);
    }
  });

  // Same review, MINOR — a hostile PROJECT KEY reaches the `## ` heading directly.
  test("a hostile project key cannot forge extra digest headings", () => {
    const md = buildDigest(new Map([["alpha\n## forged heading", [mem({})]]]));
    expect(md.split("\n").filter((l) => l.startsWith("## ")).length).toBe(1);
  });

  // MAJOR #2 — core.flagValue returns args[i+1] unconditionally; guard the three misparses.
  test("--target with a missing or flag-shaped value is a usage error, never a silent write", () => {
    expect(() => targetFromArgv(["--mine", "--target", "--project", "foo"])).toThrow(/requires a directory/);
    expect(() => targetFromArgv(["--mine", "--target="])).toThrow(/requires a directory/);
    expect(() => targetFromArgv(["--mine", "--target"])).toThrow(/requires a directory/);
    // Absent is fine; well-formed values in both syntaxes are returned verbatim.
    expect(targetFromArgv(["--mine", "--recent", "5"])).toBeUndefined();
    expect(targetFromArgv(["--mine", "--target", "/tmp/x"])).toBe("/tmp/x");
    expect(targetFromArgv(["--mine", "--target=/tmp/x"])).toBe("/tmp/x");
  });

  // These main() calls all return BEFORE defaultRoots(), so they stay hermetic.
  test("main exits 2 on a malformed --target and on --target without --mine", () => {
    expect(main(["--mine", "--target"])).toBe(2);
    expect(main(["--mine", "--target", "--dry-run"])).toBe(2);
    expect(main(["--target", "/tmp/x"])).toBe(2); // no --mine
  });

  // MINOR #5 — AC2's grouped-by-project claim, actually exercised with N>1.
  test("an unfiltered digest groups by project, preserving byProject insertion order", () => {
    const md = buildDigest(
      new Map([
        ["proj-alpha", [mem()]],
        ["proj-beta", [mem({ project: "proj-beta", memoryType: "preference" })]],
      ]),
    );
    const headings = md.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual(["## proj/alpha (`proj-alpha`)", "## proj/beta (`proj-beta`)"]);
    // Each entry sits under its own project heading.
    expect(md.indexOf("proj-alpha`\n")).toBeLessThan(md.indexOf("## proj/beta"));
  });
});

// ---------------------------------------------------------------------------
// Story 15.3 — skill/tool-level classification wired into the mine path
// ---------------------------------------------------------------------------

describe("15.3 — artifact classification seam", () => {
  const CATALOG: Catalog = [
    { name: "Interceptor", kind: "skill" },
    { name: "SessionHarvester", kind: "tool" },
  ];

  /** A >200-char decision that NAMES a catalogued skill outside any frame. */
  const NAMES_SKILL =
    "We decided to always verify a deploy with the Interceptor skill before claiming it works. " +
    "The decision is to make that the rule for every web change from now on, because the previous " +
    "approach let broken pages through and we chose to close that hole permanently this sprint.";

  // AC1 — additivity. `project:<slug>` must survive; 15.2 routes on it today.
  test("AC1: classification tags are ADDITIVE — project:<slug>, memoryType and `mined` all survive", () => {
    const m: MinedMemory = {
      sessionId: "aaaa1111-0000-0000-0000-000000000153",
      project: "proj-alpha",
      timestamp: "2026-07-20T10:00:00.000Z",
      memoryType: "decision",
      content: NAMES_SKILL,
      context: NAMES_SKILL.slice(0, 300),
      confidence: 0.5,
      sourcePattern: "decided to",
      sourceLine: 3,
    };
    const withTags = queueCandidate(m, ["skill:Interceptor"]);
    expect(withTags.tags).toEqual(["decision", "mined", "project:proj-alpha", "skill:Interceptor"]);

    // Omitting the argument leaves the pre-15.3 shape byte-identical.
    expect(queueCandidate(m).tags).toEqual(["decision", "mined", "project:proj-alpha"]);
  });

  test("AC1: the tag lands on the QUEUE FILE, alongside the untouched project tag", () => {
    const sid = "bbbb1111-0000-0000-0000-000000000153";
    writeSession(
      "proj-alpha",
      sid,
      JSON.stringify({ type: "assistant", message: { content: NAMES_SKILL }, timestamp: "2026-07-20T10:00:00.000Z" }),
    );
    expect(runMine(roots, {}, { catalog: CATALOG })).toBe(1);

    const file = readdirSync(roots.queueDir).find((f) => f.endsWith(".json"))!;
    const candidate = JSON.parse(readFileSync(join(roots.queueDir, file), "utf-8"));
    expect(candidate.tags).toContain("skill:Interceptor");
    expect(candidate.tags).toContain("project:proj-alpha"); // AC1 additivity, on the real write path
  });

  // AC2 — THE SEAM. Classification must NOT live in the write path.
  test("AC2: --dry-run still classifies and still reports the rate (and writes nothing)", () => {
    const sid = "cccc1111-0000-0000-0000-000000000153";
    writeSession(
      "proj-alpha",
      sid,
      JSON.stringify({ type: "assistant", message: { content: NAMES_SKILL }, timestamp: "2026-07-20T10:00:00.000Z" }),
    );

    const said: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void said.push(a.join(" "));
    try {
      expect(runMine(roots, {}, { dryRun: true, catalog: CATALOG })).toBe(1);
    } finally {
      console.log = realLog;
    }

    const out = said.join("\n");
    expect(out).toContain("classified 1/1");
    expect(out).toContain("100%");
    // Only the WRITE is dry-run-gated; the rate report is not.
    expect(existsSync(roots.queueDir)).toBe(false);
  });

  test("AC2: with no catalog injected, nothing is classified and no rate is claimed", () => {
    const sid = "dddd1111-0000-0000-0000-000000000153";
    writeSession(
      "proj-alpha",
      sid,
      JSON.stringify({ type: "assistant", message: { content: NAMES_SKILL }, timestamp: "2026-07-20T10:00:00.000Z" }),
    );

    const said: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void said.push(a.join(" "));
    try {
      expect(runMine(roots, {})).toBe(1);
    } finally {
      console.log = realLog;
    }
    expect(said.join("\n")).not.toContain("classified");

    const file = readdirSync(roots.queueDir).find((f) => f.endsWith(".json"))!;
    const candidate = JSON.parse(readFileSync(join(roots.queueDir, file), "utf-8"));
    expect(candidate.tags).toEqual(["decision", "mined", "project:proj-alpha"]);
  });

  // AC2 — the honest bucket, end to end through the miner.
  test("AC2: an unattributable candidate is tagged `unclassified` and counted, never guessed", () => {
    const sid = "eeee1111-0000-0000-0000-000000000153";
    writeSession(
      "subagents",
      sid,
      JSON.stringify({ type: "assistant", message: { content: DECISION }, timestamp: "2026-07-20T10:00:00.000Z" }),
    );

    const said: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void said.push(a.join(" "));
    try {
      expect(runMine(roots, {}, { catalog: CATALOG })).toBe(1);
    } finally {
      console.log = realLog;
    }

    const file = readdirSync(roots.queueDir).find((f) => f.endsWith(".json"))!;
    const candidate = JSON.parse(readFileSync(join(roots.queueDir, file), "utf-8"));
    expect(candidate.tags).toContain("unclassified");
    expect(candidate.tags).toContain("project:subagents");
    expect(candidate.tags.some((t: string) => t.startsWith("skill:") || t.startsWith("tool:"))).toBe(false);
    expect(said.join("\n")).toContain("classified 0/1");
  });

  // AC5 / CLI — the catalog is injected DATA, and the flag guard is exhaustive.
  test("--catalog is allowlisted, guarded against the flagValue look-ahead gap, and documented", () => {
    expect(unknownFlags(["--mine", "--catalog", "/tmp/c.json"])).toEqual([]);
    expect(unknownFlags(["--mine", "--catalog=/tmp/c.json"])).toEqual([]);
    expect(unknownFlags(["--mine", "--catalogue", "/tmp/c.json"])).toEqual(["--catalogue"]);

    expect(catalogPathFromArgv(["--mine", "--recent", "5"])).toBeUndefined();
    expect(catalogPathFromArgv(["--mine", "--catalog", "/tmp/c.json"])).toBe("/tmp/c.json");
    expect(catalogPathFromArgv(["--mine", "--catalog=/tmp/c.json"])).toBe("/tmp/c.json");
    expect(() => catalogPathFromArgv(["--mine", "--catalog", "--dry-run"])).toThrow(/requires a file/);
    expect(() => catalogPathFromArgv(["--mine", "--catalog="])).toThrow(/requires a file/);
    expect(() => catalogPathFromArgv(["--mine", "--catalog"])).toThrow(/requires a file/);
  });

  test("loadCatalog reads the injected JSON, and fails loud on a missing or malformed file", () => {
    const good = join(root, "catalog.json");
    writeFileSync(good, JSON.stringify({ skills: ["Interceptor"], tools: ["SessionHarvester"] }));
    expect(loadCatalog(good)).toEqual([
      { name: "Interceptor", kind: "skill" },
      { name: "SessionHarvester", kind: "tool" },
    ]);

    expect(() => loadCatalog(join(root, "nope.json"))).toThrow(/not found/i);
    const bad = join(root, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(() => loadCatalog(bad)).toThrow(/catalog/i);
  });

  // These main() calls return BEFORE defaultRoots(), so they stay hermetic.
  test("main exits 2 on a malformed --catalog and on --catalog without --mine", () => {
    expect(main(["--mine", "--catalog"])).toBe(2);
    expect(main(["--catalog", "/tmp/c.json"])).toBe(2); // no --mine
  });
});
