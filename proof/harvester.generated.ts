#!/usr/bin/env bun
/**
 * harvester — unified session-learning harvester  (Epic 11.1)
 * ============================================================================
 * Collapses the ~90%-identical SessionHarvester ≡ ProjectsHarvester pair into
 * ONE std-consumer. The project dimension is the superset: SessionHarvester is
 * just "ProjectsHarvester that ignores the project slug + uses global --recent
 * + dedups learnings across sessions". So the merged tool is project-aware by
 * default and reproduces each original via flags (parity is selectable).
 *
 * std substrate (no re-rolled plumbing — AC 11.1):
 *   fsx.walkFiles / ensureDir / writeIfAbsent / saveJson
 *   core.parseNdjson, core.args, similarity.charOverlap
 *   NOTE: import paths below are written against the std barrels the architect
 *   confirmed (std/fsx, std/core). Confirm the exact specifier on `bun link`.
 *
 * Edge — PAI-specific, STAYS here (D4 / AC 11.1):
 *   the 7 pattern catalogs + MINING_PATTERN_MAP, learning-utils
 *   (getLearningCategory / isLearningCapture), the MEMORY write-layout
 *   (LEARNING/<cat>/<YYYY-MM>, KNOWLEDGE/_harvest-queue), frontmatter +
 *   filename conventions, projectLabel, the bespoke confidence formula.
 *
 * Consumer contract (std architect Q3): sessions are pulled as a LAZY SYNC
 * generator — one parsed session held at a time, folded incrementally.
 *
 * Registry shape (std architect Q2): per-session work is the `map`; the
 * cross-session learnings-dedup is the `reduce`. SessionHarvester HAS that
 * reduce, ProjectsHarvester does NOT — that is the real behavioral delta, so it
 * lives as a switchable reduce, not buried control flow.
 *
 * ⚠ This is the 11.1 scaffold, not a compiled artifact: it cannot be type-
 *   checked until std is `bun link`ed. Holes marked  // ⟨EDGE⟩  and  // ⟨11.2⟩.
 */

import { walkFiles, ensureDir, writeIfAbsent, saveJson } from "std/fsx";
import { parseNdjson, args as parseArgs } from "std/core";
import { charOverlap } from "std/core/similarity";

// ⟨EDGE⟩ PAI domain helper — stays in the tool (D4). Path is tool-relative.
import { getLearningCategory, isLearningCapture } from "../hooks/lib/learning-utils";

import { homedir } from "node:os";
import { join, basename } from "node:path";

// ============================================================================
// ⟨EDGE⟩ Configuration + PAI write-layout
// ============================================================================

const HOME = homedir();
const PROJECTS_ROOT = process.env.CLAUDE_PROJECTS_ROOT ?? join(HOME, ".claude", "projects");
const LEARNING_DIR = join(HOME, ".claude", "PAI", "MEMORY", "LEARNING");
const HARVEST_QUEUE_DIR = join(HOME, ".claude", "PAI", "MEMORY", "KNOWLEDGE", "_harvest-queue");
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================================================
// ⟨EDGE⟩ Pattern catalogs (identical in both originals — verbatim)
// ============================================================================

