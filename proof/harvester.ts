#!/usr/bin/env bun
/**
 * harvester — the converged session/projects memory-harvester  (Epic 11.1)
 * ============================================================================
 * Collapses the ~90%-identical `SessionHarvester.ts` ≡ `ProjectsHarvester.ts`
 * pair into ONE std-consumer. SessionHarvester was just "ProjectsHarvester that
 * ignores the project slug, uses a global --recent, and dedups learnings across
 * sessions". So the merged tool is the ProjectsHarvester SUPERSET — project-aware
 * by default — with the SessionHarvester cross-session dedup folded in for all.
 *
 * CONVERGE, not reproduce-both (Pedro/Winston 2026-06-29): the reference
 * scaffold's selectable-parity flags (--global-recent / --dedup-learnings /
 * --flat) are DROPPED. The converged tool is:
 *   • project-aware by default (project-tagged filenames/frontmatter/queue tags)
 *   • per-project `--recent N` (default 10) — small projects aren't starved
 *   • cross-session learnings dedup applied UNCONDITIONALLY (Projects lacked it)
 *
 * map / reduce registry shape (std-architect Q2, AD-9.1 r4):
 *   map    = `harvestSession`  — per-session extraction (learnings + mined)
 *   reduce = `reduceLearnings` — the cross-session dedup, the one real fork.
 *   The reduce body stays in this EDGE; std owns no fold/groupBy (D2).
 * Sessions are pulled via the lazy sync `discoverSessions` Iterable<SessionRef>
 * (std-architect Q3): cheap path+mtime refs up front, the file read folded one
 * session at a time in `runHarvest`/`runMine`.
 *
 * std substrate (no re-rolled plumbing — AC1):
 *   std/core   parseNdjson (harvest path) · charOverlap (per-session dedup) ·
 *              flagValue / hasFlag (CLI, per-flag — NOT node:util parseArgs)
 *   std/fsx    walkFiles (discovery) · ensureDir · saveJson (queue)
 *   std/report writeIfAbsent (skip-if-exists learning files)
 *
 * Edge — PAI-specific, STAYS here (D4 / AC6): the 7 pattern catalogs +
 * MINING_PATTERN_MAP, learning-utils (getLearningCategory / isLearningCapture),
 * the MEMORY write-layout (LEARNING/<cat>/<YYYY-MM>, KNOWLEDGE/_harvest-queue),
 * frontmatter + filename conventions, projectLabel, the confidence formula,
 * confidenceIcon. The injected ~/.claude/MEMORY roots are CONSUMER IDENTITY —
 * they live here, never in std (check:no-consumer-ids stays green).
 *
 * Intentional deltas vs ProjectsHarvester (parity is asserted modulo these — AC3):
 *   Δ1  cross-session learnings dedup now applied (Projects had none → fewer dupes)
 *   Δ2  queue JSON ends with a trailing newline (fsx.saveJson writes `…,2)+"\n"`)
 *   Δ3  unified tool-attribution string (*Harvested by harvester …*)
 *
 * Provenance seam (§Redesign #2 — the ONE feedback-loop addition, AD-9.1):
 *   every queued candidate carries `provenance: {sessionId, sourceLine, timestamp,
 *   projectSlug}`. DORMANT data — no consumer reads it in 11.1; it is the single
 *   seam Epic 15's harvest→repo loop consumes. No emit behavior is added here.
 *
 * Substrate-gap notes (handled LOCALLY — input to Story 11.2; 11.1 changes no std):
 *   #1 parseNdjson drops the raw line index → the mine path keeps a manual 1-based
 *      counter over `raw.split("\n")` to preserve `sourceLine`.
 *   #2 fsx.saveJson appends a trailing "\n" → Δ2 (accepted as the new canonical).
 *   #3 text.truncate is char-boundary-aware, ≠ raw `.slice` → content/context use
 *      raw `.slice(0,500)`/`.slice(0,300)`, NOT truncate.
 *   #4 core/args is per-flag, not parseArgs({schema}) → CLI parsed per-flag.
 *   #5 fsx has no stat/mtime helper → discovery reads `statSync().mtimeMs` at the edge.
 *
 * DEV NOTE: this lives in std-public `proof/` as the Phase-4 substrate proof — a
 * std CONSUMER, not library surface (so it is NOT under src/**). The production
 * home is ~/.claude/PAI/TOOLS/harvester.ts; the live cutover (deploy + retire the
 * two originals + doc refs) is the Pedro-run staged step (Task 9).
 */

