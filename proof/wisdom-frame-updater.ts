#!/usr/bin/env bun
/**
 * WisdomFrameUpdater — Story 12.4 rewrite onto the std substrate (proof/ consumer; live cutover to
 * ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). Behavior preserved; re-rolled plumbing now imports
 * tested std primitives:
 *   - the `**Observation Count:**` READ getter → `getMetaField` + a caller-local typed parse;
 *   - the four section-splices (evolution/anti-pattern/contextual-rule/prediction) → `findSection` /
 *     `insertInSection`;
 *   - date stamps → `isoDate(now)` (injected clock);
 *   - fs → `readIfExists` / `atomicWrite`;
 *   - arg parsing → `flagValue` / `hasFlag`;
 *   - JSON envelope emit → `emitJson`.
 *
 * Kept caller-local (D4), byte-for-byte as the origin emitted them because WisdomCrossFrameSynthesizer /
 * WisdomDomainClassifier READ these frames: the frame `.md` template, the meta labels ("Confidence",
 * "Observation Count", "Last Crystallized"), the section names, the `**Field:**` WRITERS (increment /
 * crystallized-date — getMetaField is read-only, never a writer), the `{{PRINCIPAL_NAME}}` token in the
 * usage text, and the `MEMORY/WISDOM/FRAMES` path (injected as a param so tests use a tmp dir).
 */

import { join } from "node:path";
import { findSection, flagValue, getMetaField, hasFlag, insertInSection, isoDate } from "std/core";
import { atomicWrite, readIfExists } from "std/fsx";
import { emitJson } from "std/report";

// ── Types ──

export type ObservationType = "principle" | "contextual-rule" | "prediction" | "anti-pattern" | "evolution";

export interface UpdateResult {
  success: boolean;
  domain: string;
  type: ObservationType;
  message: string;
  framePath: string;
}

// ── Caller-local identity (D4): the frames-dir root, injected so tests stay hermetic ──

/** Resolve the default frames root the way the live tool does (`$PAI_DIR` or `~/.claude`). */
export function defaultFramesDir(
  base: string = process.env.PAI_DIR || join(process.env.HOME || "", ".claude"),
): string {
  return join(base, "MEMORY", "WISDOM", "FRAMES");
}

function getFramePath(framesDir: string, domain: string): string {
  return join(framesDir, `${domain}.md`);
}

// ── Frame Operations ──

/**
 * Parse the observation count from a frame's meta section. Read-only getter: `getMetaField` returns the
 * remainder-of-line after `**Observation Count:**`, and the caller keeps its own typed parse.
 */
export function parseObservationCount(content: string): number {
  const raw = getMetaField(content, "Observation Count");
  return Number.parseInt(raw ?? "", 10) || 0;
}

/**
 * Increment the top-level observation count. LOCAL `**Field:**` WRITER — getMetaField is read-only, so
 * the mutating `content.replace(…)` stays here (D4, byte-identical to the origin).
 */
function incrementObservationCount(content: string): string {
  const current = parseObservationCount(content);
  return content.replace(/(\*\*Observation Count:\*\*\s*)\d+/, `$1${current + 1}`);
}

/**
 * Update the Last Crystallized date. LOCAL `**Field:**` WRITER (see above); date stamp via `isoDate(now)`.
 */
function updateCrystallizedDate(content: string, now: Date): string {
  return content.replace(/(\*\*Last Crystallized:\*\*\s*)\S+/, `$1${isoDate(now)}`);
}

/**
 * Append to the Evolution Log section via `insertInSection`. When the section is absent the graft anchor /
 * shape is caller policy (D4).
 */
function appendEvolution(content: string, entry: string, now: Date): string {
  const heading = "## Evolution Log";
  if (findSection(content, heading) === null) {
    // Add evolution log section if missing
    return content + `\n\n## Evolution Log\n- ${isoDate(now)}: ${entry}\n`;
  }
  return insertInSection(content, heading, `\n- ${isoDate(now)}: ${entry}`);
}

/**
 * Add a new anti-pattern to the Anti-Patterns section via `insertInSection`. The missing-section graft
 * (where to place it — before Cross-Frame / Evolution Log) is caller policy (D4).
 */
function addAntiPattern(content: string, observation: string): string {
  const heading = "## Anti-Patterns";
  if (findSection(content, heading) === null) {
    // Add section before Cross-Frame Connections or at end
    const crossFrame = content.indexOf("## Cross-Frame");
    const evolutionLog = content.indexOf("## Evolution Log");
    const insertBefore = crossFrame !== -1 ? crossFrame : evolutionLog !== -1 ? evolutionLog : content.length;

    const newSection = `## Anti-Patterns (from observations)\n\n### ${observation}\n- **Severity:** Medium\n- **Frequency:** Observed\n- **Root Cause:** To be determined\n- **Counter:** To be determined from further observations\n\n---\n\n`;
    return content.slice(0, insertBefore) + newSection + content.slice(insertBefore);
  }

  const newEntry = `\n\n### ${observation}\n- **Severity:** Medium\n- **Frequency:** Observed\n- **Root Cause:** To be determined\n- **Counter:** To be determined from further observations`;
  return insertInSection(content, heading, newEntry);
}

/**
 * Add a contextual rule via `insertInSection`. Missing-section graft anchor is caller policy (D4).
 */