const CORRECTION_PATTERNS = [
  /actually,?\s+/i, /wait,?\s+/i, /no,?\s+i meant/i, /let me clarify/i,
  /that's not (quite )?right/i, /you misunderstood/i, /i was wrong/i, /my mistake/i,
];
const ERROR_PATTERNS = [
  /error:/i, /failed:/i, /exception:/i, /stderr:/i,
  /command failed/i, /permission denied/i, /not found/i,
];
const INSIGHT_PATTERNS = [
  /learned that/i, /realized that/i, /discovered that/i, /key insight/i,
  /important:/i, /note to self/i, /for next time/i, /lesson:/i,
];
const DECISION_PATTERNS = [
  /(?:we|i) (?:decided|chose|went with|picked|selected)\b/i,
  /(?:let'?s|going to) (?:use|go with|switch to|adopt)\b/i,
  /(?:the )?(?:decision|choice|call) (?:is|was) to\b/i,
  /(?:trade-?off|chose .+ over|prefer .+ to)\b/i,
  /(?:we'?re|i'?m) (?:going with|sticking with)\b/i,
];
const PREFERENCE_PATTERNS = [
  /(?:always|never|don'?t) (?:use|do|add|create|write|make)\b/i,
  /(?:prefer|like|want|hate|avoid)\s+(?:to |using |when )/i,
  /(?:the rule|the convention|our standard) is\b/i,
  /(?:bun|bunx)\s+(?:always|never|not)\b/i,
  /(?:must|should|shall) (?:always|never)\b/i,
];
const MILESTONE_PATTERNS = [
  /(?:it |that |this )(?:works?|worked|shipped|deployed|launched)\b/i,
  /(?:finally|successfully) (?:got|made|built|shipped|deployed|fixed)\b/i,
  /(?:pushed|merged|released|published|completed|finished)\b/i,
  /(?:milestone|breakthrough|shipped it|it'?s live|went live)\b/i,
];
const PROBLEM_PATTERNS = [
  /(?:the )?(?:issue|problem|bug|failure|crash) (?:is|was|seems)\b/i,
  /(?:broke|broken|breaking|fails?|failed|crashing)\b/i,
  /(?:can'?t|couldn'?t|unable to|won'?t|doesn'?t work)\b/i,
  /(?:root cause|caused by|the reason|turns out)\b/i,
  /(?:regression|degraded|degradation|worse than)\b/i,
];

type MemoryType = "decision" | "preference" | "milestone" | "problem";
const MINING_PATTERN_MAP: Record<MemoryType, RegExp[]> = {
  decision: DECISION_PATTERNS,
  preference: PREFERENCE_PATTERNS,
  milestone: MILESTONE_PATTERNS,
  problem: PROBLEM_PATTERNS,
};

// ============================================================================
// Types — `project` is ALWAYS carried (Session simply ignores it on output).
// ============================================================================

type ProjectsEntry = {
  type?: "user" | "assistant" | "summary";
  message?: { role?: string; content?: string | Array<{ type: string; text?: string }> };
  timestamp?: string;
};

type SessionRef = { path: string; project: string; mtime: number };

type HarvestedLearning = {
  sessionId: string; project: string; timestamp: string;
  category: "SYSTEM" | "ALGORITHM"; type: "correction" | "error" | "insight";
  context: string; content: string; source: string;
};

type MinedMemory = {
  sessionId: string; project: string; timestamp: string; memoryType: MemoryType;
  content: string; context: string; confidence: number; sourcePattern: string; sourceLine: number;
};

type Selection = { recent?: number; all?: boolean; sessionId?: string; project?: string };
type Modes = {
  /** false = per-project top-N (Projects); true = global top-N (Session). */
  globalRecent: boolean;
  /** true = cross-session learnings dedup (Session); false = none (Projects). */
  dedupLearnings: boolean;
  /** false = tag output by project (Projects); true = flat, no project (Session). */
  flatOutput: boolean;
};

// ============================================================================
// ⟨EDGE⟩ project slug → human label  (Projects-only helper, kept verbatim)
// ============================================================================

function projectLabel(slug: string): string {
  let p = slug.replace(/--/g, "/.").replace(/-/g, "/");
  if (HOME && p.startsWith(HOME)) p = "~" + p.slice(HOME.length);
  return p;
}

// ============================================================================
// DISCOVERY — lazy sync generator over the projects root (std.walkFiles)
// Selection (recent / all / session / project) + the global-vs-per-project
// --recent fork are applied here.
// ============================================================================

function* discoverSessions(root: string, sel: Selection, modes: Modes): Iterable<SessionRef> {
  // walkFiles → absolute .jsonl paths; project slug = immediate parent dir name.
  const refs: SessionRef[] = walkFiles(root, (p) => p.endsWith(".jsonl")).map((p) => ({
    path: p,
    project: basename(join(p, "..")),
    mtime: Bun.file(p).lastModified, // ⟨11.2⟩ std has no stat helper; fsx gap candidate.
  }));

  let pool = sel.project ? refs.filter((r) => r.project.includes(sel.project!)) : refs;

  if (sel.sessionId) {
    const m = pool.find((r) => basename(r.path).includes(sel.sessionId!));
    if (m) yield m;
    return;
  }

  if (sel.all) {
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    yield* pool.filter((r) => r.mtime > cutoff).sort((a, b) => b.mtime - a.mtime);
    return;
  }

  const limit = sel.recent ?? 10;
  if (modes.globalRecent) {
    // SessionHarvester semantics: newest N overall.
    yield* pool.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  } else {
    // ProjectsHarvester semantics: newest N PER project, then global newest-first.
    const byProj = new Map<string, SessionRef[]>();
    for (const r of pool) (byProj.get(r.project) ?? byProj.set(r.project, []).get(r.project)!).push(r);
    const out: SessionRef[] = [];
    for (const group of byProj.values())
      out.push(...group.sort((a, b) => b.mtime - a.mtime).slice(0, limit));
    yield* out.sort((a, b) => b.mtime - a.mtime);
  }
}

// ============================================================================
// MAP — per-session extraction. Parse ONCE, run both extractors.
// (Originals read the file twice; merging the read is safe — same logic.)
// ============================================================================

function extractText(content: ProjectsEntry["message"] extends { content: infer C } ? C : never): string {
  const c = (content as any);
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((x) => x.type === "text" && x.text).map((x) => x.text).join("\n");
  return "";
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const p of patterns) if (p.test(text)) return p.source;
  return null;
}

type SessionPartial = { learnings: HarvestedLearning[]; mined: MinedMemory[] };

function harvestSession(ref: SessionRef, raw: string): SessionPartial {
  const sessionId = basename(ref.path, ".jsonl");
  // ⟨11.2⟩ parseNdjson drops blank/unparseable lines → loses the RAW line index
  // that mineMemories stamps as `sourceLine`. Until std offers a line-preserving
  // variant, we keep a manual 1-based counter for parity. Substrate-gap finding.
  const rawLines = raw.split("\n");
  const learnings: HarvestedLearning[] = [];
  const minedRaw: MinedMemory[] = [];
  let previousContext = "";

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line.trim()) continue;
    let entry: ProjectsEntry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry.message?.content) continue;

    const text = extractText(entry.message.content);
    if (!text || text.length < 20) continue;
    const timestamp = entry.timestamp || new Date().toISOString();

    // --- learnings (corrections on user; errors+insights on assistant) ---
    if (entry.type === "user") {
      const src = firstMatch(text, CORRECTION_PATTERNS);
      if (src) learnings.push({
        sessionId, project: ref.project, timestamp,
        category: getLearningCategory(text), type: "correction",
        context: previousContext.slice(0, 200), content: text.slice(0, 500), source: src,
      });
      previousContext = text;
    } else if (entry.type === "assistant") {
      const err = firstMatch(text, ERROR_PATTERNS);
      if (err && isLearningCapture(text)) learnings.push({
        sessionId, project: ref.project, timestamp,
        category: getLearningCategory(text), type: "error",
        context: previousContext.slice(0, 200), content: text.slice(0, 500), source: err,
      });
      const ins = firstMatch(text, INSIGHT_PATTERNS);
      if (ins) learnings.push({
        sessionId, project: ref.project, timestamp,
        category: getLearningCategory(text), type: "insight",
        context: previousContext.slice(0, 200), content: text.slice(0, 500), source: ins,
      });
      previousContext = text;
    }

    // --- mining (decision/preference/milestone/problem) ---
    if (entry.type === "user" || entry.type === "assistant") {
      for (const [memType, patterns] of Object.entries(MINING_PATTERN_MAP) as [MemoryType, RegExp[]][]) {
        let count = 0, first = "";
        for (const p of patterns) if (p.test(text)) { count++; if (!first) first = p.source; }
        if (count === 0) continue;
        let confidence = Math.min(count / 5.0, 1.0);
        if (text.length > 200) confidence = Math.min(confidence + 0.1, 1.0);
        if (confidence < 0.3) continue;
        minedRaw.push({
          sessionId, project: ref.project, timestamp, memoryType: memType,
          content: text.slice(0, 500), context: text.slice(0, 300),
          confidence, sourcePattern: first, sourceLine: i + 1,
        });
      }
    }
  }

  // per-session mine dedup (map-local): >80% char overlap → keep higher confidence
  const mined: MinedMemory[] = [];
  for (const m of minedRaw) {
    const hit = mined.findIndex((e) => charOverlap(e.content, m.content) > 0.8);
    if (hit >= 0) { if (m.confidence > mined[hit].confidence) mined[hit] = m; }
    else mined.push(m);
  }
  mined.sort((a, b) => b.confidence - a.confidence);
  return { learnings, mined };
}