import { charOverlap, collapse, flagValue, hasFlag, parseNdjson } from "std/core";
import { atomicWrite, ensureDir, resolveFrameworkDir, saveJson, walkFiles } from "std/fsx";
import { lines, writeIfAbsent } from "std/report";

// PAI domain helper — the one real shared edge dependency, stays in the tool (D4).
// VENDORED into proof/ for the hermetic self-test; production imports the real
// `../../hooks/lib/learning-utils`. [Story 11.1 open-question #2]
import { getLearningCategory, isLearningCapture } from "./learning-utils";

import { statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

// ============================================================================
// EDGE — configuration + PAI write-layout. Roots are injectable (the self-test
// drives a temp tree); the defaults are the only consumer-identity in the tool.
// ============================================================================

export interface Roots {
  projectsRoot: string; // one subfolder per project, each a cwd slug
  learningDir: string; // MEMORY/LEARNING/{ALGORITHM|SYSTEM}/YYYY-MM/
  queueDir: string; // MEMORY/KNOWLEDGE/_harvest-queue/
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function defaultRoots(): Roots {
  const frameworkDir =
    process.env.LIFEOS_DIR || process.env.PAI_DIR || resolveFrameworkDir(process.env.HOME ?? homedir());
  const claudeDir = dirname(frameworkDir);
  return {
    projectsRoot: process.env.CLAUDE_PROJECTS_ROOT ?? join(claudeDir, "projects"),
    learningDir: join(frameworkDir, "MEMORY", "LEARNING"),
    queueDir: join(frameworkDir, "MEMORY", "KNOWLEDGE", "_harvest-queue"),
  };
}

// ============================================================================
// EDGE — pattern catalogs (byte-identical in both originals — verbatim)
// ============================================================================

const CORRECTION_PATTERNS = [
  /actually,?\s+/i,
  /wait,?\s+/i,
  /no,?\s+i meant/i,
  /let me clarify/i,
  /that's not (quite )?right/i,
  /you misunderstood/i,
  /i was wrong/i,
  /my mistake/i,
];

const ERROR_PATTERNS = [
  /error:/i,
  /failed:/i,
  /exception:/i,
  /stderr:/i,
  /command failed/i,
  /permission denied/i,
  /not found/i,
];

const INSIGHT_PATTERNS = [
  /learned that/i,
  /realized that/i,
  /discovered that/i,
  /key insight/i,
  /important:/i,
  /note to self/i,
  /for next time/i,
  /lesson:/i,
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
// Types — `project` is ALWAYS carried (the ProjectsHarvester superset).
// ============================================================================

type MessageContent = string | Array<{ type: string; text?: string; name?: string; input?: unknown }>;

interface ProjectsEntry {
  sessionId?: string;
  type?: "user" | "assistant" | "summary";
  message?: {
    role?: string;
    content?: MessageContent;
  };
  timestamp?: string;
}

export interface SessionRef {
  path: string;
  project: string; // raw project slug (the immediate parent dir name)
  mtime: number;
}

export interface HarvestedLearning {
  sessionId: string;
  project: string;
  timestamp: string;
  category: "SYSTEM" | "ALGORITHM";
  type: "correction" | "error" | "insight";
  context: string;
  content: string;
  source: string;
}

export interface MinedMemory {
  sessionId: string;
  project: string;
  timestamp: string;
  memoryType: MemoryType;
  content: string;
  context: string;
  confidence: number;
  sourcePattern: string;
  sourceLine: number;
}

export interface Selection {
  recent?: number;
  all?: boolean;
  sessionId?: string;
  project?: string;
}

/** The Epic-15 provenance tuple stamped on every queued candidate. Exported since 15.1 — the
 *  digest renders it too, and 15.2/15.4 consume the same contract (do NOT re-declare it locally). */
export interface Provenance {
  sessionId: string;
  sourceLine: number;
  timestamp: string;
  projectSlug: string;
}

// ============================================================================
// EDGE — project slug → human label (Projects-only helper, kept verbatim)
// ============================================================================

export function projectLabel(slug: string): string {
  const home = process.env.HOME || "";
  // Slugs are the cwd with "/" and "." replaced by "-"; a best-effort inverse
  // is far more readable than the raw slug for console + frontmatter output.
  let p = slug.replace(/--/g, "/.").replace(/-/g, "/");
  if (home && p.startsWith(home)) p = "~" + p.slice(home.length);
  return p;
}

// ============================================================================
// DISCOVERY — lazy sync Iterable over the projects root (std.walkFiles).
// Per-project `--recent` (default 10) is the only behavior — the globalRecent
// fork is dropped. mtime read at the edge (gap #5: fsx has no stat helper).
// ============================================================================

export function* discoverSessions(root: string, sel: Selection): Iterable<SessionRef> {
  // walkFiles → absolute .jsonl paths (fail-soft on a missing root → []).
  const all: SessionRef[] = walkFiles(root, (p) => p.endsWith(".jsonl")).map((p) => {
    // gap #5 — fsx has no stat/mtime helper; read mtime at the edge. Guarded so a
    // file that vanishes between walk and stat (TOCTOU) or an unreadable one is
    // fail-soft (mtime 0 → sorts last), matching walkFiles' own fail-soft contract.
    let mtime = 0;
    try {
      mtime = statSync(p).mtimeMs;
    } catch {
      // unstatable — keep it, just unranked
    }
    return { path: p, project: basename(dirname(p)), mtime };
  });

  const pool = sel.project ? all.filter((r) => r.project.includes(sel.project!)) : all;

  // Group by project so per-project selection mirrors getSessionFiles exactly.
  const byProject = new Map<string, SessionRef[]>();
  for (const r of pool) {
    const group = byProject.get(r.project);
    if (group) group.push(r);
    else byProject.set(r.project, [r]);
  }

  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const limit = sel.recent ?? 10;
  const selected: SessionRef[] = [];

  for (const group of byProject.values()) {
    const sorted = group.sort((a, b) => b.mtime - a.mtime); // newest-first within project

    if (sel.sessionId) {
      const match = sorted.find((r) => basename(r.path).includes(sel.sessionId!));
      if (match) selected.push(match); // first match per project (IDs are unique UUIDs)
      continue;
    }
    if (sel.all) {
      for (const r of sorted) if (r.mtime > cutoff) selected.push(r);
      continue;
    }
    for (const r of sorted.slice(0, limit)) selected.push(r); // per-project top-N
  }

  // Newest-first overall for stable, predictable output ordering.
  yield* selected.sort((a, b) => b.mtime - a.mtime);
}

// ============================================================================
// Content extraction (verbatim from the originals)
// ============================================================================

function extractTextContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

function matchesPatterns(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}

// ============================================================================
// MAP — per-session extraction. Read the file ONCE, run both extractors:
//   • learnings via parseNdjson (AC1 — no line numbers needed here)
//   • mined via a manual 1-based counter (gap #1 — parseNdjson drops the index
//     the mine path stamps as `sourceLine`)
// ============================================================================

export function harvestSession(
  ref: SessionRef,
  raw: string,
): { learnings: HarvestedLearning[]; mined: MinedMemory[] } {
  const sessionId = basename(ref.path, ".jsonl");
  const learnings = extractLearnings(ref, raw, sessionId);
  const mined = mineMemories(ref, raw, sessionId);
  return { learnings, mined };
}

function extractLearnings(ref: SessionRef, raw: string, sessionId: string): HarvestedLearning[] {
  const learnings: HarvestedLearning[] = [];
  let previousContext = "";

  // AC1 — harvest path on the substrate. parseNdjson skips blank/malformed lines.
  for (const entry of parseNdjson<ProjectsEntry>(raw)) {
    if (!entry.message?.content) continue;
    const text = extractTextContent(entry.message.content);
    if (!text || text.length < 20) continue;
    const timestamp = entry.timestamp || new Date().toISOString();

    if (entry.type === "user") {
      const src = matchesPatterns(text, CORRECTION_PATTERNS);
      if (src) {
        learnings.push({
          sessionId,
          project: ref.project,
          timestamp,
          category: getLearningCategory(text),
          type: "correction",
          context: previousContext.slice(0, 200), // gap #3 — raw slice, not truncate
          content: text.slice(0, 500),
          source: src,
        });
      }
      previousContext = text;
    } else if (entry.type === "assistant") {
      const err = matchesPatterns(text, ERROR_PATTERNS);
      if (err && isLearningCapture(text)) {
        learnings.push({
          sessionId,
          project: ref.project,
          timestamp,
          category: getLearningCategory(text),
          type: "error",
          context: previousContext.slice(0, 200),
          content: text.slice(0, 500),
          source: err,
        });
      }
      const ins = matchesPatterns(text, INSIGHT_PATTERNS);
      if (ins) {
        learnings.push({
          sessionId,
          project: ref.project,
          timestamp,
          category: getLearningCategory(text),
          type: "insight",
          context: previousContext.slice(0, 200),
          content: text.slice(0, 500),
          source: ins,
        });
      }
      previousContext = text;
    }
  }

  return learnings;
}

function mineMemories(ref: SessionRef, raw: string, sessionId: string): MinedMemory[] {
  const memories: MinedMemory[] = [];

  // gap #1 — manual 1-based counter over the RAW lines preserves `sourceLine`
  // (parseNdjson would drop blank/unparseable lines and the index with them).
  const rawLines = raw.split("\n");
  for (let lineIdx = 0; lineIdx < rawLines.length; lineIdx++) {
    const line = rawLines[lineIdx];
    if (!line.trim()) continue;
    let entry: ProjectsEntry;
    try {
      entry = JSON.parse(line) as ProjectsEntry;
    } catch {
      continue; // skip malformed lines
    }

    if (!entry.message?.content) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const text = extractTextContent(entry.message.content);
    if (!text || text.length < 20) continue;
    const timestamp = entry.timestamp || new Date().toISOString();

    for (const [memType, patterns] of Object.entries(MINING_PATTERN_MAP) as [
      MemoryType,
      RegExp[],
    ][]) {
      let matchCount = 0;
      let firstMatchedPattern = "";
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          matchCount++;
          if (!firstMatchedPattern) firstMatchedPattern = pattern.source;
        }
      }
      if (matchCount === 0) continue;

      let confidence = Math.min(matchCount / 5.0, 1.0);
      if (text.length > 200) confidence = Math.min(confidence + 0.1, 1.0);
      if (confidence < 0.3) continue;

      memories.push({
        sessionId,
        project: ref.project,
        timestamp,
        memoryType: memType,
        content: text.slice(0, 500), // gap #3 — raw slice
        context: text.slice(0, 300),
        confidence,
        sourcePattern: firstMatchedPattern,
        sourceLine: lineIdx + 1,
      });
    }
  }

  // per-session dedup: >80% char overlap → keep the higher-confidence candidate.
  // charOverlap (std/core) is the verbatim positional-overlap port of the
  // originals' local contentOverlap (AC1 — no re-rolled char-overlap).
  const deduped: MinedMemory[] = [];
  for (const mem of memories) {
    const hit = deduped.findIndex((e) => charOverlap(e.content, mem.content) > 0.8);
    if (hit >= 0) {
      if (mem.confidence > deduped[hit].confidence) deduped[hit] = mem;
    } else {
      deduped.push(mem);
    }
  }

  return deduped.sort((a, b) => b.confidence - a.confidence);
}

// ============================================================================
// REDUCE — the one real Session≡Projects fork. Cross-session learnings dedup is
// now applied UNCONDITIONALLY (Δ1; Projects never had it). Key on
// category|type|normalized-content; keep the earliest timestamp. (Stays in the
// edge — std owns no fold/groupBy, D2.)
// ============================================================================

export function reduceLearnings(all: HarvestedLearning[]): HarvestedLearning[] {
  const seen = new Map<string, HarvestedLearning>();
  for (const l of all) {
    const key = `${l.category}|${l.type}|${l.content.replace(/\s+/g, " ").trim()}`;
    const existing = seen.get(key);
    if (!existing || l.timestamp < existing.timestamp) seen.set(key, l); // keep earliest
  }
  return [...seen.values()];
}

// ============================================================================
// EDGE — write-layout. MEMORY filenames + frontmatter, project-tagged.
// ============================================================================

function getMonthDir(roots: Roots, category: "SYSTEM" | "ALGORITHM"): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const dir = join(roots.learningDir, category, `${now.getFullYear()}-${month}`);
  ensureDir(dir);
  return dir;
}

