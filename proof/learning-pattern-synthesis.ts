#!/usr/bin/env bun
/**
 * LearningPatternSynthesis — Story 12.4 rewrite onto the std substrate (proof/ consumer; live cutover
 * to ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). Behavior preserved; re-rolled fs/arg/date/
 * scoring plumbing now imports tested std primitives instead of inlining them.
 *
 * Aggregates LEARNING/SIGNALS/ratings.jsonl into recurring frustration/success patterns and writes a
 * synthesis markdown report.
 *
 * Commands:
 *   --week         Analyze last 7 days (default)
 *   --month        Analyze last 30 days
 *   --all          Analyze all ratings
 *   --dry-run      Show analysis without writing
 *
 * Kept caller-local (D4): the ~/.claude/MEMORY paths, the frustration/success regex rule tables, the
 * `<=4` / `>=7` rating thresholds, the recommendation map, the avgRating/avgConfidence math, and the
 * report vocabulary. core/report/fsx ship only the loops — never this consumer's identity.
 */

import { basename, join } from "node:path";
import {
  daysSince,
  dateParts,
  dispatch,
  hasFlag,
  isoDate,
  parseNdjson,
  scoreRules,
  type ScoreRule,
} from "std/core";
import { ensureDir, atomicWrite, readIfExists, resolveFrameworkDir } from "std/fsx";
import { lines } from "std/report";

// ============================================================================
// Types
// ============================================================================

export interface Rating {
  timestamp: string;
  rating: number;
  session_id: string;
  source: "explicit" | "implicit";
  sentiment_summary: string;
  confidence: number;
  comment?: string;
}

export interface PatternGroup {
  pattern: string;
  count: number;
  avgRating: number;
  avgConfidence: number;
  examples: string[];
}

export interface SynthesisResult {
  period: string;
  totalRatings: number;
  avgRating: number;
  frustrations: PatternGroup[];
  successes: PatternGroup[];
  topIssues: string[];
  recommendations: string[];
}

// ============================================================================
// Caller-local vocabulary (D4) — the rule tables, thresholds, recommendation map
// ============================================================================