// ============================================================================
// REDUCE — the real Session≡Projects fork. Cross-session learnings dedup is
// SessionHarvester-only; gated by modes.dedupLearnings.
// ============================================================================

function reduceLearnings(all: HarvestedLearning[], modes: Modes): HarvestedLearning[] {
  if (!modes.dedupLearnings) return all;
  const seen = new Map<string, HarvestedLearning>();
  for (const l of all) {
    const key = `${l.category}|${l.type}|${l.content.replace(/\s+/g, " ").trim()}`;
    const prev = seen.get(key);
    if (!prev || l.timestamp < prev.timestamp) seen.set(key, l); // keep earliest
  }
  return [...seen.values()];
}

// ============================================================================
// ⟨EDGE⟩ WRITE-LAYOUT — MEMORY filenames + frontmatter (project-tagged unless flat)
// ============================================================================

function monthDir(category: "SYSTEM" | "ALGORITHM"): string {
  const now = new Date();
  const dir = join(LEARNING_DIR, category, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  ensureDir(dir);
  return dir;
}

function learningFilename(l: HarvestedLearning, modes: Modes): string {
  const d = new Date(l.timestamp);
  const dateStr = d.toISOString().split("T")[0];
  const timeStr = d.toISOString().split("T")[1].slice(0, 5).replace(":", "");
  const sid = l.sessionId.slice(0, 8);
  return modes.flatOutput
    ? `${dateStr}_${timeStr}_${l.type}_${sid}.md`
    : `${dateStr}_${timeStr}_${l.type}_${l.project}_${sid}.md`;
}

function learningBody(l: HarvestedLearning, modes: Modes): string {
  const head = modes.flatOutput
    ? ""
    : `**Project:** ${projectLabel(l.project)}\n**Project Slug:** ${l.project}\n`;
  const tool = modes.flatOutput ? "SessionHarvester" : "ProjectsHarvester";
  return `# ${l.type.charAt(0).toUpperCase() + l.type.slice(1)} Learning\n\n${head}**Session:** ${l.sessionId}\n**Timestamp:** ${l.timestamp}\n**Category:** ${l.category}\n**Source Pattern:** ${l.source}\n\n---\n\n## Context\n\n${l.context}\n\n## Learning\n\n${l.content}\n\n---\n\n*Harvested by ${tool} from projects/ transcript*\n`;
}

function writeLearning(l: HarvestedLearning, modes: Modes): { path: string; wrote: boolean } {
  const path = join(monthDir(l.category), learningFilename(l, modes));
  const wrote = writeIfAbsent(path, learningBody(l, modes)); // O_CREAT|O_EXCL skip-if-exists
  return { path, wrote };
}

function writeQueue(m: MinedMemory, modes: Modes): string {
  ensureDir(HARVEST_QUEUE_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const sid = m.sessionId.slice(0, 8);
  const name = modes.flatOutput
    ? `mine_${ts}_${m.memoryType}_${sid}_L${m.sourceLine}.json`
    : `mine_${ts}_${m.memoryType}_${m.project}_${sid}_L${m.sourceLine}.json`;
  const path = join(HARVEST_QUEUE_DIR, name);
  const candidate: Record<string, unknown> = {
    title: `${m.memoryType}: ${m.content.substring(0, 60)}...`,
    content: `## ${m.memoryType.charAt(0).toUpperCase() + m.memoryType.slice(1)}\n\n${m.content}\n\n## Context\n\n${m.context}`,
    domain: "Ideas", type: "idea",
    tags: modes.flatOutput ? [m.memoryType, "mined"] : [m.memoryType, "mined", `project:${m.project}`],
    confidence: m.confidence, sourcePattern: m.sourcePattern,
    ...(modes.flatOutput ? {} : { project: m.project, projectLabel: projectLabel(m.project) }),
    sourcePath: m.sessionId, minedAt: new Date().toISOString(),
  };
  // ⟨11.2⟩ saveJson appends a trailing "\n"; the originals did not. 1-byte parity
  // diff — accept as the new canonical, or add a no-newline option to fsx.
  saveJson(path, candidate);
  return path;
}

// ============================================================================
// CLI — core/args dispatch; flags select which original's behavior to mirror.
// Default = Projects superset.  SessionHarvester parity = --global-recent
// --dedup-learnings --flat.
// ============================================================================

function main() {
  const { values } = parseArgs({
    recent: { type: "string" }, all: { type: "boolean" }, session: { type: "string" },
    project: { type: "string" }, "dry-run": { type: "boolean" }, mine: { type: "boolean" },
    "global-recent": { type: "boolean" }, "dedup-learnings": { type: "boolean" },
    flat: { type: "boolean" }, help: { type: "boolean" },
  });

  const modes: Modes = {
    globalRecent: !!values["global-recent"],
    dedupLearnings: !!values["dedup-learnings"],
    flatOutput: !!values.flat,
  };
  const sel: Selection = {
    recent: values.recent ? parseInt(values.recent as string, 10) : undefined,
    all: !!values.all, sessionId: values.session as string | undefined,
    project: values.project as string | undefined,
  };
  const dryRun = !!values["dry-run"];

  const sessions = [...discoverSessions(PROJECTS_ROOT, sel, modes)];
  if (sessions.length === 0) { console.log("No sessions found to harvest"); return; }

  if (values.mine) {
    let total = 0;
    for (const ref of sessions) {
      const { mined } = harvestSession(ref, Bun.file(ref.path).text() as unknown as string); // sync read in real impl
      for (const m of mined) { if (!dryRun) writeQueue(m, modes); total++; }
    }
    console.log(`${total} candidate(s) ${dryRun ? "found (dry run)" : "queued"}`);
    return;
  }

  // map → reduce → write
  const all: HarvestedLearning[] = [];
  for (const ref of sessions) {
    const text = Bun.file(ref.path).text() as unknown as string; // sync read in real impl
    all.push(...harvestSession(ref, text).learnings);
  }
  const learnings = reduceLearnings(all, modes);
  if (learnings.length === 0) { console.log("✅ No new learnings found"); return; }

  if (dryRun) {
    for (const l of learnings) console.log(`   ${l.category}/${learningFilename(l, modes)}`);
  } else {
    for (const l of learnings) writeLearning(l, modes);
    console.log(`✅ Harvested ${learnings.length} learning(s) to MEMORY/LEARNING/`);
  }
}

main();
