// Self-test for the converged harvester (Story 11.1 / AC3 + AC7).
//
// Hermetic: a JSONL fixture written into a mkdtemp projects root + temp MEMORY
// dirs (no real ~/.claude reads), mirroring the Epic-10 fixture discipline.
// Asserts harvest parity vs the ProjectsHarvester project-tagged baseline modulo
// the three intentional deltas (Δ1 cross-session dedup / Δ2 queue trailing
// newline / Δ3 unified attribution), plus mine `sourceLine` correctness, the
// per-session >0.8-overlap dedup, and the dormant provenance seam.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverSessions,
  harvestSession,
  reduceLearnings,
  runHarvest,
  runMine,
  type HarvestedLearning,
  type Roots,
  type SessionRef,
} from "./harvester";

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
    require("node:fs").utimesSync(p, t, t);
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
      if (require("node:fs").statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(".md")) out.push({ name: e, path: full });
    }
  }
}
