#!/usr/bin/env bun
/**
 * opinion-tracker — Story 12.4 rewrite onto the std substrate (proof/ consumer; live cutover to
 * ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). Behavior preserved; re-rolled plumbing now
 * imports tested std primitives:
 *   - the confidence progress bar (was `"█".repeat(round)…"░".repeat(…)`) → `core.bar`
 *   - the 8 `indexOf("--flag")` arg-parse copies → `positional`/`dispatch`/`flagValue`/`hasFlag`
 *   - the date stamps (`new Date().toISOString().split("T")[0]`) → `isoDate(now)` (now injected)
 *   - the `### `-block locate/splice (persistEvidence) → `findSection`/`insertInSection`
 *   - the relationship-log append (it IS an audit log) → `report.appendAudit`
 *   - the `**Confidence:**` READ → `getMetaField` + local `Number(...)`
 *   - the mkdir guard / whole-file read+write → `fsx.ensureDir`/`readIfExists`/`atomicWrite`
 *
 * Kept CALLER-LOCAL (D4 — identity never crosses into std): the `~/.claude` path roots
 * (`OPINIONS.md`, `MEMORY/RELATIONSHIP`), the confidence engine (`CONFIDENCE_ADJUSTMENTS`,
 * `NOTIFICATION_THRESHOLD`, 0.01–0.99 clamp), the evidence model + table schema, the OPINIONS.md
 * heading/marker bytes (`### `, `**Confidence:**`, `*Last updated:*`), the `{{PRINCIPAL_NAME}}` token,
 * and every `**Confidence:**` WRITER (`content.replace(/…/, …)`) — getMetaField is a read-only getter.
 *
 * TZ NOTE (faithful UTC port): the original month-dir sites used `new Date().toISOString().slice(0,7)`
 * — i.e. the UTC month, not a local-tz month. `isoDate(now)` is UTC `YYYY-MM-DD`, so
 * `isoDate(now).slice(0,7)` reproduces the original month bytes exactly. No IANA tz is threaded because
 * the tool never used one; the dir name being UTC is faithful, not load-bearing on any local tz.
 */

import { join } from "node:path";
import {
  bar,
  dispatch,
  flagValue,
  getMetaField,
  findSection,
  hasFlag,
  insertInSection,
  isoDate,
  positional,
} from "std/core";
import { ensureDir, readIfExists, atomicWrite, resolveFrameworkDir } from "std/fsx";
import { appendAudit } from "std/report";

// ── caller-local identity + engine (D4) ────────────────────────────────────────────────────────────

export interface Ctx {
  /** Path to OPINIONS.md. */
  opinionsFile: string;
  /** Root of the MEMORY/RELATIONSHIP audit tree. */
  relationshipLog: string;
  /** Injected clock — every date stamp / timestamp reads from here (no ambient `new Date()`). */
  now: Date;
}

export function defaultCtx(): Ctx {
  const PAI_DIR = process.env.LIFEOS_DIR || process.env.PAI_DIR || resolveFrameworkDir(process.env.HOME!);
  return {
    opinionsFile: join(PAI_DIR, "USER/OPINIONS.md"),
    relationshipLog: join(PAI_DIR, "MEMORY/RELATIONSHIP"),
    now: new Date(),
  };
}

export interface Evidence {
  date: string;
  type: "supporting" | "counter" | "confirmation" | "contradiction";
  description: string;
  session_id?: string;
}

export interface Opinion {
  statement: string;
  confidence: number;
  category: "communication" | "technical" | "relationship" | "work_style";
  evidence: Evidence[];
  last_updated: string;
  created: string;
}

// Confidence adjustment values (caller policy — never crosses into core).
const CONFIDENCE_ADJUSTMENTS = {
  supporting: 0.02,
  counter: -0.05,
  confirmation: 0.1, // Explicit "yes that's right" from {{PRINCIPAL_NAME}}
  contradiction: -0.2, // Explicit "no that's wrong" from {{PRINCIPAL_NAME}}
};