export function learningFilename(l: HarvestedLearning): string {
  const date = new Date(l.timestamp);
  const dateStr = date.toISOString().split("T")[0];
  const timeStr = date.toISOString().split("T")[1].slice(0, 5).replace(":", "");
  const sessionShort = l.sessionId.slice(0, 8);
  // Project slug in the filename keeps same-timestamp learnings from different
  // projects from clobbering each other.
  return `${dateStr}_${timeStr}_${l.type}_${l.project}_${sessionShort}.md`;
}

export function learningBody(l: HarvestedLearning): string {
  return `# ${l.type.charAt(0).toUpperCase() + l.type.slice(1)} Learning

**Project:** ${projectLabel(l.project)}
**Project Slug:** ${l.project}
**Session:** ${l.sessionId}
**Timestamp:** ${l.timestamp}
**Category:** ${l.category}
**Source Pattern:** ${l.source}

---

## Context

${l.context}

## Learning

${l.content}

---

*Harvested by harvester from projects/ transcript*
`;
}

function writeLearning(roots: Roots, l: HarvestedLearning): { path: string; wrote: boolean } {
  const path = join(getMonthDir(roots, l.category), learningFilename(l));
  // writeIfAbsent (std/report) — O_CREAT|O_EXCL skip-if-exists; returns false
  // when the file already exists (replaces the originals' existsSync+writeFileSync).
  const wrote = writeIfAbsent(path, learningBody(l));
  return { path, wrote };
}

