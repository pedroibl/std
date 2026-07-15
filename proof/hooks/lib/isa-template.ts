/**
 * ISA Template Generator (v4.1)
 *
 * Shared ISA (Ideal State Artifact) template used by algorithm.ts CLI.
 * Generates ISA files matching the frontmatter schema expected by algorithm.ts readISA().
 *
 * v4.1 changes (PRD → ISA rename):
 * - File is now ISA.md, not PRD.md
 * - `prd: true` frontmatter flag → `isa: true` (legacy `prd` flag still read by parsers)
 * - Public exports renamed: generatePRDTemplate → generateISATemplate, etc.
 *
 * v4.0 changes (2026-02-22):
 * - The artifact is the SINGLE source of truth per work directory
 * - Frontmatter includes session metadata (previously in META.yaml)
 * - ISC section is the system of record (previously duplicated in ISC.json)
 * - CHANGELOG replaces THREAD.md
 * - Dropped: NON-SCOPE, ASSUMPTIONS, OPEN QUESTIONS (never populated by pipeline)
 * - Kept: STATUS, APPETITE, CONTEXT, RISKS, PLAN, ISC, DECISIONS, CHANGELOG
 *
 * Used by: algorithm.ts
 *
 * ── Story 13.5 rewrite (AD-9.4 Rule 3 — INTERNALS ONLY, 0 hook importers → lowest risk) ─────────────
 * Only the ISA/Algorithm skill tree consumes this (NO hook imports it), so the internal collapse cannot
 * break a wired hook. The frozen exports (curateTitle, generateISAFilename/Id, generateISATemplate + the
 * three PRD aliases) keep byte-stable signatures; only bodies change:
 *   curateTitle whitespace-collapse (:75)        → core.collapse (byte-identical `\s+`→` ` + trim)
 *   generateISAFilename / generateISAId dates     → core.dateParts(now, 'Australia/Melbourne') (validator:
 *     the live `now.getFullYear/getMonth/getDate` read LOCAL time = Melbourne on Pedro's machine; dateParts
 *     with his tz is the faithful port — isoDate/UTC would shift the date 10–11h)
 *   generateISATemplate `today` (:135)            → core.isoDate(now) (the UTC `toISOString().split('T')[0]`)
 * KEEP CALLER-LOCAL (validator E2 / D4):
 *   curateTitle truncate (:83-87) — WORD-boundary (`lastSpace>40`), NO ellipsis; core.truncate is
 *     char-boundary + "..." → would change generated title/filename bytes. Keep verbatim.
 *   the CHANGELOG timestamp (`new Date().toISOString()`) — full UTC-Z instant, no std equivalent.
 *   template BODY (headings, ISC_MINIMUMS, APPETITE_MAP, profanity/filler taxonomy) — caller identity.
 */

import { collapse, dateParts, isoDate } from 'std/core';

// Caller-local identity (D4): Pedro's actual tz — the ISA is generated on his machine; the old local-time
// date read == Melbourne there. NEVER the PAI template's America/Los_Angeles.
const TZ = 'Australia/Melbourne';

interface ISAOptions {
  title: string;
  slug: string;
  effortLevel?: string;
  mode?: "interactive" | "loop" | "optimize";
  prompt?: string;
  sessionId?: string;
}

/**
 * ISC count guidance per effort tier.
 * These are MINIMUMS — the Algorithm should always create at least this many.
 */
const ISC_MINIMUMS: Record<string, { min: number; target: string }> = {
  TRIVIAL:       { min: 2,   target: "2-4" },
  QUICK:         { min: 4,   target: "4-8" },
  STANDARD:      { min: 8,   target: "8-16" },
  EXTENDED:      { min: 16,  target: "16-32" },
  ADVANCED:      { min: 24,  target: "24-48" },
  DEEP:          { min: 40,  target: "40-80" },
  COMPREHENSIVE: { min: 64,  target: "64-150" },
  LOOP:          { min: 16,  target: "16-64" },
};

/**
 * Appetite mapping — maps effort levels to time budgets and circuit breakers.
 */
const APPETITE_MAP: Record<string, { budget: string; circuitBreaker: string }> = {
  TRIVIAL:       { budget: "<10s",   circuitBreaker: "1 session" },
  QUICK:         { budget: "<1min",  circuitBreaker: "1 session" },
  STANDARD:      { budget: "<2min",  circuitBreaker: "1 session" },
  EXTENDED:      { budget: "<8min",  circuitBreaker: "2 sessions" },
  ADVANCED:      { budget: "<16min", circuitBreaker: "3 sessions" },
  DEEP:          { budget: "<32min", circuitBreaker: "3 sessions" },
  COMPREHENSIVE: { budget: "<120m",  circuitBreaker: "5 sessions" },
  LOOP:          { budget: "unbounded", circuitBreaker: "max iterations" },
};

/**
 * Curate a title from raw user prompt into a readable ISA title.
 * Heuristic — no inference call, runs in <1ms.
 */
