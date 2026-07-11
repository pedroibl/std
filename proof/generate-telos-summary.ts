#!/usr/bin/env bun
/**
 * generate-telos-summary.ts — Story 12.4 rewrite of `~/.claude/PAI/TOOLS/GenerateTelosSummary.ts`
 * onto the std substrate (proof/ consumer; live cutover to ~/.claude/PAI/TOOLS staged for Pedro
 * under AD-9.2). Reads the TELOS source `.md` files and regenerates the compressed ~60-line
 * PRINCIPAL_TELOS.md boot-context summary. Behavior + output bytes preserved exactly.
 *
 * Substrate adopted (re-rolled plumbing → tested std primitives):
 *   - fs read/write  → `fsx.readIfExists` (was existsSync+readFileSync) · `fsx.atomicWrite`
 *                      (was writeFileSync — same bytes, now tmp+rename atomic).
 *   - the two fixed-width `s.substring(0,57)+"..."` truncations (parseProblems / parseStrategies)
 *     → `core.truncate(s, 60)` — byte-identical (char-boundary, ellipsis counts toward the limit).
 *
 * Kept caller-local (D4 — identity + domain parse; single-caller, injected for hermetic tests):
 *   - TELOS_DIR / OUTPUT_PATH (`~/.claude/PAI/USER/TELOS`), the `{{PRINCIPAL_FULL_NAME}}` token,
 *     the boot-context section order + headings, the "Context Filter" epilogue string.
 *   - `parseItems` list parser + every per-file domain parse (MISSION/GOALS/PROBLEMS/STRATEGIES/
 *     NARRATIVES/CHALLENGES/WRONG/TRAUMAS/MODELS regexes, the G9+/[0,1] active split, the deferred
 *     compression, the P#/S# `##`-header scans with parenthetical-strip).
 *   - `truncateWord` — the ORIGINAL *word-boundary* truncate (:32-36). It is a different algorithm
 *     from `core.truncate` (char-boundary): e.g. `truncateWord("abcdefghij klmnop…", 20)` → "abcdefghij..."
 *     while `core.truncate(…, 20)` → "abcdefghij klmnop...". No width mapping makes them equal, so
 *     replacing it would change the generated file's bytes — it MUST stay local (see report / substrate gap).
 *   - The generation timestamp is `now.toISOString()` (full ISO 8601 w/ ms + Z), NOT `isoDate(now)`
 *     (date-only) — the file's staleness-detection line needs the full timestamp; `isoDate` would
 *     truncate it and change the output. `now` is injected so tests pin the clock.
 */

import { join } from "node:path";
import { truncate } from "std/core";
import { atomicWrite, readIfExists } from "std/fsx";

interface ParsedItem {
  id: string;
  text: string;
}

/**
 * Truncate text at WORD boundary, adding ellipsis if needed. Original inline helper (:32-36) —
 * distinct from `core.truncate` (char-boundary); kept local to preserve output bytes (D4).
 */
function truncateWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.substring(0, max).replace(/\s+\S*$/, "");
  return cut + "...";
}

function readTelosFile(telosDir: string, filename: string): string {
  return readIfExists(join(telosDir, filename)) ?? "";
}

/** Parse items in format "- **ID**: text" or "- ID: text". */
function parseItems(content: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    // Match "- **M0**: text" or "- M0: text" or "- **G0**: text" patterns
    const match = line.match(/^-\s+\*?\*?(\w+)\*?\*?:\s*(.+)/);
    if (match) {
      items.push({ id: match[1], text: match[2].trim() });
    }
  }
  return items;
}

/** Parse mission items from MISSION.md. */
function parseMissions(telosDir: string): string[] {
  const content = readTelosFile(telosDir, "MISSION.md");
  const items = parseItems(content);
  return items.map((i) => `- **${i.id}**: ${truncateWord(i.text, 75)}`);
}