const NOTIFICATION_THRESHOLD = 0.15;

// ── bar (byte-parity with the original inline track) ────────────────────────────────────────────────

/**
 * The confidence track. Byte-identical to the original
 *   `"█".repeat(round(c*10)) + "░".repeat(10 - round(c*10))`
 * because `bar(round(c*10), 10, {width:10})` computes `f = round((round(c*10)/10) * 10) = round(c*10)`,
 * clamped to [0,10]. `brackets:false` → no `[`…`]`; the `[`…`]` wrap and the ` NN%` suffix stay
 * caller-side in `listOpinions` (D4).
 */
export function confidenceBar(confidence: number): string {
  return bar(Math.round(confidence * 10), 10, { fillChar: "█", emptyChar: "░", brackets: false });
}

// ── date stamp (isoDate on the injected clock) ──────────────────────────────────────────────────────

function getISODate(ctx: Ctx): string {
  return isoDate(ctx.now); // UTC YYYY-MM-DD — same bytes as toISOString().split("T")[0]
}

// ── OPINIONS.md read / parse ────────────────────────────────────────────────────────────────────────

/**
 * Parse OPINIONS.md into structured data. The `### `-block split, the category/last-updated regexes,
 * and the evidence-table scan are caller-local schema. The one substrate swap: the `**Confidence:**`
 * READ is now `getMetaField(block, "Confidence")` + a local `Number(...)` (was a bespoke
 * `/\*\*Confidence:\*\*\s*([\d.]+)/` match).
 */