export function curateTitle(rawPrompt: string): string {
  let title = rawPrompt.trim();

  // Remove leading filler words
  title = title.replace(/^(okay|ok|hey|so|um|uh|well|right|alright|please|can you|i want you to|i need you to|i want to|we need to|lets|let's)\s+/gi, '');

  // Remove profanity (common in {{PRINCIPAL_NAME}}'s prompts)
  title = title.replace(/\b(fuck|fucking|shit|shitty|damn|damnit|ass|bitch|motherfuck\w*|dumbass|goddamn)\b\s*/gi, '');

  // Collapse whitespace (core.collapse ≡ the live `.replace(/\s+/g,' ').trim()` — byte-identical).
  title = collapse(title);

  // Capitalize first letter
  if (title.length > 0) {
    title = title.charAt(0).toUpperCase() + title.slice(1);
  }

  // Truncate to reasonable length but at word boundary. KEEP CALLER-LOCAL (validator E2): word-boundary
  // (`lastSpace>40`), NO ellipsis — NOT core.truncate (char-boundary + "..." would change the bytes).
  if (title.length > 80) {
    const truncated = title.substring(0, 80);
    const lastSpace = truncated.lastIndexOf(' ');
    title = lastSpace > 40 ? truncated.substring(0, lastSpace) : truncated;
  }

  return title || 'Untitled Task';
}

/**
 * Generate an ISA filename: ISA-{YYYYMMDD}-{slug}.md
 *
 * Note: this is the legacy date-stamped filename used by `algorithm new` for
 * project-side artifacts. The current canonical filename inside MEMORY/WORK/
 * is just `ISA.md` (one per session directory).
 */
export function generateISAFilename(slug: string): string {
  // dateParts(now, Melbourne).iso is `YYYY-MM-DD`; strip the dashes for the compact stamp.
  const stamp = dateParts(new Date(), TZ).iso.replace(/-/g, "");
  return `ISA-${stamp}-${slug}.md`;
}

/** @deprecated use generateISAFilename. */
export const generatePRDFilename = generateISAFilename;

/**
 * Generate an ISA ID: ISA-{YYYYMMDD}-{slug}
 */
export function generateISAId(slug: string): string {
  const stamp = dateParts(new Date(), TZ).iso.replace(/-/g, "");
  return `ISA-${stamp}-${slug}`;
}

/** @deprecated use generateISAId. */
export const generatePRDId = generateISAId;

/**
 * Generate a consolidated ISA file — single source of truth for each work item.
 *
 * v4.0: Consolidates META.yaml, ISC.json, THREAD.md into a single artifact.
 * - Frontmatter includes session metadata (previously in META.yaml)
 * - ISC section is the system of record (previously duplicated in ISC.json)
 * - CHANGELOG replaces THREAD.md
 * - Dropped: NON-SCOPE, ASSUMPTIONS, OPEN QUESTIONS (never populated by pipeline)
 * - Kept: STATUS, APPETITE, CONTEXT, RISKS, PLAN, ISC, DECISIONS, CHANGELOG
 */
export function generateISATemplate(opts: ISAOptions): string {
  // `today` is the UTC calendar date (core.isoDate ≡ the live `new Date().toISOString().split("T")[0]`).
  const today = isoDate(new Date());
  // CHANGELOG timestamp — full UTC-Z instant; no std equivalent, keep caller-local.
  const timestamp = new Date().toISOString();
  const id = generateISAId(opts.slug);
  const effort = opts.effortLevel || "Standard";
  const effortUpper = effort.toUpperCase();
  const mode = opts.mode || "interactive";

  const curatedTitle = opts.prompt ? curateTitle(opts.prompt) : opts.title;
  const promptSection = opts.prompt
    ? `### Problem Space\n${opts.prompt.substring(0, 500)}\n`
    : `### Problem Space\n_To be populated during OBSERVE phase._\n`;

  const iscGuide = ISC_MINIMUMS[effortUpper] || ISC_MINIMUMS.STANDARD;
  const appetite = APPETITE_MAP[effortUpper] || APPETITE_MAP.STANDARD;

  return `---
isa: true
id: ${id}
title: "${curatedTitle.replace(/"/g, '\\"')}"
session_id: "${opts.sessionId || 'unknown'}"
status: ACTIVE
mode: ${mode}
effort_level: ${effort}
created: ${today}
updated: ${today}
completed_at: null
iteration: 0
maxIterations: 128
loopStatus: null
last_phase: null
failing_criteria: []
verification_summary: "0/0"
parent: null
children: []
---

# ${curatedTitle}

> _To be populated during OBSERVE: what this achieves and why it matters._

## STATUS

| What | State |
|------|-------|
| Progress | 0/0 criteria passing |
| Phase | ACTIVE |
| Next action | OBSERVE phase — create ISC |
| Blocked by | nothing |

## APPETITE

| Budget | Circuit Breaker | ISC Target |
|--------|----------------|------------|
| ${appetite.budget} | ${appetite.circuitBreaker} | ${iscGuide.target} criteria |

## CONTEXT

${promptSection}
### Key Files
_To be populated during exploration._

## RISKS & RABBIT HOLES

_To be populated during THINK phase._

## PLAN

_To be populated during PLAN phase._

## ISC Criteria

<!--
  Verification criteria (the "ideal state"). Format (Algorithm v5.5.0+):
    - [ ] ISC-1: description
    - [ ] ISC-2: Anti: what must NOT happen        (anti-criterion — Anti: prose prefix; sequential numbering)
    - [ ] ISC-N: Antecedent: precondition          (when goal is experiential — Antecedent: prose prefix)
  All ISCs number sequentially in one pool; the Anti:/Antecedent: prefix carries the doctrinal kind.
  Anti-criteria ≥1 required. Antecedent ≥1 required when goal is experiential.
  Checkboxes flip [ ] to [x] as criteria pass during VERIFY.
-->

## DECISIONS

_Non-obvious technical decisions logged here during BUILD/EXECUTE._

## CHANGELOG

- ${timestamp} | CREATED | ${effort} effort | ${iscGuide.target} ISC target
`;
}

/** @deprecated use generateISATemplate. */
export const generatePRDTemplate = generateISATemplate;