/** Parse goals from GOALS.md, separating 2026 goals from older ones. */
function parseGoals(telosDir: string): { active: string[]; deferred: string[] } {
  const content = readTelosFile(telosDir, "GOALS.md");
  const items = parseItems(content);

  // Goals with IDs G9+ are 2026 goals based on the file structure
  const active: string[] = [];
  const deferred: string[] = [];

  for (const item of items) {
    const num = parseInt(item.id.replace(/\D/g, ""), 10);
    // Split on " — " (em-dash with spaces) or sentence-ending period (not in URLs)
    const firstSentence = item.text.split(/\s—\s|(?<!\w\.\w)(?<=\w)\.\s/)[0].trim();

    if (num >= 9 || [0, 1].includes(num)) {
      active.push(`- **${item.id}**: ${truncateWord(firstSentence, 70)}`);
    } else {
      deferred.push(`- **${item.id}**: ${truncateWord(firstSentence, 50)}`);
    }
  }

  return { active, deferred };
}

/** Parse problems from PROBLEMS.md (uses ## headers, not list items). */
function parseProblems(telosDir: string): string[] {
  const content = readTelosFile(telosDir, "PROBLEMS.md");
  const lines: string[] = [];

  // Format: ## P0: Title (optional parenthetical)
  const headers = [...content.matchAll(/^##\s+(P\d+):\s*(.+?)(?:\s*\(.*\))?\s*$/gm)];
  for (const match of headers) {
    const title = match[2].trim();
    // `title.length > 60 ? title.substring(0,57)+"..." : title` ≡ core.truncate(title, 60) (char-boundary).
    const short = truncate(title, 60);
    lines.push(`- **${match[1]}**: ${short}`);
  }

  // Fallback: try list items
  if (lines.length === 0) {
    const items = parseItems(content);
    for (const item of items) {
      const title = item.text.split(/[—-]/)[0].trim().replace(/\*\*/g, "");
      lines.push(`- **${item.id}**: ${title}`);
    }
  }

  return lines;
}

/** Parse strategies from STRATEGIES.md. */
function parseStrategies(telosDir: string): string[] {
  const content = readTelosFile(telosDir, "STRATEGIES.md");
  const lines: string[] = [];

  // Extract strategy headers: ## S0: name or ### S1: name
  const headers = [...content.matchAll(/^#{2,3}\s+(S\d+):\s*(.+?)(?:\s*\(.*\))?\s*$/gm)];
  for (const match of headers) {
    // `match[2].length > 60 ? match[2].substring(0,57)+"..." : match[2]` ≡ core.truncate(match[2], 60).
    const short = truncate(match[2], 60);
    lines.push(`- **${match[1]}**: ${short}`);
  }

  return lines;
}

/** Parse narratives from NARRATIVES.md. */
function parseNarratives(telosDir: string): { primary: string[]; secondary: string[] } {
  const content = readTelosFile(telosDir, "NARRATIVES.md");
  const items = parseItems(content);

  const primary: string[] = [];
  const secondary: string[] = [];

  for (const item of items) {
    const num = parseInt(item.id.replace(/\D/g, ""), 10);

    if ([0, 1, 7].includes(num)) {
      primary.push(`- **${item.id}**: ${truncateWord(item.text, 75)}`);
    } else {
      secondary.push(`${item.id}: ${truncateWord(item.text, 60)}`);
    }
  }

  return { primary, secondary };
}

/** Parse challenges from CHALLENGES.md (all items — truncation was hiding real scope). */
function parseChallenges(telosDir: string): string[] {
  const content = readTelosFile(telosDir, "CHALLENGES.md");
  const items = parseItems(content);
  return items.map((i) => `- **${i.id}**: ${truncateWord(i.text, 90)}`);
}

/** Parse WRONG.md — plain bullets without IDs. Each bullet is a past mistake. */
function parseWrong(telosDir: string): string[] {
  const content = readTelosFile(telosDir, "WRONG.md");
  const lines = content.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^-\s+(.+)$/);
    if (m) out.push(`- ${truncateWord(m[1].trim(), 110)}`);
  }
  return out;
}

/** Parse TRAUMAS.md — formative experiences with TR0/TR1/TR2 IDs. */
function parseTraumas(telosDir: string): string[] {
  const content = readTelosFile(telosDir, "TRAUMAS.md");
  const items = parseItems(content);
  return items.map((i) => `- **${i.id}**: ${truncateWord(i.text, 90)}`);
}

/** Parse models from MODELS.md (first sentence only). */
function parseModels(telosDir: string): string[] {
  const content = readTelosFile(telosDir, "MODELS.md");
  const items = parseItems(content);
  return items.slice(0, 3).map((i) => {
    const first = i.text.split(/\.\s/)[0].trim();
    return `- ${truncateWord(first, 65)}`;
  });
}

/** Assemble the compressed boot-context summary. `now` injected (staleness timestamp; hermetic tests). */
export function generate(telosDir: string, now: Date): string {
  const nowIso = now.toISOString();
  const missions = parseMissions(telosDir);
  const goals = parseGoals(telosDir);
  const problems = parseProblems(telosDir);
  const strategies = parseStrategies(telosDir);
  const narratives = parseNarratives(telosDir);
  const challenges = parseChallenges(telosDir);
  const wrong = parseWrong(telosDir);
  const traumas = parseTraumas(telosDir);
  const models = parseModels(telosDir);

  const lines: string[] = [
    "# Principal TELOS — {{PRINCIPAL_FULL_NAME}}",
    "",
    "> Auto-generated from TELOS source files. Do not edit manually.",
    `> Generated: ${nowIso} | Sources: MISSION, GOALS, PROBLEMS, STRATEGIES, NARRATIVES, CHALLENGES, WRONG, TRAUMAS, MODELS`,
    "",
    "## Missions",
    "",
    ...missions,
    "",
    "## Active Goals (2026)",
    "",
    ...goals.active,
  ];

  if (goals.deferred.length > 0) {
    // Compress deferred goals to a single inline line — they're not active and don't need full bullets
    const deferredIds = goals.deferred
      .map((line) => line.match(/\*\*(\w+)\*\*/)?.[1])
      .filter(Boolean)
      .join(", ");
    lines.push("", `_Deferred (full text in TELOS/GOALS.md): ${deferredIds}_`);
  }

  lines.push(
    "",
    "## Problems Being Solved",
    "",
    ...problems,
    "",
    "## Strategies",
    "",
    ...strategies,
    "",
    "## Active Narratives",
    "",
    ...narratives.primary,
  );

  if (narratives.secondary.length > 0) {
    lines.push(...narratives.secondary.map((n) => `- ${n}`));
  }

  lines.push("", "## Personal Challenges", "", ...challenges);

  if (traumas.length > 0) {
    lines.push("", "## Formative Experiences (Traumas)", "", ...traumas);
  }

  if (wrong.length > 0) {
    lines.push("", "## Things I've Been Wrong About (Mistakes)", "", ...wrong);
  }

  lines.push(
    "",
    "## Core Models",
    "",
    ...models,
    "",
    "## Context Filter",
    "",
    "When steering work, bias toward: human flourishing, Human 3.0 transition, AI augmentation strategies, becoming one's full self, correct framing.",
  );

  return lines.join("\n") + "\n";
}

/** Default TELOS dir from $HOME (identity edge — D4). */
export function telosDir(home = process.env.HOME || ""): string {
  return join(home, ".claude/PAI/USER/TELOS");
}

export function main(argv: string[] = process.argv.slice(2)): number {
  void argv; // no flags — kept for signature parity with the proof/ tool contract
  const dir = telosDir();
  const outputPath = join(dir, "PRINCIPAL_TELOS.md");
  const summary = generate(dir, new Date());
  atomicWrite(outputPath, summary);
  const lineCount = summary.split("\n").length;
  // STDOUT/STDERR split preserved (the Interview tool parses the stderr status line).
  console.log(`✅ Generated PRINCIPAL_TELOS.md (${lineCount} lines) at ${outputPath}`);
  console.error(`📋 TELOS summary regenerated: ${lineCount} lines from source files`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
