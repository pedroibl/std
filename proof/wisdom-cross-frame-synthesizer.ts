#!/usr/bin/env bun
/**
 * WisdomCrossFrameSynthesizer — Story 12.4 rewrite onto the std substrate (proof/ consumer; live
 * cutover to ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). Behavior preserved byte-for-byte;
 * the re-rolled fs/arg/date/markdown/similarity plumbing now imports tested std primitives instead of
 * inlining them.
 *
 * Adopted primitives:
 *   - core.tokenize + core.jaccard  ← computeSimilarity (word-overlap Jaccard)
 *   - core.getMetaField ×3          ← the `**Label:**` meta parse (typed parse stays local)
 *   - core.extractSection ×2        ← the Anti-Patterns / Cross-Frame Connections section slices
 *   - core.isoDate                  ← `new Date().toISOString().split('T')[0]` date stamps
 *   - core.daysSince                ← the `Math.floor((Date.now()-…)/86400000)` age math
 *   - core.hasFlag                  ← the util.parseArgs boolean-flag read
 *   - report.lines                  ← the push-lines-then-join markdown builders
 *   - fsx.walkFiles/exists/ensureDir/atomicWrite ← frame discovery + report writes
 *
 * Kept CALLER-LOCAL (D4): the ~/.claude / MEMORY/WISDOM paths, the STOPWORDS list, the meta labels
 * ("Confidence" / "Observation Count" / "Last Crystallized"), the `[CRYSTAL` principle marker, the
 * `## Anti-Patterns` / `## Cross-Frame Connections` anchors, the 0.3 similarity cutoff, the health
 * thresholds (7d/30d, obs>10), the report table shapes, and the tool's byline.
 *
 * Faithful-port deltas (documented, not accidental):
 *   1. computeSimilarity tokenization: std `tokenize` keeps hyphenated words whole (`self-aware` → one
 *      token) whereas the origin's `split(/\W+/)` split on hyphens/underscores. Jaccard math is
 *      identical (|∩|/|∪|); only titles containing `-`/`_` can shift a score. Plain-word titles match.
 *   2. flags: `hasFlag` reads boolean presence and ignores unknown flags, where the origin's
 *      `util.parseArgs({strict})` would throw on an unknown flag. Known flags behave identically.
 *   3. frame discovery: `walkFiles` recurses (origin `readdirSync` was flat). The FRAMES dir is flat
 *      in practice, so for a flat dir the returned order equals the origin's readdir order.
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  daysSince,
  extractSection,
  getMetaField,
  hasFlag,
  isoDate,
  jaccard,
  tokenize,
} from "std/core";
import { atomicWrite, ensureDir, exists, resolveFrameworkDir, walkFiles } from "std/fsx";
import { lines } from "std/report";

// ── Types ──

export interface FrameData {
  domain: string;
  path: string;
  confidence: number;
  observationCount: number;
  lastCrystallized: string;
  principles: string[];
  antiPatterns: string[];
  crossConnections: string[];
}

export interface CrossPrinciple {
  principle: string;
  domains: string[];
  confidence: number;
  evidence: string;
}

export interface FrameHealth {
  domain: string;
  confidence: number;
  observationCount: number;
  lastCrystallized: string;
  principleCount: number;
  antiPatternCount: number;
  crossConnectionCount: number;
  health: "growing" | "stable" | "stale";
}

// ── Frame Parsing ──

export function parseFrame(filepath: string): FrameData {
  const content = readFileSync(filepath, "utf-8");
  const domain = basename(filepath, ".md");

  // Parse meta — the read half is core.getMetaField; the typed parse stays local (D4). The origin
  // captured `(\d+)%` / `(\d+)` / `(\S+)`; getMetaField hands back the trimmed remainder-of-line and we
  // apply the same anchored parse (value is already left-trimmed, so `^` mirrors the origin's `\s*(…)`).
  const rawConf = getMetaField(content, "Confidence");
  const confMatch = rawConf ? rawConf.match(/^(\d+)%/) : null;
  const rawObs = getMetaField(content, "Observation Count");
  const obsMatch = rawObs ? rawObs.match(/^(\d+)/) : null;
  const rawCryst = getMetaField(content, "Last Crystallized");
  const crystToken = rawCryst ? rawCryst.split(/\s+/)[0] : undefined;

  // Extract principle titles (### headings with [CRYSTAL] marker — the marker is caller identity, D4)
  const principles: string[] = [];
  const principleRegex = /### (.+?) \[CRYSTAL/g;
  let match: RegExpExecArray | null;
  while ((match = principleRegex.exec(content)) !== null) {
    principles.push(match[1].trim());
  }

  // Extract anti-pattern titles (### headings inside the ## Anti-Patterns section)
  const antiPatterns: string[] = [];
  const antiBody = extractSection(content, "## Anti-Patterns");
  if (antiBody !== null) {
    const antiRegex = /### (.+)/g;
    while ((match = antiRegex.exec(antiBody)) !== null) {
      antiPatterns.push(match[1].trim());
    }
  }

  // Extract cross-frame connections (**bold** spans inside the ## Cross-Frame Connections section)
  const crossConnections: string[] = [];
  const crossBody = extractSection(content, "## Cross-Frame Connections");
  if (crossBody !== null) {
    const connRegex = /\*\*(.+?)\*\*/g;
    while ((match = connRegex.exec(crossBody)) !== null) {
      crossConnections.push(match[1].trim());
    }
  }

  return {
    domain,
    path: filepath,
    confidence: confMatch ? parseInt(confMatch[1], 10) : 50,
    observationCount: obsMatch ? parseInt(obsMatch[1], 10) : 0,
    lastCrystallized: crystToken || "unknown",
    principles,
    antiPatterns,
    crossConnections,
  };
}