// ============================================================================
// EDGE — mine queue. saveJson (std/fsx) writes `JSON.stringify(…,2)+"\n"` (Δ2).
// ============================================================================

export function queueFilename(m: MinedMemory): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const sessionShort = m.sessionId.slice(0, 8);
  // Project slug so cross-project candidates never collide.
  return `mine_${ts}_${m.memoryType}_${m.project}_${sessionShort}_L${m.sourceLine}.json`;
}

/** The ONE derivation of the provenance tuple — shared by the queue writer and the 15.1 digest so
 *  neither re-derives it (and no consumer has to cast off `Record<string, unknown>`). */
export function provenanceOf(m: MinedMemory): Provenance {
  return { sessionId: m.sessionId, sourceLine: m.sourceLine, timestamp: m.timestamp, projectSlug: m.project };
}

export function queueCandidate(m: MinedMemory): Record<string, unknown> {
  const provenance = provenanceOf(m);
  return {
    title: `${m.memoryType}: ${m.content.substring(0, 60)}...`,
    content: `## ${m.memoryType.charAt(0).toUpperCase() + m.memoryType.slice(1)}\n\n${m.content}\n\n## Context\n\n${m.context}`,
    domain: "Ideas",
    type: "idea",
    tags: [m.memoryType, "mined", `project:${m.project}`],
    confidence: m.confidence,
    sourcePattern: m.sourcePattern,
    project: m.project,
    projectLabel: projectLabel(m.project),
    sourcePath: m.sessionId,
    minedAt: new Date().toISOString(),
    // Dormant Epic-15 seam (§Redesign #2) — no consumer reads it in 11.1.
    provenance,
  };
}