function addContextualRule(content: string, observation: string, now: Date): string {
  const heading = "## Contextual Rules";
  if (findSection(content, heading) === null) {
    const predictive = content.indexOf("## Predictive");
    const insertBefore = predictive !== -1 ? predictive : content.length;
    return (
      content.slice(0, insertBefore) +
      `## Contextual Rules\n\n- ${observation} (learned ${isoDate(now)})\n\n` +
      content.slice(insertBefore)
    );
  }

  return insertInSection(content, heading, `\n- ${observation} (learned ${isoDate(now)})`);
}

/**
 * Add a prediction row to the Predictive Model table. `findSection` scopes the last-table-row search to the
 * section (byte-identical to the origin's whole-tail `lastIndexOf('|')` on a standard frame, and safer than
 * it on a hand-edited one). Missing-section graft anchor is caller policy (D4).
 */
function addPrediction(content: string, observation: string): string {
  const heading = "## Predictive Model";
  const bounds = findSection(content, heading);

  if (bounds === null) {
    const antiPatterns = content.indexOf("## Anti-Patterns");
    const insertBefore = antiPatterns !== -1 ? antiPatterns : content.length;
    return (
      content.slice(0, insertBefore) +
      `## Predictive Model\n\n| Request Pattern | Predicted Want | Confidence |\n|----------------|---------------|------------|\n| ${observation} | To be refined | 60% |\n\n` +
      content.slice(insertBefore)
    );
  }

  // Add row after the last table line within the section.
  const sectionBody = content.slice(bounds.bodyStart, bounds.bodyEnd);
  const relPipe = sectionBody.lastIndexOf("|");
  if (relPipe === -1) return content;

  const absPipe = bounds.bodyStart + relPipe;
  const lineEnd = content.indexOf("\n", absPipe);
  const at = lineEnd === -1 ? content.length : lineEnd;
  return content.slice(0, at) + `\n| ${observation} | To be refined | 60% |` + content.slice(at);
}

// ── Core Update Function ──

export function updateFrame(
  framesDir: string,
  domain: string,
  observation: string,
  type: ObservationType = "evolution",
  now: Date = new Date(),
): UpdateResult {
  const framePath = getFramePath(framesDir, domain);

  // Create frame if it doesn't exist (readIfExists → null; atomicWrite ensures the parent dir).
  const existing = readIfExists(framePath);
  if (existing === null) {
    const newFrame = `# Frame: ${domain.charAt(0).toUpperCase() + domain.slice(1)} Domain

## Meta
- **Domain:** ${domain}
- **Confidence:** 50%
- **Observation Count:** 1
- **Last Crystallized:** ${isoDate(now)}
- **Source:** Auto-created from observation

---

## Core Principles

*No crystallized principles yet. Observations accumulating.*

---

## Contextual Rules

${type === "contextual-rule" ? `- ${observation} (learned ${isoDate(now)})` : "*None yet.*"}

---

## Predictive Model

| Request Pattern | Predicted Want | Confidence |
|----------------|---------------|------------|
${type === "prediction" ? `| ${observation} | To be refined | 60% |` : ""}

---

## Anti-Patterns (from observations)

${type === "anti-pattern" ? `### ${observation}\n- **Severity:** Medium\n- **Frequency:** Observed\n- **Root Cause:** To be determined\n- **Counter:** To be determined` : "*None yet.*"}

---

## Cross-Frame Connections

*To be discovered through cross-frame synthesis.*

---

## Evolution Log
- ${isoDate(now)}: Frame created with initial observation: ${observation}
`;

    atomicWrite(framePath, newFrame);
    return {
      success: true,
      domain,
      type,
      message: `Created new frame for domain "${domain}" with initial observation`,
      framePath,
    };
  }

  // Update existing frame
  let content = existing;

  // Always increment observation count and update crystallized date
  content = incrementObservationCount(content);
  content = updateCrystallizedDate(content, now);

  // Apply type-specific update
  switch (type) {
    case "anti-pattern":
      content = addAntiPattern(content, observation);
      content = appendEvolution(content, `New anti-pattern observed: ${observation}`, now);
      break;
    case "contextual-rule":
      content = addContextualRule(content, observation, now);
      content = appendEvolution(content, `New contextual rule: ${observation}`, now);
      break;
    case "prediction":
      content = addPrediction(content, observation);
      content = appendEvolution(content, `New prediction added: ${observation}`, now);
      break;
    case "principle":
      // Principles are high-confidence — just log for manual crystallization
      content = appendEvolution(content, `Principle candidate observed: ${observation}`, now);
      break;
    case "evolution":
    default:
      content = appendEvolution(content, observation, now);
      break;
  }

  atomicWrite(framePath, content);

  return {
    success: true,
    domain,
    type,
    message: `Updated "${domain}" frame with ${type}: ${observation}`,
    framePath,
  };
}

// ── CLI ──

const HELP = `
WisdomFrameUpdater - Update Wisdom Frames with new observations

Usage:
  bun WisdomFrameUpdater.ts --domain communication --observation "text" [--type principle|contextual-rule|prediction|anti-pattern|evolution]

Types:
  principle        High-confidence pattern (logs for manual crystallization)
  contextual-rule  Context-specific behavioral rule
  prediction       Request→response prediction
  anti-pattern     Something to avoid
  evolution        General observation (default)
`;

export function main(argv: string[] = Bun.argv.slice(2)): number {
  if (hasFlag(argv, "help")) {
    console.log(HELP);
    return 0;
  }

  const domain = flagValue(argv, "domain");
  const observation = flagValue(argv, "observation");

  if (!domain || !observation) {
    console.error("Required: --domain and --observation");
    return 1;
  }

  const type = (flagValue(argv, "type") || "evolution") as ObservationType;
  const result = updateFrame(defaultFramesDir(), domain, observation, type, new Date());
  emitJson(result);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
