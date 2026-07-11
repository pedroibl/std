#!/usr/bin/env bun
/**
 * MigrateScan — Story 12.4 rewrite onto the std substrate (proof/ consumer; live cutover to
 * ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). Behavior preserved; the re-rolled
 * scoring / chunking / walk / preview / arg plumbing now imports tested std primitives.
 *
 * Intake content from external sources (other PAI installs, other agent harnesses,
 * Obsidian/Notion/Apple-Notes exports, Claude.md files, Cursor rules, OpenAI Custom
 * Instructions, raw journal dumps) and propose a target destination in the PAI structure
 * per chunk. V1 scope: markdown / plain text. Emits a proposal queue (NDJSON) that
 * MigrateApprove.ts commits after {{PRINCIPAL_NAME}}'s approval.
 *
 * MigrateScan is the ORIGIN of scoreRules' confidence formula `min(1,(margin+top*0.3)/10)`,
 * so we consume the returned `confidence` VERBATIM — no edge recompute.
 *
 * Kept caller-local (D4): the RULES table + the `Target` union + reasons/alternatives derivation
 * (consumer vocabulary), the MIGRATION queue path (injected at the edge), the `Proposal` WIRE
 * FORMAT (frozen contract with MigrateApprove), and the human-readable render bytes.
 *
 * Usage:
 *   bun migrate-scan.ts --source <file>           Scan a single file
 *   bun migrate-scan.ts --source <dir>            Scan all .md/.txt in directory
 *   bun migrate-scan.ts --stdin                   Read from stdin
 *   bun migrate-scan.ts --source X --json         JSON output for approve pipeline
 *   bun migrate-scan.ts --source X --dry-run      Preview without writing queue
 */