function writeToQueue(roots: Roots, m: MinedMemory): string {
  ensureDir(roots.queueDir);
  const path = join(roots.queueDir, queueFilename(m));
  saveJson(path, queueCandidate(m)); // Δ2 — trailing newline
  return path;
}

// ============================================================================
// DIGEST (Epic 15.1) — a repo-local RENDER of the same mine pass that populates
// the queue. NOT a second producer and NOT a queue reader (AC-D4): digest and
// queue derive from one pass, so there is no rival emit path (NFR4).
// ============================================================================

/** Where the digest lands under `--target`. */
const DIGEST_SUBPATH = join("docs", "session-digest.md");

/**
 * Resolve `--target` to the digest file path, refusing targets that land inside the harvester's own
 * write dirs.
 *
 * ⚠ DO NOT DELETE AS REDUNDANT — this is a RUNTIME guard, not a compile-time one. It stops a digest
 * from being written back into the queue/learning trees the harvester itself owns (NFR4).
 *
 * Scope honestly: this is NOT a MEMORY-wide guard and cannot be. The injected `Roots` carries only
 * `projectsRoot`/`learningDir`/`queueDir` — there is no `frameworkDir` to widen against (a deliberate
 * consequence of D4 injection), and deriving one by walking up from `queueDir` is invalid for injected
 * fixtures. Guard the two dirs actually reachable; claim no more.
 *
 * `resolve()` only — never `realpathSync`: `queueDir` may not exist yet, and `realpathSync` would throw
 * on a perfectly legitimate target. No `..` string check either: `--target` IS the base dir, so there is
 * nothing to traverse out of and a literal `..` test would reject `--target ../my-repo`.
 */
export function resolveDigestPath(roots: Roots, target: string): string {
  const resolved = resolve(target);
  const out = join(resolved, DIGEST_SUBPATH);
  for (const forbidden of [roots.queueDir, roots.learningDir]) {
    const base = resolve(forbidden);
    // Segment-aware containment, so `/x/std-public` is not "inside" `/x/std`.
    // BOTH the target base AND the final write path are checked: guarding only the base lets
    // `--target /x` slip a write into `/x/docs` when a forbidden dir IS `/x/docs`.
    for (const candidate of [resolved, out]) {
      if (candidate === base || candidate.startsWith(base + sep)) {
        throw new Error(`--target refuses a path inside the harvester's own write dir: ${candidate} is inside ${base}`);
      }
    }
  }
  return out;
}