export function parseOpinions(ctx: Ctx): Map<string, Opinion> {
  const opinions = new Map<string, Opinion>();

  const content = readIfExists(ctx.opinionsFile);
  if (content === null) return opinions;

  // Format: ### Statement\n**Confidence:** 0.XX
  const opinionBlocks = content.split(/^### /gm).slice(1);

  for (const block of opinionBlocks) {
    const lines = block.split("\n");
    const statement = lines[0]?.trim();
    if (!statement) continue;

    const confRaw = getMetaField(block, "Confidence");
    const confidence = confRaw !== null && confRaw !== "" ? Number(confRaw) : 0.5;

    const categoryMatch = block.match(/## (\w+) Opinions/i);
    const category = (categoryMatch?.[1]?.toLowerCase() || "relationship") as Opinion["category"];

    const lastUpdatedMatch = block.match(/\*Last updated:\s*([^*]+)\*/);
    const lastUpdated = lastUpdatedMatch?.[1]?.trim() || getISODate(ctx);

    // Extract evidence from table
    const evidence: Evidence[] = [];
    const tableRows = block.match(/\| (Supporting|Counter) \| ([^|]+) \|/gi) || [];
    for (const row of tableRows) {
      const [, type, desc] = row.match(/\| (Supporting|Counter) \| ([^|]+) \|/i) || [];
      if (type && desc) {
        evidence.push({
          date: getISODate(ctx),
          type: type.toLowerCase() as "supporting" | "counter",
          description: desc.trim(),
        });
      }
    }

    opinions.set(statement.toLowerCase(), {
      statement,
      confidence,
      category,
      evidence,
      last_updated: lastUpdated,
      created: lastUpdated,
    });
  }

  return opinions;
}

// ── OPINIONS.md writers (append-only / in-place; **Confidence:** WRITER stays local) ────────────────

/**
 * Append a new opinion as a structured `### ` block. APPEND-ONLY — never rewrites the file, so any
 * hand-curated prose in OPINIONS.md is preserved. Read+write now go through `readIfExists`/`atomicWrite`.
 */
export function appendOpinionToFile(ctx: Ctx, opinion: Opinion): void {
  const block =
    `\n### ${opinion.statement}\n` +
    `**Confidence:** ${opinion.confidence.toFixed(2)}\n` +
    `*Last updated: ${opinion.last_updated}*\n`;
  const existing = readIfExists(ctx.opinionsFile)?.replace(/\s*$/, "") ?? "# DA Opinions";
  atomicWrite(ctx.opinionsFile, `${existing}\n${block}`);
}

/**
 * Persist an evidence update IN PLACE. The `### ` block is now LOCATED with `findSection` and the
 * evidence row SPLICED with `insertInSection` (replacing the hand-rolled `indexOf("### ")` +
 * `indexOf("\n### ")` boundary scan). If the statement isn't found as a structured block the file is
 * left untouched (so prose-format opinions are never corrupted).
 *
 * The `**Confidence:**` bump is a WRITER — it stays a caller-local `content.replace(/…/, …)` (D4;
 * getMetaField is read-only). Boundary nuance vs the original: findSection ends the block at the next
 * heading of level ≤3 (so an intervening `## Category` header now correctly bounds the block, where the
 * old `\n### ` scan would have swallowed it); on the common single-block / block-then-`### ` shapes the
 * result is equivalent, modulo insertInSection's trailing-newline handling.
 */
export function persistEvidence(ctx: Ctx, opinion: Opinion, evidence: Evidence): void {
  const content = readIfExists(ctx.opinionsFile);
  if (content === null) return;

  const heading = `### ${opinion.statement}`;
  const bounds = findSection(content, heading);
  if (!bounds) return;

  // (1) Confidence bump — a **Field:** WRITER, kept local; rewrite only within the located block.
  const before = content.slice(0, bounds.start);
  const block = content
    .slice(bounds.start, bounds.bodyEnd)
    .replace(/\*\*Confidence:\*\*\s*[\d.]+/, `**Confidence:** ${opinion.confidence.toFixed(2)}`);
  const after = content.slice(bounds.bodyEnd);
  const withConfidence = before + block + after;

  // (2) Evidence row — spliced into the section (leading "\n" so it lands on its own line).
  const label =
    evidence.type === "counter" || evidence.type === "contradiction" ? "Counter" : "Supporting";
  const cleaned = evidence.description.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const row = `\n| ${label} | ${cleaned} |\n`;
  const updated = insertInSection(withConfidence, heading, row);

  atomicWrite(ctx.opinionsFile, updated);
}

// ── evidence / opinion mutation ─────────────────────────────────────────────────────────────────────

/** Add new evidence to an opinion and update confidence. */
export function addEvidence(
  ctx: Ctx,
  statement: string,
  evidenceType: Evidence["type"],
  description: string,
  sessionId?: string,
): { opinion: Opinion; confidenceChange: number; needsNotification: boolean } {
  const opinions = parseOpinions(ctx);
  const key = statement.toLowerCase();

  const opinion = opinions.get(key);
  if (!opinion) {
    throw new Error(`Opinion not found: "${statement}"`);
  }

  const oldConfidence = opinion.confidence;
  const adjustment = CONFIDENCE_ADJUSTMENTS[evidenceType];

  // Update confidence (clamped to 0.01 - 0.99)
  opinion.confidence = Math.max(0.01, Math.min(0.99, opinion.confidence + adjustment));
  opinion.last_updated = getISODate(ctx);

  // Add evidence
  opinion.evidence.push({
    date: getISODate(ctx),
    type: evidenceType,
    description,
    session_id: sessionId,
  });

  const confidenceChange = opinion.confidence - oldConfidence;
  const needsNotification = Math.abs(confidenceChange) >= NOTIFICATION_THRESHOLD;

  // Log to relationship memory
  logRelationshipEvent(ctx, "opinion_update", {
    statement: opinion.statement,
    old_confidence: oldConfidence,
    new_confidence: opinion.confidence,
    evidence_type: evidenceType,
    description,
  });

  // Persist the confidence bump + evidence row (in place; safe on prose files).
  persistEvidence(ctx, opinion, opinion.evidence[opinion.evidence.length - 1]);

  return { opinion, confidenceChange, needsNotification };
}

/** Add a new opinion. */
export function addOpinion(
  ctx: Ctx,
  statement: string,
  category: Opinion["category"],
  initialConfidence = 0.5,
): Opinion {
  const opinion: Opinion = {
    statement,
    confidence: initialConfidence,
    category,
    evidence: [],
    last_updated: getISODate(ctx),
    created: getISODate(ctx),
  };

  logRelationshipEvent(ctx, "opinion_created", {
    statement,
    category,
    initial_confidence: initialConfidence,
  });

  // Persist (append-only) so the new opinion survives the process.
  appendOpinionToFile(ctx, opinion);

  return opinion;
}

/**
 * Log an event to the relationship memory. This IS an append-only audit trail, so it goes through
 * `report.appendAudit` (best-effort JSONL append with size rotation). The month dir is UTC — a faithful
 * port of the original `new Date().toISOString().slice(0,7)` via `isoDate(now).slice(0,7)`.
 */
export function logRelationshipEvent(
  ctx: Ctx,
  eventType: string,
  data: Record<string, unknown>,
): void {
  const today = getISODate(ctx);
  const monthDir = join(ctx.relationshipLog, today.slice(0, 7)); // UTC month
  ensureDir(monthDir);
  const logFile = join(monthDir, `${today}.jsonl`);

  const entry = {
    timestamp: ctx.now.toISOString(),
    event_type: eventType,
    ...data,
  };

  appendAudit(logFile, entry);
}

/** Generate notification message for significant opinion change. Pure. */
export function generateNotification(
  statement: string,
  oldConfidence: number,
  newConfidence: number,
  evidenceType: Evidence["type"],
): string {
  const direction = newConfidence > oldConfidence ? "increased" : "decreased";
  const emoji = newConfidence > oldConfidence ? "📈" : "📉";

  return `
${emoji} Opinion Confidence ${direction.toUpperCase()}

**Opinion:** ${statement}
**Change:** ${(oldConfidence * 100).toFixed(0)}% → ${(newConfidence * 100).toFixed(0)}%
**Cause:** ${evidenceType} evidence

This change exceeds the notification threshold (${NOTIFICATION_THRESHOLD * 100}%).
`.trim();
}

// ── read-only views ─────────────────────────────────────────────────────────────────────────────────

/** List all opinions with their confidence levels. */
export function listOpinions(ctx: Ctx): void {
  const opinions = parseOpinions(ctx);

  console.log("\n📊 Current Opinions\n");

  const categories = new Map<string, Opinion[]>();
  for (const opinion of opinions.values()) {
    const list = categories.get(opinion.category) || [];
    list.push(opinion);
    categories.set(opinion.category, list);
  }

  for (const [category, opinionList] of categories) {
    console.log(`\n## ${category.charAt(0).toUpperCase() + category.slice(1)}\n`);

    for (const op of opinionList.sort((a, b) => b.confidence - a.confidence)) {
      // `[`…`]` wrap + ` NN%` suffix stay caller-side (D4); only the track comes from `bar`.
      console.log(`  [${confidenceBar(op.confidence)}] ${(op.confidence * 100).toFixed(0)}% - ${op.statement}`);
    }
  }

  console.log("");
}

/** Show details for a specific opinion. Returns an exit code (0 found, 1 not found). */
export function showOpinion(ctx: Ctx, statement: string): number {
  const opinions = parseOpinions(ctx);
  const opinion = opinions.get(statement.toLowerCase());

  if (!opinion) {
    console.error(`Opinion not found: "${statement}"`);
    return 1;
  }

  console.log(`
📋 Opinion Details

**Statement:** ${opinion.statement}
**Confidence:** ${(opinion.confidence * 100).toFixed(0)}%
**Category:** ${opinion.category}
**Created:** ${opinion.created}
**Last Updated:** ${opinion.last_updated}

## Evidence (${opinion.evidence.length} items)
`);

  const supporting = opinion.evidence.filter(
    (e) => e.type === "supporting" || e.type === "confirmation",
  );
  const counter = opinion.evidence.filter(
    (e) => e.type === "counter" || e.type === "contradiction",
  );

  if (supporting.length > 0) {
    console.log("### Supporting");
    for (const e of supporting) {
      console.log(`  - [${e.date}] ${e.description}`);
    }
  }

  if (counter.length > 0) {
    console.log("\n### Counter");
    for (const e of counter) {
      console.log(`  - [${e.date}] ${e.description}`);
    }
  }

  return 0;
}

// ── CLI (dispatch/positional/flagValue/hasFlag replace the 8 indexOf copies) ─────────────────────────

const EVIDENCE_TYPES: Evidence["type"][] = [
  "supporting",
  "counter",
  "confirmation",
  "contradiction",
];

const HELP = `
OpinionTracker - Manage confidence-tracked opinions

Commands:
  add "statement" [--category <cat>]           Add new opinion
  evidence "statement" --supporting "desc"     Add supporting evidence
  evidence "statement" --counter "desc"        Add counter evidence
  evidence "statement" --confirmation "desc"   {{PRINCIPAL_NAME}} explicitly confirmed
  evidence "statement" --contradiction "desc"  {{PRINCIPAL_NAME}} explicitly contradicted
  list                                         List all opinions
  show "statement"                             Show opinion details

Categories: communication, technical, relationship, work_style
`;

function cmdAdd(ctx: Ctx, argv: string[]): number {
  const statement = argv[1];
  const category = (flagValue(argv, "category") ?? "relationship") as Opinion["category"];

  if (!statement) {
    console.error(
      'Usage: bun OpinionTracker.ts add "statement" [--category communication|technical|relationship|work_style]',
    );
    return 1;
  }

  addOpinion(ctx, statement, category);
  console.log(`✅ Added opinion: "${statement}" (${category}, confidence: 50%)`);
  return 0;
}

function cmdEvidence(ctx: Ctx, argv: string[]): number {
  const statement = argv[1];

  let evidenceType: Evidence["type"] | undefined;
  let description: string | undefined;
  for (const t of EVIDENCE_TYPES) {
    if (hasFlag(argv, t)) {
      evidenceType = t;
      description = flagValue(argv, t);
      break;
    }
  }

  const usage =
    'Usage: bun OpinionTracker.ts evidence "statement" --supporting|--counter|--confirmation|--contradiction "description"';

  if (!evidenceType) {
    console.error(usage);
    return 1;
  }
  if (!statement || !description) {
    console.error(usage);
    return 1;
  }

  try {
    const result = addEvidence(ctx, statement, evidenceType, description);
    console.log(`✅ Added ${evidenceType} evidence to "${statement}"`);
    console.log(
      `   Confidence: ${(result.opinion.confidence * 100).toFixed(0)}% (${result.confidenceChange > 0 ? "+" : ""}${(result.confidenceChange * 100).toFixed(1)}%)`,
    );

    if (result.needsNotification) {
      console.log("\n⚠️  SIGNIFICANT CHANGE - {{PRINCIPAL_NAME}} should be notified");
    }
    return 0;
  } catch (err) {
    console.error(`❌ ${err}`);
    return 1;
  }
}

function cmdShow(ctx: Ctx, argv: string[]): number {
  const statement = argv[1];
  if (!statement) {
    console.error('Usage: bun OpinionTracker.ts show "statement"');
    return 1;
  }
  return showOpinion(ctx, statement);
}

function cmdHelp(): number {
  console.log(HELP);
  return 0;
}

export function main(argv: string[] = process.argv.slice(2), ctx: Ctx = defaultCtx()): number {
  const command = positional(argv); // first non-`--` arg (the subcommand)
  return dispatch(
    command,
    {
      add: () => cmdAdd(ctx, argv),
      evidence: () => cmdEvidence(ctx, argv),
      list: () => {
        listOpinions(ctx);
        return 0;
      },
      show: () => cmdShow(ctx, argv),
    },
    cmdHelp,
  );
}

if (import.meta.main) {
  process.exit(main());
}