import { readFileSync, existsSync, statSync, appendFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { scoreRules, chunkContent, truncate, collapse, flagValue, hasFlag, type ScoreRule } from "std/core";
import { walkFiles, ensureDir } from "std/fsx";
import { emitJson } from "std/report";

// ─── Edge identity (D4): MIGRATION queue path, injected/overridable at the edge ───

function defaultQueueFile(): string {
  const HOME = process.env.HOME || "";
  const PAI_DIR = process.env.PAI_DIR || join(HOME, ".claude", "PAI");
  return join(PAI_DIR, "MEMORY", "MIGRATION", "migration-proposals.jsonl");
}

// ─── Caller-local target vocabulary (D4) ───

export type Target =
  | "TELOS/MISSION.md"
  | "TELOS/GOALS.md"
  | "TELOS/PROBLEMS.md"
  | "TELOS/STRATEGIES.md"
  | "TELOS/CHALLENGES.md"
  | "TELOS/BELIEFS.md"
  | "TELOS/WISDOM.md"
  | "TELOS/MODELS.md"
  | "TELOS/FRAMES.md"
  | "TELOS/NARRATIVES.md"
  | "TELOS/SPARKS.md"
  | "TELOS/IDEAL_STATE/HEALTH.md"
  | "TELOS/IDEAL_STATE/MONEY.md"
  | "TELOS/IDEAL_STATE/FREEDOM.md"
  | "TELOS/IDEAL_STATE/RELATIONSHIPS.md"
  | "TELOS/IDEAL_STATE/CREATIVE.md"
  | "TELOS/IDEAL_STATE/RHYTHMS.md"
  | "TELOS/BOOKS.md"
  | "TELOS/AUTHORS.md"
  | "TELOS/MOVIES.md"
  | "TELOS/BANDS.md"
  | "TELOS/RESTAURANTS.md"
  | "TELOS/FOOD_PREFERENCES.md"
  | "TELOS/LEARNING.md"
  | "TELOS/MEETUPS.md"
  | "TELOS/CIVIC.md"
  | "USER/PRINCIPAL_IDENTITY.md"
  | "MEMORY/KNOWLEDGE/Ideas"
  | "MEMORY/KNOWLEDGE/People"
  | "MEMORY/KNOWLEDGE/Companies"
  | "MEMORY/KNOWLEDGE/Research"
  | "memory/feedback"
  | "UNCLEAR";

// ─── WIRE FORMAT FROZEN — contract with MigrateApprove.ts (field set + status enum) ───

export type Proposal = {
  id: string;
  timestamp: string;
  source_file: string;
  source_section: string;
  content_preview: string;
  content_full: string;
  proposed_target: Target;
  classification_confidence: number; // 0-1
  classification_reasons: string[];
  alternatives: Target[];
  status: "pending" | "approved" | "rejected" | "modified";
};

// ─── Classification rules (keyword → target, with weight) — caller-local (D4) ───

export const RULES: Array<{ target: Target; patterns: RegExp[]; weight: number }> = [
  // Foundational TELOS
  { target: "TELOS/MISSION.md", patterns: [/\bmission\b/i, /\bnorth[\s-]?star\b/i, /\bwhy I\b(work|build|do)/i, /\blife's?\s+work\b/i], weight: 3 },
  { target: "TELOS/GOALS.md", patterns: [/\bgoal[s]?\b/i, /\btarget\b/i, /\bmilestone\b/i, /\bby (end of|Q[1-4]|next year|2026|2027)/i, /\baim to\b/i], weight: 2 },
  { target: "TELOS/PROBLEMS.md", patterns: [/\bproblem\b/i, /\bissue\b/i, /\bcrisis\b/i, /\bbroken\b/i, /\bsolve\b/i], weight: 2 },
  { target: "TELOS/STRATEGIES.md", patterns: [/\bstrategy\b/i, /\bapproach\b/i, /\bplan of attack\b/i, /\bhow we'?ll\b/i], weight: 2 },
  { target: "TELOS/CHALLENGES.md", patterns: [/\bstruggle[s]? with\b/i, /\bI procrastinate\b/i, /\bweakness\b/i, /\bbad at\b/i, /\bblocker\b/i], weight: 2 },
  { target: "TELOS/BELIEFS.md", patterns: [/\bI (believe|am convinced|am certain)\b/i, /\bmy conviction\b/i, /\bcore belief\b/i], weight: 2 },
  { target: "TELOS/WISDOM.md", patterns: [/\blearned that\b/i, /\binsight\b/i, /\brule of thumb\b/i, /\bhard[-\s]won\b/i, /\baphorism\b/i], weight: 2 },
  { target: "TELOS/MODELS.md", patterns: [/\bmental model\b/i, /\bframework\b/i, /\bheuristic\b/i, /\bway of thinking\b/i], weight: 2 },
  { target: "TELOS/FRAMES.md", patterns: [/\bframe\b/i, /\blens\b/i, /\bway of seeing\b/i], weight: 1 },
  { target: "TELOS/NARRATIVES.md", patterns: [/\bpitch\b/i, /\bone[-\s]liner\b/i, /\belevator pitch\b/i, /\bhow I describe\b/i], weight: 2 },
  { target: "TELOS/SPARKS.md", patterns: [/\bspark\b/i, /\bcreative (drive|pull|itch)\b/i, /\bplay\b/i, /\balways wanted to\b/i], weight: 2 },

  // IDEAL_STATE
  { target: "TELOS/IDEAL_STATE/HEALTH.md", patterns: [/\bweight\b/i, /\bsleep\b/i, /\bfitness\b/i, /\bcholesterol\b/i, /\bVO2\b/i, /\bbloodwork\b/i, /\bexercise\b/i], weight: 2 },
  { target: "TELOS/IDEAL_STATE/MONEY.md", patterns: [/\b(revenue|income|burn|runway|savings rate|investment)\b/i, /\b(MRR|ARR|net worth)\b/i, /\$\d/], weight: 2 },
  { target: "TELOS/IDEAL_STATE/FREEDOM.md", patterns: [/\bmeetings? per\b/i, /\bdeep work\b/i, /\btravel\b/i, /\bcalendar\b/i, /\bautonomy\b/i], weight: 2 },
  { target: "TELOS/IDEAL_STATE/RELATIONSHIPS.md", patterns: [/\bpartner\b/i, /\bspouse\b/i, /\bdaughters?\b/i, /\bsons?\b/i, /\bchildren\b/i, /\bfamily\b/i, /\btier[-\s][ABC]\b/i, /\bfriends?\b/i], weight: 2 },
  { target: "TELOS/IDEAL_STATE/CREATIVE.md", patterns: [/\bdrums?\b/i, /\bfiction\b/i, /\bwriting\b/i, /\bmusic\b/i, /\bcreative block\b/i], weight: 2 },
  { target: "TELOS/IDEAL_STATE/RHYTHMS.md", patterns: [/\bmorning ritual\b/i, /\bdaily rhythm\b/i, /\bweekly\b/i, /\bwake time\b/i, /\bcoffee ritual\b/i], weight: 2 },

  // Preferences
  { target: "TELOS/BOOKS.md", patterns: [/\bbook\b/i, /\bfavorite read\b/i, /\bby\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/], weight: 2 },
  { target: "TELOS/AUTHORS.md", patterns: [/\bauthor\b/i, /\bwriter\b/i, /\bnovelist\b/i], weight: 2 },
  { target: "TELOS/MOVIES.md", patterns: [/\bmovie\b/i, /\bfilm\b/i, /\bdirector\b/i, /\bcinema\b/i], weight: 2 },
  { target: "TELOS/BANDS.md", patterns: [/\bband\b/i, /\bartist\b/i, /\balbum\b/i, /\bconcert\b/i, /\bdrummer\b/i], weight: 2 },
  { target: "TELOS/RESTAURANTS.md", patterns: [/\brestaurant\b/i, /\bdiner\b/i, /\beatery\b/i, /\bPapaya Thai\b/i], weight: 2 },
  { target: "TELOS/FOOD_PREFERENCES.md", patterns: [/\bcuisine\b/i, /\bspice\b/i, /\b(love|hate|avoid) (eating|food)\b/i, /\bdietary\b/i], weight: 2 },
  { target: "TELOS/LEARNING.md", patterns: [/\blearn\b/i, /\blesson\b/i, /\bclass\b/i, /\bstudy\b/i, /\bcourse\b/i], weight: 2 },
  { target: "TELOS/MEETUPS.md", patterns: [/\bmeetup\b/i, /\bconference\b/i, /\bevent\b/i], weight: 2 },
  { target: "TELOS/CIVIC.md", patterns: [/\bpermit\b/i, /\bcity council\b/i, /\bzoning\b/i, /\bNewark\b/i], weight: 2 },

  // Identity
  { target: "USER/PRINCIPAL_IDENTITY.md", patterns: [/\bI am\b/i, /\bmy role\b/i, /\bmy background\b/i, /\bI work as\b/i, /\bexperience\b/i], weight: 1 },

  // Knowledge
  { target: "MEMORY/KNOWLEDGE/Ideas", patterns: [/\bidea:\b/i, /\bthesis\b/i, /\bhypothesis\b/i, /\btheory\b/i], weight: 2 },
  { target: "MEMORY/KNOWLEDGE/People", patterns: [/\b(met|know|friends with)\s+[A-Z][a-z]+\s+[A-Z][a-z]+/], weight: 1 },
  { target: "MEMORY/KNOWLEDGE/Companies", patterns: [/\b(company|startup|corporation)\b/i], weight: 1 },
  { target: "MEMORY/KNOWLEDGE/Research", patterns: [/\bresearch\b/i, /\bstudy shows\b/i, /\baccording to\b/i], weight: 1 },

  // Feedback (AI collaboration preferences)
  { target: "memory/feedback", patterns: [/\b(always|never|do not) (do|use|include)\b/i, /\bwhen (you|{{DA_NAME}})\b/i, /\bKai should\b/i, /\bfrom now on\b/i, /\brule:\b/i], weight: 3 },
];

// The std/core scoring loop ships only match→accumulate→rank→margin→confidence; the caller supplies
// the label vocabulary. Map our `target` key onto the generic `label`.
const SCORE_RULES: ScoreRule[] = RULES.map((r) => ({ label: r.target, patterns: r.patterns, weight: r.weight }));

// ─── Chunking (markdown-kit chunkContent, re-labelled with the source basename) ───

export function chunkSource(file: string, content: string): Array<{ section: string; body: string }> {
  // chunkContent(content) → {heading, body}[] (H2/H3 split, preamble, >30-char paragraph fallback,
  // `p{n}` labels). We re-derive the original `${basename(file)}:${heading}` section label at the edge.
  return chunkContent(content).map((c) => ({ section: `${basename(file)}:${c.heading}`, body: c.body }));
}

// ─── Classification (core.scoreRules; confidence consumed VERBATIM) ───

export function classify(body: string): { target: Target; confidence: number; reasons: string[]; alternatives: Target[] } {
  const { ranked, top, confidence } = scoreRules(body, SCORE_RULES);
  if (!top) {
    return { target: "UNCLEAR" as Target, confidence: 0, reasons: ["no patterns matched"], alternatives: [] };
  }
  return {
    target: top.label as Target,
    confidence,
    reasons: ranked[0]!.matched.slice(0, 3),
    alternatives: ranked.slice(1, 4).map((r) => r.label as Target),
  };
}

// ─── Source collection ───

class SourceError extends Error {}

export function collectSources(sourcePath: string, stdin: boolean): Array<{ file: string; content: string }> {
  if (stdin) {
    return [{ file: "<stdin>", content: readFileSync(0, "utf-8") }]; // fd 0 = stdin
  }
  if (!existsSync(sourcePath)) {
    throw new SourceError(`Source does not exist: ${sourcePath}`);
  }
  const stat = statSync(sourcePath);
  if (stat.isFile()) {
    return [{ file: sourcePath, content: readFileSync(sourcePath, "utf-8") }];
  }
  // Directory — scan .md / .txt / .markdown recursively (sorted for deterministic queue order).
  const files = walkFiles(sourcePath, (p) => /\.(md|txt|markdown)$/i.test(p)).sort();
  return files.map((f) => ({ file: f, content: readFileSync(f, "utf-8") }));
}

// ─── Proposal building ───

export function buildProposals(
  sources: Array<{ file: string; content: string }>,
  now: Date,
): Proposal[] {
  const proposals: Proposal[] = [];
  for (const { file, content } of sources) {
    for (const { section, body } of chunkSource(file, content)) {
      if (body.length < 40) continue; // skip trivial
      const { target, confidence, reasons, alternatives } = classify(body);
      proposals.push({
        id: randomUUID(),
        timestamp: now.toISOString(),
        source_file: file,
        source_section: section,
        content_preview: collapse(truncate(body, 160)), // std text kit: ~160-char, whitespace-collapsed preview
        content_full: body,
        proposed_target: target,
        classification_confidence: confidence,
        classification_reasons: reasons,
        alternatives,
        status: "pending",
      });
    }
  }
  return proposals;
}

// ─── Main ───

export function main(argv: string[] = process.argv.slice(2), opts?: { queueFile?: string; now?: Date }): number {
  const queueFile = opts?.queueFile ?? defaultQueueFile();
  const now = opts?.now ?? new Date();

  const useStdin = hasFlag(argv, "stdin");
  const jsonOut = hasFlag(argv, "json");
  const dryRun = hasFlag(argv, "dry-run");
  const sourceVal = flagValue(argv, "source");

  if (!useStdin && sourceVal === undefined) {
    console.error("Required: --source <path> OR --stdin");
    console.error("Optional: --json (JSON output)  --dry-run (don't write queue)");
    return 1;
  }

  let sources: Array<{ file: string; content: string }>;
  try {
    sources = collectSources(useStdin ? "" : (sourceVal ?? ""), useStdin);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  const proposals = buildProposals(sources, now);

  // Summary
  const byTarget: Record<string, number> = {};
  for (const p of proposals) byTarget[p.proposed_target] = (byTarget[p.proposed_target] || 0) + 1;

  const avgConfidence = proposals.length
    ? proposals.reduce((s, p) => s + p.classification_confidence, 0) / proposals.length
    : 0;

  if (!dryRun && proposals.length) {
    // Functional queue append (NOT report.appendAudit): one JSON object per line, must not lose/roll
    // records. fsx has no append helper, so this is a plain node:fs appendFileSync at the proof edge.
    ensureDir(dirname(queueFile));
    for (const p of proposals) appendFileSync(queueFile, JSON.stringify(p) + "\n");
  }

  if (jsonOut) {
    // --json envelope keys FROZEN: { proposals, by_target, avg_confidence }
    emitJson({ proposals, by_target: byTarget, avg_confidence: avgConfidence });
    return 0;
  }

  console.log(`═══ Migration Scan Results ═══\n`);
  console.log(`Sources scanned:    ${sources.length}`);
  console.log(`Chunks extracted:   ${proposals.length}`);
  console.log(`Avg confidence:     ${Math.round(avgConfidence * 100)}%`);
  console.log(`Queue file:         ${dryRun ? "(dry-run — not written)" : queueFile}`);
  console.log(``);
  console.log(`Proposed routing:`);
  for (const [target, n] of Object.entries(byTarget).sort((a, b) => b[1] - a[1])) {
    const icon = target === "UNCLEAR" ? "❓" : target.startsWith("memory/feedback") ? "🧠" : "📂";
    console.log(`  ${icon}  ${target.padEnd(38)}  ${n} chunks`);
  }
  console.log(``);
  const unclear = proposals.filter((p) => p.proposed_target === "UNCLEAR");
  if (unclear.length) {
    console.log(`⚠️  ${unclear.length} chunks unclear — will need {{PRINCIPAL_NAME}}'s routing decision.`);
  }
  const lowConf = proposals.filter((p) => p.classification_confidence < 0.4 && p.proposed_target !== "UNCLEAR");
  if (lowConf.length) {
    console.log(`⚠️  ${lowConf.length} chunks classified at <40% confidence — review recommended.`);
  }
  console.log(``);
  console.log(`Next: bun ~/.claude/PAI/TOOLS/MigrateApprove.ts --review`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