/**
 * Render the mine pass as markdown. PURE — no disk, no clock. Takes the grouped candidates so an
 * unfiltered `--target` renders a grouped-by-project digest; a single-project digest is a one-entry Map.
 *
 * `confidence` is rendered per entry ON PURPOSE: the mine path currently yields many low-confidence
 * prompt-echo candidates, and the digest must make that noise VISIBLE to the human reviewer rather
 * than launder it into clean-looking markdown (flag-don't-fix; the quality fix belongs to 15.3).
 */
/**
 * The ONE sanitizer for anything interpolated into the digest. LOAD-BEARING, not cosmetic.
 *
 * Every field rendered below is transcript- or filesystem-derived and therefore attacker-influenced:
 * `content` is a raw 500-char slice, `timestamp`/`sessionId` come straight off the transcript JSON, and
 * the project slug is a directory basename. Any of them may contain newlines. Interpolated verbatim, a
 * value like "…\n## Injected" forges a sibling project heading, detaches the provenance sub-bullet from
 * its entry (breaking AC3's provenance-to-the-line guarantee), or emits the `_No candidates mined._`
 * sentinel so a full digest reads as empty.
 *
 * Route EVERY digest interpolation through this — collapsing one field and not its siblings is how the
 * first fix for this shipped incomplete.
 */
function digestField(value: unknown): string {
  return collapse(String(value));
}

export function buildDigest(groups: Map<string, MinedMemory[]>): string {
  const { p, toString } = lines();
  p("# Session digest");
  p();
  p("Mined memory candidates for this repo, rendered from the harvester mine pass.");
  p("Every entry carries its provenance to the source line.");
  p();

  let total = 0;
  for (const [project, mems] of groups) {
    if (mems.length === 0) continue;
    total += mems.length;
    p(`## ${digestField(projectLabel(project))} (\`${digestField(project)}\`)`);
    p();
    for (const mem of mems) {
      const prov = provenanceOf(mem); // single derivation — shared with the queue writer
      // Every interpolation goes through digestField() — see its docstring for why sanitizing only
      // `content` (the shape this fix originally shipped in) leaves the same hole open via `timestamp`.
      p(`- **[${digestField(mem.memoryType)}]** (${(mem.confidence * 100).toFixed(0)}% confidence) ${digestField(mem.content)}`);
      p(
        `  - session \`${digestField(prov.sessionId)}\` · line ${digestField(prov.sourceLine)} · ${digestField(prov.timestamp)} · project \`${digestField(prov.projectSlug)}\``,
      );
    }
    p();
  }

  // Explicit empty state — never a stray empty file (an untouched builder would render "").
  if (total === 0) p("_No candidates mined._");

  return toString();
}

/** Write (or, under `--dry-run`, print) the digest. The ONLY caller-side write in the digest path. */
function emitDigest(roots: Roots, groups: Map<string, MinedMemory[]>, target: string, dryRun: boolean): void {
  const path = resolveDigestPath(roots, target);
  const md = buildDigest(groups);
  if (dryRun) {
    console.log(`\n\u{1F4C4} digest (dry run) → ${path}\n`);
    console.log(md);
    return;
  }
  atomicWrite(path, `${md}\n`); // atomicWrite self-ensureDir()s — no caller-side ensureDir
  console.log(`\n\u{1F4C4} digest → ${path}`);
}

function confidenceIcon(c: number): string {
  if (c >= 0.8) return "\u{1F7E2}"; // green circle
  if (c >= 0.5) return "\u{1F7E1}"; // yellow circle
  return "\u{1F534}"; // red circle
}

// ============================================================================
// RUN — map → reduce → write, grouped-by-project console output.
// ============================================================================