// ── Cross-Frame Analysis ──

/** The origin's stopword list — caller identity (D4), never baked into core.tokenize. */
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would", "shall", "should",
  "may", "might", "must", "can", "could", "of", "in", "to", "for", "with", "on", "at",
  "by", "from", "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "under", "over", "and", "but", "or", "not", "no", "all", "each", "every",
  "both", "few", "more", "most", "other", "some", "such", "than", "too", "very",
]);

/**
 * Simple word-overlap similarity (Jaccard index on significant words). tokenize + jaccard from core;
 * the origin's stopword drop + `len > 2` filter stay caller-local. The origin divided intersection by
 * union — that IS Jaccard — so the number is identical for plain-word titles (see the header delta note
 * on hyphen/underscore tokenization). The `size === 0 → 0` guard is redundant with jaccard (an empty set
 * yields a 0 intersection) but is kept to mirror the origin.
 */
export function computeSimilarity(a: string, b: string): number {
  const keep = (t: string) => t.length > 2 && !STOPWORDS.has(t);
  const wordsA = new Set(tokenize(a).filter(keep));
  const wordsB = new Set(tokenize(b).filter(keep));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  return jaccard([...wordsA].join(" "), [...wordsB].join(" "));
}

/**
 * Find principles that appear semantically similar across 2+ frames.
 * Uses simple keyword overlap for now — can be enhanced with embedding similarity.
 */
export function findCrossPrinciples(frames: FrameData[]): CrossPrinciple[] {
  const crossPrinciples: CrossPrinciple[] = [];
  const seen = new Set<string>();

  // Compare each frame's principles against every other frame
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      const frameA = frames[i];
      const frameB = frames[j];

      for (const principleA of frameA.principles) {
        for (const principleB of frameB.principles) {
          const similarity = computeSimilarity(principleA, principleB);
          const key = [principleA, principleB].sort().join("||");

          if (similarity > 0.3 && !seen.has(key)) {
            seen.add(key);
            crossPrinciples.push({
              principle: `${principleA} / ${principleB}`,
              domains: [frameA.domain, frameB.domain],
              confidence: Math.min(frameA.confidence, frameB.confidence),
              evidence: `Shared principle across ${frameA.domain} and ${frameB.domain}`,
            });
          }
        }
      }
    }
  }

  // Also check explicit cross-frame connections
  for (const frame of frames) {
    for (const conn of frame.crossConnections) {
      const targetDomain = conn.replace(".md", "").replace(":", "");
      const existing = crossPrinciples.find(
        (cp) => cp.domains.includes(frame.domain) && cp.domains.includes(targetDomain),
      );
      if (!existing) {
        crossPrinciples.push({
          principle: `Explicit connection: ${frame.domain} ↔ ${targetDomain}`,
          domains: [frame.domain, targetDomain],
          confidence: frame.confidence,
          evidence: `Declared in ${frame.domain} frame cross-connections`,
        });
      }
    }
  }

  return crossPrinciples.sort((a, b) => b.confidence - a.confidence);
}