/** Frustration keyword tables, ported to `ScoreRule[]` (one pattern per label, weight 1 = presence). */
export const FRUSTRATION_RULES: ScoreRule[] = [
  { label: "Time/Performance Issues", patterns: [/time|slow|delay|hang|wait|long|minutes|hours/i], weight: 1 },
  { label: "Incomplete Work", patterns: [/incomplete|missing|partial|didn't finish|not done/i], weight: 1 },
  { label: "Wrong Approach", patterns: [/wrong|incorrect|not what|misunderstand|mistake/i], weight: 1 },
  { label: "Over-engineering", patterns: [/over-?engineer|too complex|unnecessary|bloat/i], weight: 1 },
  { label: "Tool/System Failures", patterns: [/fail|error|broken|crash|bug|issue/i], weight: 1 },
  { label: "Communication Problems", patterns: [/unclear|confus|didn't ask|should have asked/i], weight: 1 },
  { label: "Repetitive Issues", patterns: [/again|repeat|still|same problem/i], weight: 1 },
];

export const SUCCESS_RULES: ScoreRule[] = [
  { label: "Quick Resolution", patterns: [/quick|fast|efficient|smooth/i], weight: 1 },
  { label: "Good Understanding", patterns: [/understood|clear|exactly|perfect/i], weight: 1 },
  { label: "Proactive Help", patterns: [/proactive|anticipat|helpful|above and beyond/i], weight: 1 },
  { label: "Clean Implementation", patterns: [/clean|simple|elegant|well done/i], weight: 1 },
];

const HELP_TEXT = `
LearningPatternSynthesis - Aggregate ratings into actionable patterns

Usage:
  bun run LearningPatternSynthesis.ts --week      Analyze last 7 days (default)
  bun run LearningPatternSynthesis.ts --month     Analyze last 30 days
  bun run LearningPatternSynthesis.ts --all       Analyze all ratings
  bun run LearningPatternSynthesis.ts --dry-run   Preview without writing

Output: Creates synthesis report in MEMORY/LEARNING/SYNTHESIS/YYYY-MM/
`;

// ============================================================================
// Pattern Detection — now on core.scoreRules (boolean/presence mode)
// ============================================================================

/**
 * Bucket summaries by the labels they match. Each `ScoreRule` carries one pattern at weight 1, so
 * `scoreRules(summary, rules).ranked` is exactly the set of labels whose pattern hit — reproducing the
 * original per-summary presence detection (a summary can land in several buckets). Ranked order is
 * score-desc and, with every score == 1, stable — so labels appear in rule-table order, matching the
 * original `Object.entries` iteration and Map insertion order.
 */
export function detectPatterns(summaries: string[], rules: ScoreRule[]): Map<string, string[]> {
  const results = new Map<string, string[]>();

  for (const summary of summaries) {
    const { ranked } = scoreRules(summary, rules);
    for (const { label } of ranked) {
      if (!results.has(label)) {
        results.set(label, []);
      }
      results.get(label)!.push(summary);
    }
  }

  return results;
}

export function groupToPatternGroups(grouped: Map<string, string[]>, ratings: Rating[]): PatternGroup[] {
  const groups: PatternGroup[] = [];

  for (const [pattern, examples] of grouped.entries()) {
    const matchingRatings = ratings.filter((r) => examples.some((e) => e === r.sentiment_summary));

    const avgRating =
      matchingRatings.length > 0
        ? matchingRatings.reduce((sum, r) => sum + r.rating, 0) / matchingRatings.length
        : 5;

    const avgConfidence =
      matchingRatings.length > 0
        ? matchingRatings.reduce((sum, r) => sum + r.confidence, 0) / matchingRatings.length
        : 0.5;

    groups.push({
      pattern,
      count: examples.length,
      avgRating,
      avgConfidence,
      examples: examples.slice(0, 3),
    });
  }

  return groups.sort((a, b) => b.count - a.count);
}

// ============================================================================
// Analysis
// ============================================================================

export function analyzeRatings(
  ratings: Rating[],
  period: string,
  frustrationRules: ScoreRule[] = FRUSTRATION_RULES,
  successRules: ScoreRule[] = SUCCESS_RULES,
): SynthesisResult {
  if (ratings.length === 0) {
    return {
      period,
      totalRatings: 0,
      avgRating: 0,
      frustrations: [],
      successes: [],
      topIssues: [],
      recommendations: [],
    };
  }

  const avgRating = ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length;

  // Separate frustrations (rating <= 4) and successes (rating >= 7)
  const frustrationRatings = ratings.filter((r) => r.rating <= 4);
  const successRatings = ratings.filter((r) => r.rating >= 7);

  const frustrationSummaries = frustrationRatings.map((r) => r.sentiment_summary);
  const successSummaries = successRatings.map((r) => r.sentiment_summary);

  const frustrationGroups = detectPatterns(frustrationSummaries, frustrationRules);
  const successGroups = detectPatterns(successSummaries, successRules);

  const frustrations = groupToPatternGroups(frustrationGroups, frustrationRatings);
  const successes = groupToPatternGroups(successGroups, successRatings);

  const topIssues = frustrations
    .slice(0, 3)
    .map((f) => `${f.pattern} (${f.count} occurrences, avg rating ${f.avgRating.toFixed(1)})`);

  const recommendations: string[] = [];

  if (frustrations.some((f) => f.pattern === "Time/Performance Issues")) {
    recommendations.push("Consider setting clearer time expectations and progress updates");
  }
  if (frustrations.some((f) => f.pattern === "Wrong Approach")) {
    recommendations.push("Ask clarifying questions before starting complex tasks");
  }
  if (frustrations.some((f) => f.pattern === "Over-engineering")) {
    recommendations.push("Default to simpler solutions; only add complexity when justified");
  }
  if (frustrations.some((f) => f.pattern === "Communication Problems")) {
    recommendations.push("Summarize understanding before implementation");
  }

  if (recommendations.length === 0) {
    recommendations.push("Continue current patterns - no major issues detected");
  }

  return {
    period,
    totalRatings: ratings.length,
    avgRating,
    frustrations,
    successes,
    topIssues,
    recommendations,
  };
}

// ============================================================================
// Report — now on report.lines() (byte-identical layout to the original template)
// ============================================================================

export function formatSynthesisReport(result: SynthesisResult, now: Date): string {
  const date = isoDate(now);
  const { p, toString } = lines();

  p("# Learning Pattern Synthesis");
  p("");
  p(`**Period:** ${result.period}`);
  p(`**Generated:** ${date}`);
  p(`**Total Ratings:** ${result.totalRatings}`);
  p(`**Average Rating:** ${result.avgRating.toFixed(1)}/10`);
  p("");
  p("---");
  p("");
  p("## Top Issues");
  p("");
  if (result.topIssues.length > 0) {
    result.topIssues.forEach((issue, i) => p(`${i + 1}. ${issue}`));
  } else {
    p("No significant issues detected");
  }
  p("");
  p("## Frustration Patterns");
  p("");
  if (result.frustrations.length === 0) {
    p("*No frustration patterns detected*");
    p("");
  } else {
    for (const f of result.frustrations) {
      p(`### ${f.pattern}`);
      p("");
      p(`- **Occurrences:** ${f.count}`);
      p(`- **Avg Rating:** ${f.avgRating.toFixed(1)}`);
      p(`- **Confidence:** ${(f.avgConfidence * 100).toFixed(0)}%`);
      p("- **Examples:**");
      for (const e of f.examples) p(`  - "${e}"`);
      p("");
    }
  }
  p("## Success Patterns");
  p("");
  if (result.successes.length === 0) {
    p("*No success patterns detected*");
    p("");
  } else {
    for (const s of result.successes) {
      p(`### ${s.pattern}`);
      p("");
      p(`- **Occurrences:** ${s.count}`);
      p(`- **Avg Rating:** ${s.avgRating.toFixed(1)}`);
      p("- **Examples:**");
      for (const e of s.examples) p(`  - "${e}"`);
      p("");
    }
  }
  p("## Recommendations");
  p("");
  // The origin joins recommendations unconditionally (no empty-guard), so an empty list still emits a
  // blank line here — reproduce that by pushing the join-split rather than a per-item forEach.
  for (const line of result.recommendations.map((r, i) => `${i + 1}. ${r}`).join("\n").split("\n")) {
    p(line);
  }
  p("");
  p("---");
  p("");
  p("*Generated by LearningPatternSynthesis tool*");
  p("");

  return toString();
}

export function writeSynthesis(
  result: SynthesisResult,
  period: string,
  synthesisDir: string,
  now: Date,
  tz: string,
): string {
  // month-dir is the origin's LOCAL year-month (getFullYear/getMonth); `tz` is injected at the edge
  // (the host tz for the live tool, a fixed tz for tests) so dateParts stays pure/deterministic.
  const monthDir = join(synthesisDir, dateParts(now, tz).iso.slice(0, 7));
  ensureDir(monthDir);

  const dateStr = isoDate(now);
  const filename = `${dateStr}_${period.toLowerCase().replace(/\s+/g, "-")}-patterns.md`;
  const filepath = join(monthDir, filename);

  atomicWrite(filepath, formatSynthesisReport(result, now));

  return filepath;
}

/** Load + parse ratings.jsonl (malformed lines skipped, per the origin's try/catch → null → filter). */
export function loadRatings(path: string): Rating[] {
  return parseNdjson<Rating>(readIfExists(path) ?? "");
}

// ============================================================================
// CLI
// ============================================================================

export interface Deps {
  ratingsFile: string;
  synthesisDir: string;
  now: Date;
  tz: string;
  frustrationRules: ScoreRule[];
  successRules: ScoreRule[];
  log: (msg: string) => void;
}

function defaultDeps(): Deps {
  const frameworkDir = process.env.LIFEOS_DIR || process.env.PAI_DIR || resolveFrameworkDir(process.env.HOME ?? "");
  const learningDir = join(frameworkDir, "MEMORY", "LEARNING");
  return {
    ratingsFile: join(learningDir, "SIGNALS", "ratings.jsonl"),
    synthesisDir: join(learningDir, "SYNTHESIS"),
    now: new Date(),
    // Edge reads the ambient host tz (the origin used LOCAL getFullYear/getMonth for the month-dir).
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    frustrationRules: FRUSTRATION_RULES,
    successRules: SUCCESS_RULES,
    log: (msg) => console.log(msg),
  };
}

function runPeriod(period: string, windowDays: number, dryRun: boolean, deps: Deps): number {
  const raw = readIfExists(deps.ratingsFile);
  if (raw === null) {
    deps.log(`No ratings file found at: ${deps.ratingsFile}`);
    return 0;
  }

  const allRatings = parseNdjson<Rating>(raw);
  deps.log(`📊 Loaded ${allRatings.length} total ratings`);

  // window filter: floor(day delta) <= N. Invalid timestamps → NaN <= N → excluded (matches the
  // origin's `new Date(bad) >= cutoff` → false). `--all` uses Infinity: every valid rating passes,
  // invalid ones drop — exactly the origin's `>= new Date(0)`.
  const filtered = allRatings.filter((r) => daysSince(r.timestamp, deps.now) <= windowDays);
  deps.log(`🔍 Analyzing ${filtered.length} ratings for ${period.toLowerCase()} period`);

  if (filtered.length === 0) {
    deps.log("✅ No ratings in this period");
    return 0;
  }

  const result = analyzeRatings(filtered, period, deps.frustrationRules, deps.successRules);

  deps.log(`\n📈 Analysis Results:`);
  deps.log(`   Average Rating: ${result.avgRating.toFixed(1)}/10`);
  deps.log(`   Frustration Patterns: ${result.frustrations.length}`);
  deps.log(`   Success Patterns: ${result.successes.length}`);

  if (result.topIssues.length > 0) {
    deps.log(`\n⚠️  Top Issues:`);
    for (const issue of result.topIssues) {
      deps.log(`   - ${issue}`);
    }
  }

  if (dryRun) {
    deps.log("\n🔍 DRY RUN - Would write synthesis report");
    deps.log("\nRecommendations:");
    for (const rec of result.recommendations) {
      deps.log(`   - ${rec}`);
    }
  } else {
    const filepath = writeSynthesis(result, period, deps.synthesisDir, deps.now, deps.tz);
    deps.log(`\n✅ Created synthesis report: ${basename(filepath)}`);
  }

  return 0;
}

export function main(argv: string[] = process.argv.slice(2), deps: Deps = defaultDeps()): number {
  if (hasFlag(argv, "help") || hasFlag(argv, "h")) {
    deps.log(HELP_TEXT);
    return 0;
  }

  const dryRun = hasFlag(argv, "dry-run");
  const cmd = hasFlag(argv, "month") ? "month" : hasFlag(argv, "all") ? "all" : "week";

  const runWeek = () => runPeriod("Weekly", 7, dryRun, deps);
  const runMonth = () => runPeriod("Monthly", 30, dryRun, deps);
  const runAll = () => runPeriod("All Time", Number.POSITIVE_INFINITY, dryRun, deps);

  return dispatch(cmd, { week: runWeek, month: runMonth, all: runAll }, runWeek);
}

if (import.meta.main) {
  process.exit(main());
}