export function runHarvest(roots: Roots, sel: Selection, opts: { dryRun?: boolean } = {}): number {
  const sessions = [...discoverSessions(roots.projectsRoot, sel)];
  if (sessions.length === 0) {
    console.log("No sessions found to harvest");
    return 0;
  }

  const projectCount = new Set(sessions.map((s) => s.project)).size;
  console.log(`\u{1F50D} Scanning ${sessions.length} session(s) across ${projectCount} project(s)...`);

  // map — fold one session's raw at a time (the lazy Iterable contract).
  const all: HarvestedLearning[] = [];
  const byProject = new Map<string, number>();
  for (const ref of sessions) {
    const raw = readFileSync(ref.path, "utf-8");
    const { learnings } = harvestSession(ref, raw);
    if (learnings.length > 0) {
      byProject.set(ref.project, (byProject.get(ref.project) ?? 0) + learnings.length);
    }
    all.push(...learnings);
  }

  // reduce — cross-session dedup (Δ1, always-on).
  const rawCount = all.length;
  const learnings = reduceLearnings(all);
  const dupeCount = rawCount - learnings.length;

  if (learnings.length === 0) {
    console.log("\u{2705} No new learnings found");
    return 0;
  }

  for (const [project, count] of byProject) {
    console.log(`\n\u{1F4C1} ${projectLabel(project)}: ${count} learning(s)`);
  }
  if (dupeCount > 0) {
    console.log(`\n\u{1F9F9} Removed ${dupeCount} cross-session duplicate(s) (${rawCount} \u{2192} ${learnings.length})`);
  }
  console.log(`\n\u{1F4CA} Found ${learnings.length} learning(s) across ${projectCount} project(s)`);
  console.log(`   - Corrections: ${learnings.filter((l) => l.type === "correction").length}`);
  console.log(`   - Errors: ${learnings.filter((l) => l.type === "error").length}`);
  console.log(`   - Insights: ${learnings.filter((l) => l.type === "insight").length}`);

  if (opts.dryRun) {
    console.log("\n\u{1F50D} DRY RUN - Would write:");
    for (const l of learnings) {
      console.log(`   ${l.category}/${learningFilename(l)}`);
    }
  } else {
    console.log("\n\u{270D}\u{FE0F}  Writing learning files...");
    let wrote = 0;
    for (const l of learnings) {
      const { wrote: didWrite } = writeLearning(roots, l);
      if (didWrite) wrote++;
    }
    console.log(`\n\u{2705} Harvested ${wrote} learning(s) to MEMORY/LEARNING/`);
  }
  return learnings.length;
}

export function runMine(roots: Roots, sel: Selection, opts: { dryRun?: boolean; target?: string } = {}): number {
  // Validate the target BEFORE mining, so a hostile path fails fast instead of after the work.
  if (opts.target !== undefined) resolveDigestPath(roots, opts.target);

  const sessions = [...discoverSessions(roots.projectsRoot, sel)];
  if (sessions.length === 0) {
    console.log("No sessions found to harvest");
    if (opts.target !== undefined) emitDigest(roots, new Map(), opts.target, opts.dryRun === true);
    return 0;
  }

  const projectCount = new Set(sessions.map((s) => s.project)).size;
  console.log(`\u{1F50D} Mining ${sessions.length} session(s) across ${projectCount} project(s) for memory candidates...`);

  // Group by project for readable output (ProjectsHarvester shape).
  const byProject = new Map<string, SessionRef[]>();
  for (const ref of sessions) {
    const group = byProject.get(ref.project);
    if (group) group.push(ref);
    else byProject.set(ref.project, [ref]);
  }

  // `byProject` holds SessionRefs, not candidates — the MinedMemory values only exist inside the loop
  // below, so the digest accumulates them as they are produced, reusing byProject for grouping ORDER.
  const digestGroups = new Map<string, MinedMemory[]>();

  let totalMined = 0;
  for (const [project, refs] of byProject) {
    let projectMined = 0;
    const out: string[] = [];
    const projectCandidates: MinedMemory[] = [];
    for (const ref of refs) {
      const raw = readFileSync(ref.path, "utf-8");
      const { mined } = harvestSession(ref, raw);
      for (const mem of mined) {
        if (!opts.dryRun) writeToQueue(roots, mem);
        projectCandidates.push(mem);
        out.push(
          `  ${confidenceIcon(mem.confidence)} [${mem.memoryType}] ${mem.content.substring(0, 80)}... (${(mem.confidence * 100).toFixed(0)}%)`,
        );
        projectMined++;
        totalMined++;
      }
    }
    if (projectMined > 0) {
      console.log(`\n\u{1F4C1} ${projectLabel(project)}: ${projectMined} candidate(s)`);
      out.forEach((l) => console.log(l));
      digestGroups.set(project, projectCandidates);
    }
  }

  if (opts.target !== undefined) emitDigest(roots, digestGroups, opts.target, opts.dryRun === true);

  console.log(`\n\u{2705} ${totalMined} candidate(s) ${opts.dryRun ? "found (dry run)" : "queued for review"}`);
  if (!opts.dryRun && totalMined > 0) {
    console.log(`  Review: bun KnowledgeHarvester.ts harvest --source queue`);
  }
  return totalMined;
}

// ============================================================================
// CLI — per-flag (core/args), NOT node:util parseArgs (gap #4). No dispatch:
// the mode is the `--mine` boolean, there are no subcommands.
// ============================================================================