// ── Frame Health Assessment ──

export function assessHealth(frame: FrameData, now: Date): FrameHealth {
  const daysSinceCrystallized =
    frame.lastCrystallized !== "unknown" ? daysSince(frame.lastCrystallized, now) : 999;

  let health: "growing" | "stable" | "stale";
  if (daysSinceCrystallized <= 7 && frame.observationCount > 10) {
    health = "growing";
  } else if (daysSinceCrystallized <= 30) {
    health = "stable";
  } else {
    health = "stale";
  }

  return {
    domain: frame.domain,
    confidence: frame.confidence,
    observationCount: frame.observationCount,
    lastCrystallized: frame.lastCrystallized,
    principleCount: frame.principles.length,
    antiPatternCount: frame.antiPatterns.length,
    crossConnectionCount: frame.crossConnections.length,
    health,
  };
}

// ── Output Generation ──

export function generatePrinciplesReport(
  crossPrinciples: CrossPrinciple[],
  frames: FrameData[],
  now: Date,
): string {
  const date = isoDate(now);

  // The two variable blocks are the origin's interpolation expressions verbatim; pushing each as a
  // single (multi-line) line surrounded by blank `p("")` lines reproduces the template's `\n\n${…}\n\n`
  // framing byte-for-byte (join("\n") is the exact inverse of the template's newline layout).
  const body =
    crossPrinciples.length === 0
      ? "*No cross-domain principles found yet. Frames need more observations.*"
      : crossPrinciples
          .map(
            (cp, i) =>
              `### ${i + 1}. ${cp.principle}\n\n- **Domains:** ${cp.domains.join(", ")}\n- **Confidence:** ${cp.confidence}%\n- **Evidence:** ${cp.evidence}\n`,
          )
          .join("\n");
  const table = frames
    .map(
      (f) =>
        `| ${f.domain} | ${f.confidence}% | ${f.observationCount}+ | ${f.principles.length} | ${f.antiPatterns.length} |`,
    )
    .join("\n");

  const { p, toString } = lines();
  p("# Verified Cross-Domain Principles");
  p("");
  p(`**Generated:** ${date}`);
  p(`**Frames Analyzed:** ${frames.length}`);
  p(`**Cross-Domain Principles Found:** ${crossPrinciples.length}`);
  p("");
  p("---");
  p("");
  p("## Principles Confirmed Across Multiple Domains");
  p("");
  p(body);
  p("");
  p("---");
  p("");
  p("## Frame Coverage");
  p("");
  p("| Domain | Confidence | Observations | Principles | Anti-Patterns |");
  p("|--------|-----------|-------------|------------|---------------|");
  p(table);
  p("");
  p("---");
  p("");
  p("*Generated by WisdomCrossFrameSynthesizer*");
  p("");
  return toString();
}