const HELP = `
harvester - the converged session/projects memory-harvester (Epic 11.1)

Harvests learnings across ALL Claude Code projects and mines conversations for
structured memory candidates. Output is tagged + grouped by project of origin.

Usage:
  harvester --recent 10     Harvest 10 most recent sessions PER project (default)
  harvester --all           Harvest all sessions modified in the last 7 days
  harvester --session ID    Harvest a specific session UUID (any project)
  harvester --project STR   Only scan projects whose slug contains STR
  harvester --dry-run       Preview without writing files
  harvester --mine          Mine for decisions, preferences, milestones, problems
  harvester --target DIR    With --mine: also render the pass as a repo-local
                            digest at DIR/docs/session-digest.md. Orthogonal to
                            --project: unfiltered, the digest is grouped by project.
  harvester --help          Show this help

Examples:
  harvester --recent 5
  harvester --all --dry-run
  harvester --project pipis --recent 10
  harvester --mine --recent 5
  harvester --mine --project pipis --target ~/Dev/pipis
  harvester --mine --target ~/Dev/pipis --dry-run

Output (tagged by project of origin):
  Harvest: MEMORY/LEARNING/{ALGORITHM|SYSTEM}/YYYY-MM/
  Mine:    MEMORY/KNOWLEDGE/_harvest-queue/ (review queue)
  Digest:  <target>/docs/session-digest.md (with --target)
`;

const KNOWN_FLAGS = new Set(["recent", "all", "session", "project", "dry-run", "mine", "target", "help"]);

/** Tokens starting with `--` whose name isn't a known flag (gap #4: core/args is
 *  per-flag and does not reject unknowns the way the originals' strict parseArgs did,
 *  so the tool restores that guard itself). Values never start with `--`. */
export function unknownFlags(argv: string[]): string[] {
  return argv.filter((t) => t.startsWith("--") && !KNOWN_FLAGS.has(t.slice(2).split("=")[0]));
}

/**
 * Read `--target`, rejecting the three ways `core.flagValue` misparses a value-flag given no value.
 * `flagValue` returns `args[i + 1]` unconditionally, so without this guard:
 *   `--target --project foo` → target `"--project"` → writes `./--project/docs/…`
 *   `--target=`              → target `""` → `resolve("")` is cwd → writes into whatever repo you stand in
 *   `--target` (last token)  → `undefined` → SILENT no-op, exit 0, user believes it worked
 * The tool fails loud everywhere else (`unknownFlags` → 2, `resolveDigestPath` throws); this closes the
 * one input path that didn't. Returns `undefined` only when `--target` is genuinely absent.
 *
 * The underlying `core.flagValue` look-ahead gap is shared by `--project`/`--session`/`--recent` and is
 * flagged for a Rule-of-Three conversation — fixing it in `src/core/args.ts` would breach AC6's
 * zero-`src`-delta requirement, so it is guarded caller-side here.
 */
export function targetFromArgv(argv: string[]): string | undefined {
  if (!hasFlag(argv, "target") && !argv.some((t) => t.startsWith("--target="))) return undefined;
  const value = flagValue(argv, "target");
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error("--target requires a directory value (e.g. --target ~/Dev/my-repo)");
  }
  return value;
}

export function main(argv: string[]): number {
  if (hasFlag(argv, "help")) {
    console.log(HELP);
    return 0;
  }

  const unknown = unknownFlags(argv);
  if (unknown.length > 0) {
    console.error(`Unknown flag(s): ${unknown.join(", ")}`);
    console.error(HELP);
    return 2; // usage error — non-zero, like the originals' strict parseArgs
  }

  const recentRaw = flagValue(argv, "recent");
  const sel: Selection = {
    recent: recentRaw !== undefined ? parseInt(recentRaw, 10) : undefined,
    all: hasFlag(argv, "all"),
    sessionId: flagValue(argv, "session"),
    project: flagValue(argv, "project"),
  };
  const dryRun = hasFlag(argv, "dry-run");

  // `--target` is orthogonal to `--project`: it selects WHERE the digest lands, never WHICH sessions
  // are mined. Unfiltered, the digest is simply grouped by project. Parsed BEFORE `defaultRoots()` so a
  // malformed value is a usage error (exit 2), not a half-run. Only this parse is wrapped — widening the
  // catch over the dispatch would swallow `runHarvest`'s fail-loud I/O errors (FR5).
  let target: string | undefined;
  try {
    target = targetFromArgv(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (target !== undefined && !hasFlag(argv, "mine")) {
    console.error("--target applies to the mine path only; add --mine");
    return 2; // fail loud rather than silently ignoring the flag
  }

  const roots = defaultRoots();

  if (hasFlag(argv, "mine")) {
    runMine(roots, sel, { dryRun, target });
  } else {
    runHarvest(roots, sel, { dryRun });
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(Bun.argv.slice(2)));
}