export function generateHealthReport(healthData: FrameHealth[], now: Date): string {
  const date = isoDate(now);

  const rows = healthData
    .map((h) => {
      const icon = h.health === "growing" ? "🟢" : h.health === "stable" ? "🟡" : "🔴";
      return `| ${h.domain} | ${icon} ${h.health} | ${h.confidence}% | ${h.observationCount}+ | ${h.lastCrystallized} | ${h.principleCount} | ${h.antiPatternCount} |`;
    })
    .join("\n");
  const staleRecs =
    healthData
      .filter((h) => h.health === "stale")
      .map((h) => `- **${h.domain}:** Stale — needs new observations or review`)
      .join("\n") || "- All frames are active";
  const zeroPrincipleRecs =
    healthData
      .filter((h) => h.principleCount === 0)
      .map((h) => `- **${h.domain}:** No crystallized principles yet — needs more observations`)
      .join("\n") || "";
  const zeroAntiRecs =
    healthData
      .filter((h) => h.antiPatternCount === 0)
      .map((h) => `- **${h.domain}:** No anti-patterns captured — review recent failures`)
      .join("\n") || "";

  const { p, toString } = lines();
  p("# Wisdom Frame Health Report");
  p("");
  p(`**Generated:** ${date}`);
  p(`**Total Frames:** ${healthData.length}`);
  p("");
  p("## Frame Status");
  p("");
  p("| Domain | Health | Confidence | Observations | Last Updated | Principles | Anti-Patterns |");
  p("|--------|--------|-----------|-------------|-------------|------------|---------------|");
  p(rows);
  p("");
  p("## Recommendations");
  p("");
  p(staleRecs);
  p(zeroPrincipleRecs);
  p(zeroAntiRecs);
  p("");
  p("---");
  p("");
  p("*Generated by WisdomCrossFrameSynthesizer*");
  p("");
  return toString();
}

// ── Main ──

const HELP = `
WisdomCrossFrameSynthesizer - Extract shared principles across Wisdom Frames

Usage:
  bun WisdomCrossFrameSynthesizer.ts              Run synthesis
  bun WisdomCrossFrameSynthesizer.ts --dry-run     Preview without writing
  bun WisdomCrossFrameSynthesizer.ts --health       Show frame health metrics

Output: WISDOM/PRINCIPLES/verified.md and WISDOM/META/frame-health.md
`;

export function main(argv: string[] = process.argv.slice(2)): number {
  const wantHelp = hasFlag(argv, "help") || argv.includes("-h");
  const wantHealth = hasFlag(argv, "health");
  const dryRun = hasFlag(argv, "dry-run");

  if (wantHelp) {
    console.log(HELP);
    return 0;
  }

  // Estate paths are caller identity (D4) — resolved at the edge, injectable via PAI_DIR for tests.
  const baseDir = process.env.LIFEOS_DIR || process.env.PAI_DIR || resolveFrameworkDir(process.env.HOME ?? "");
  const wisdomDir = join(baseDir, "MEMORY", "WISDOM");
  const framesDir = join(wisdomDir, "FRAMES");
  const principlesDir = join(wisdomDir, "PRINCIPLES");
  const metaDir = join(wisdomDir, "META");
  const now = new Date();

  // Load all frames
  if (!exists(framesDir)) {
    console.log("No frames directory found");
    return 0;
  }

  const frameFiles = walkFiles(framesDir, (f) => f.endsWith(".md"));
  if (frameFiles.length === 0) {
    console.log("No frames found");
    return 0;
  }

  console.log(`📊 Loading ${frameFiles.length} frames...`);
  const frames = frameFiles.map(parseFrame);

  if (wantHealth) {
    const healthData = frames.map((f) => assessHealth(f, now));
    const report = generateHealthReport(healthData, now);

    if (dryRun) {
      console.log(report);
    } else {
      ensureDir(metaDir);
      atomicWrite(join(metaDir, "frame-health.md"), report);
      console.log(`✅ Health report written to WISDOM/META/frame-health.md`);
    }
    return 0;
  }

  // Run cross-frame synthesis
  console.log("🔍 Analyzing cross-frame principles...");
  const crossPrinciples = findCrossPrinciples(frames);
  console.log(`   Found ${crossPrinciples.length} cross-domain principles`);

  const report = generatePrinciplesReport(crossPrinciples, frames, now);

  if (dryRun) {
    console.log(report);
  } else {
    ensureDir(principlesDir);
    atomicWrite(join(principlesDir, "verified.md"), report);
    console.log(`✅ Principles report written to WISDOM/PRINCIPLES/verified.md`);

    // Also generate health report
    const healthData = frames.map((f) => assessHealth(f, now));
    const healthReport = generateHealthReport(healthData, now);
    ensureDir(metaDir);
    atomicWrite(join(metaDir, "frame-health.md"), healthReport);
    console.log(`✅ Health report written to WISDOM/META/frame-health.md`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
