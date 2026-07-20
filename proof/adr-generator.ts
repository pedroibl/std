#!/usr/bin/env bun
/**
 * adr-generator — the provenance / ADR generator  (Epic 15, Story 15.4)
 * ============================================================================
 * Turns the hand-written `~/Dev/std-customisations/docs/DECISIONS.md` pattern into a
 * repeatable extraction: session transcript → structured ADR digest, carrying the
 * provenance a flat git history cannot.
 *
 *   bun adr-generator.ts [--queue <dir>] [--projects <dir>] [--root <dir>] [--out <file>]
 *                        [--window <n>] [--dry-run] [--json] [--strict] [--help]
 *
 * ── THE TWO-SOURCE MODEL: THE QUEUE SELECTS, THE TRANSCRIPT COMPOSES ────────
 * The epic AC names two inputs in one sentence ("session transcript → structured ADR
 * digest … consumes the queue + provenance tuple"). They are NOT the same source:
 *   • the queue candidate holds only truncated slices — `content: text.slice(0, 500)`
 *     and `context: text.slice(0, 300)` (harvester.ts). You cannot write an ADR's
 *     Context/Decision/Consequences out of 500 truncated characters; the prior art was
 *     distilled from a 467-message FULL transcript.
 *   • the provenance tuple is a CURSOR. `{ sessionId, sourceLine }` is exactly enough
 *     to re-open the raw transcript and seek back to the line.
 * So: SELECT from the queue (which sessions decided something, and where), then read the
 * transcript AT THAT CURSOR to COMPOSE. Both clauses satisfied honestly, and it is the
 * reason the queue's known noise problem barely touches this tool — a noisy candidate
 * costs a wasted lookup, never a garbage ADR, because candidate text is never ADR content.
 *
 * 15.4 is the FIRST consumer that DEREFERENCES the seam rather than merely reading it.
 *
 * ── THE CURSOR IS 1-BASED, AND `sessionId` DOES NOT RESOLVE BY CONSTRUCTION ──
 * `sourceLine` counts RAW lines of the session file 1-based (`sourceLine: lineIdx + 1`),
 * so the index is `sourceLine - 1`. An off-by-one here silently cites the WRONG line —
 * the one thing this tool exists to get right, and the reason `resolveCursor` is unit-tested
 * against a fixture whose line N is distinguishable from N±1.
 *
 * `sessionId` is `basename(path, ".jsonl")` and NOTHING more. It is resolved by an EXACT
 * basename walk over `projectsRoot`, built ONCE into a Map. Never
 * `join(projectsRoot, projectSlug, sessionId + ".jsonl")`: ~15% of the live population is a
 * SUBAGENT TIER at depth ≥3 (`<slug>/<uuid>/subagents/agent-*.jsonl`) for which the producer
 * stamps `projectSlug` as the literal string `"subagents"` and `sessionId` is not a UUID. A
 * path-join resolver does not crash on those — it reports them `stale`, i.e. ~15% FALSE-STALE
 * that reads as cursor drift rather than a wrong resolver. That silent-wrong-answer is exactly
 * what this story exists to prevent (`subagent-tier` fixture in the tests is its guard).
 * Basename uniqueness is the property that makes the Map lossless: verified live, 2762 files /
 * 2762 unique basenames, zero collisions tree-wide.
 *
 * The `"subagents"` slug stamp is a PRODUCER artifact — FLAGGED here, not fixed (changing the
 * stamp is a queue-contract change, i.e. 15.3's substrate-gap successor, not this story).
 *
 * ── IT NEVER REWRITES A HUMAN-AUTHORED ADR FILE ─────────────────────────────
 * The prior art is hand-written prose Pedro owns. Two rules make that provable rather than
 * promised:
 *   1. the default `--out` is a SEPARATE file this tool owns —
 *      `<root>/docs/DECISIONS.generated.md`, never `docs/DECISIONS.md`, and it is ABSOLUTE
 *      (anchored to the injected `--root`), so a bare invocation from an arbitrary cwd cannot
 *      scatter stray `docs/` trees or land on a human file;
 *   2. every write is additive — `writeIfAbsent` for the one-time header (O_CREAT|O_EXCL: it
 *      can never clobber an existing file) and `appendIfMissing` for each ADR block (marker-gated
 *      atomic EOF concat; prior bytes preserved). There is deliberately no in-place rewrite path,
 *      and `atomicWrite` is deliberately NOT called: on an existing file it is precisely the
 *      clobber this rule forbids. The real proof is the test that hashes a fixture DECISIONS.md
 *      before and after a run.
 *
 * ── THE MARKER IS CANDIDATE-IDENTITY-DERIVED, NEVER THE ADR HEADING ─────────
 * `appendIfMissing` skips only when the marker is already present. The heading cannot be the
 * marker: numbers are allocated `max+1` FRESHLY each run, so run 2 on the same candidate would
 * find `## ADR-0014` absent and append a DUPLICATE under a new number — a gate that can never
 * fire, and a "existing ADRs byte-unchanged" test passes the whole time it happens. The marker is
 * the cursor itself:  `<!-- adr-src: {sessionId}:{sourceLine} -->`  — stable across runs.
 *
 * And the marker PRE-CHECK, not `appendIfMissing`'s return, is the `duplicate` detector: a
 * write-path detector can never fire under `--dry-run`, so the dry-run digest would silently
 * disagree with the real run. `appendIfMissing === false` is demoted to a redundant race guard.
 * `duplicate` is NOT only a re-run artifact — `queueFilename` embeds a fresh timestamp, so the
 * queue legitimately accumulates several candidate FILES sharing one `sessionId:sourceLine`, and
 * one single run hits its own marker.
 *
 * ── VERIFY-AGAINST-LIVE (the brain-check property) ──────────────────────────
 * A cached claim is re-checked against its source before emission, and drift is FLAGGED, never
 * silently fixed: the cited transcript must exist, the cited line must resolve, and the mined
 * excerpt must still match what is at that line. Any failure is a REPORTED `stale` outcome —
 * never a crash, never a silent drop. Dependency-free like `brain-check.ts`: this tool must run
 * when the harvester is broken, so it imports no runtime symbol from it (`Provenance` is a
 * type-only import that erases at build time).
 *
 * ── SUBSTRATE ───────────────────────────────────────────────────────────────
 *   std/core   flagValue / hasFlag (CLI — `--k=v` too, which brain-check's own `arg()` lacks)
 *   std/fsx    walkFiles (the ONE transcript walk) · readIfExists · exists
 *   std/report lines (render) · emitJson / log (--json) · writeIfAbsent / appendIfMissing (writes)
 *
 * DEV NOTE: lives in std-public `proof/` as a std CONSUMER (never library surface, so not under
 * src/**). Production home is ~/.claude/PAI/TOOLS/; the live deploy is an Epic-17-shaped
 * follow-up, not part of this story.
 */

import { flagValue, hasFlag } from "std/core";
import { readIfExists, walkFiles } from "std/fsx";
import { appendIfMissing, emitJson, lines, log, writeIfAbsent } from "std/report";

import type { Provenance } from "./harvester";

import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

// ============================================================================
// CONTRACT
// ============================================================================

/**
 * The five TERMINAL buckets. Every queue file lands in exactly one and the counts sum to the
 * queue file count — that sum is the proof nothing was silently dropped.
 */
export type Bucket = "malformed" | "skipped" | "stale" | "duplicate" | "emitted";

/**
 * Bucket PRECEDENCE, first match wins. `malformed` MUST be first (you cannot read a `tags` or a
 * `provenance` off an unvalidated shape). `skipped` next — a non-decision candidate is never worth
 * a transcript lookup. `stale` before `duplicate` deliberately: verification-against-live is the
 * brain-check property this tool inherits, so a candidate whose cursor no longer resolves is
 * reported as drift even if some earlier run already emitted its marker — the drift is the more
 * actionable fact. Recorded here so "exactly one of five" is well-defined.
 */
export const PRECEDENCE: readonly Bucket[] = ["malformed", "skipped", "stale", "duplicate", "emitted"];

/** The `memoryType` values the harvester mines. Only `decision` is ADR-shaped. */
export const DECISION_TAG = "decision";

/** The status legend value every generated ADR carries. See `ADR_STATUS` note below. */
export const ADR_STATUS = "Open";

/** One queue file as read from disk. `raw === null` means it vanished between walk and read. */
export interface AdrInput {
  file: string;
  raw: string | null;
}

/** The shape a queue candidate must actually have on disk before anything downstream reads it. */
export interface Candidate {
  provenance: Provenance;
  title: string;
  content: string;
  tags: string[];
}

/** A composed ADR, before rendering. Pure data — `renderAdr` turns it into markdown. */
export interface Adr {
  number: number;
  title: string;
  status: string;
  context: string;
  decision: string;
  consequences: string;
  marker: string;
  provenance: Provenance;
}

export interface Verdict {
  /** The terminal bucket (exactly one, per PRECEDENCE). */
  bucket: Bucket;
  /** The queue file this verdict is about. */
  file: string;
  /** Why, for `malformed` (`missing` | `unparseable` | `bad-shape`) and for `stale`. */
  reason?: string;
  provenance?: Provenance;
  /** The cursor marker — set whenever provenance parsed, so `duplicate` is explainable. */
  marker?: string;
  /** The resolved transcript path — set once the cursor resolved. */
  transcript?: string;
  /** The composed ADR — set for `emitted` only. */
  adr?: Adr;
}

export interface AdrReport {
  /** Queue file count — `counts` must sum to this. */
  total: number;
  counts: Record<Bucket, number>;
  /** The highest ADR number present in the out-file before this run (0 when there is none). */
  startingMax: number;
  verdicts: Verdict[];
}

// ============================================================================
// PURE CORE — zero disk. Transcript reads arrive through an injected resolver, so the
// whole select→dereference→compose decision is unit-testable with no filesystem.
// ============================================================================

/**
 * RUNTIME shape guard (NOT compile-time — do not delete this as redundant with the `Candidate`
 * type). `JSON.parse` hands back `any` and the disk is not bound by our types, so a
 * parseable-but-wrong-shaped file (`{}`, `[]`, `"x"`) sails through a cast and then TypeErrors the
 * moment something reads `provenance.sessionId`.
 *
 * It guards EVERY field a downstream consumer reads, not just the routing key: a partial guard
 * accepts `{provenance:{sessionId:"s"}}` and the ADR then cites `line undefined`, defeating the
 * provenance-to-the-line guarantee that is this whole story's point.
 */
export function isCandidate(value: unknown): value is Candidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  const p = c.provenance;
  if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
  const prov = p as Record<string, unknown>;
  return (
    typeof prov.sessionId === "string" &&
    prov.sessionId.length > 0 &&
    typeof prov.sourceLine === "number" &&
    Number.isInteger(prov.sourceLine) &&
    prov.sourceLine > 0 &&
    typeof prov.timestamp === "string" &&
    typeof prov.projectSlug === "string" &&
    typeof c.title === "string" &&
    typeof c.content === "string" &&
    Array.isArray(c.tags) &&
    c.tags.every((t) => typeof t === "string")
  );
}

/**
 * Decision-shaped? The queue JSON does not carry `memoryType` as its own field — the producer
 * writes it as `tags[0]` (`tags: [m.memoryType, "mined", "project:<slug>", ...extraTags]`). Read it
 * by MEMBERSHIP, not by index: Story 15.3 appends artifact tags and future stories may too, and a
 * positional read would break the first time anything is prepended. `decision` is the only one of
 * the four mined types (`decision`/`preference`/`milestone`/`problem`) that is ADR-shaped.
 */
export function isDecisionShaped(c: Candidate): boolean {
  return c.tags.includes(DECISION_TAG);
}

/**
 * The stable cursor marker — candidate identity, never the ADR heading (see the header note).
 * The ` -->` terminator makes it prefix-collision-safe: `sid:4` cannot match `sid:42 -->`.
 */
export function markerFor(prov: Provenance): string {
  return `<!-- adr-src: ${prov.sessionId}:${prov.sourceLine} -->`;
}

/**
 * Highest existing `## ADR-NNNN` in the out-file, or 0 when there is none. Allocation is `max+1`
 * and EXISTING ADRS ARE NEVER RENUMBERED — the prior art is a human record whose numbers are cited
 * elsewhere.
 *
 * A plain regex over the file, deliberately not `core.findSection`: that is single-section and
 * literal-heading, and returns CHAR OFFSETS rather than lines, so it would be the wrong tool twice
 * over.
 */
export function highestAdrNumber(existing: string): number {
  let max = 0;
  for (const m of existing.matchAll(/^## ADR-(\d{4})\b/gm)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

/** Every cursor marker already present in the out-file. Read ONCE per run; the run adds to it. */
export function existingMarkers(existing: string): Set<string> {
  return new Set([...existing.matchAll(/<!-- adr-src: [^>]*? -->/g)].map((m) => m[0]));
}

/**
 * The mined excerpt the producer sliced out of the transcript line, recovered from the candidate's
 * composed `content` field (`## <Type>\n\n<content>\n\n## Context\n\n<context>`). Returns `null`
 * when the content does not have that shape — the caller then has nothing to verify against and
 * treats it as unverifiable drift rather than pretending the check passed.
 *
 * This is a READ of the producer's format, not a re-derivation of it: the excerpt is exactly
 * `text.slice(0, 500)` of the cited line, which is what makes the drift check below EXACT rather
 * than fuzzy.
 */
export function minedExcerpt(content: string): string | null {
  const m = /^## [^\n]+\n\n([\s\S]*?)\n\n## Context\n\n[\s\S]*$/.exec(content);
  return m ? m[1] : null;
}

/** A JSONL transcript entry, as far as this tool cares. */
interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

/**
 * Text of one raw transcript line. Mirrors the producer's `extractTextContent` SHAPE (string
 * content passes through; an array keeps `type === "text"` blocks joined by newline) so the drift
 * check compares like with like.
 *
 * It is re-stated here rather than imported ON PURPOSE: AC3's dependency-free rule means this tool
 * must run when the harvester is broken. Two copies of an eight-line pure function is the cheaper
 * side of that trade; if a third caller ever appears, that is a Rule-of-Three promotion
 * conversation (D2), not an import.
 *
 * Returns `""` for a blank / unparseable / content-less line — never throws.
 */
export function lineText(rawLine: string): string {
  if (!rawLine.trim()) return "";
  let entry: TranscriptEntry;
  try {
    entry = JSON.parse(rawLine) as TranscriptEntry;
  } catch {
    return "";
  }
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text" && (c as { text?: string }).text)
      .map((c) => (c as { text: string }).text)
      .join("\n");
  }
  return "";
}

/** A dereferenced cursor: the cited line plus the window either side of it. */
export interface Window {
  /** Text of the cited line itself. */
  line: string;
  /** Text of the `radius` nearest PROSE messages BEFORE the cited line, oldest first. */
  before: string[];
  /** Text of the `radius` nearest PROSE messages AFTER the cited line, oldest first. */
  after: string[];
}

/**
 * How far past `radius` the outward scan may look for prose, as a multiplier. Bounded so a cursor
 * sitting in a long tool-only stretch cannot degenerate into a whole-file scan.
 *
 * ⚠ WHY THIS EXISTS — measured, not theorised. The first live dry-run (80 real candidates) reported
 * "(no preceding transcript context)" on 4 of 5 emitted ADRs, because the window counted RAW LINES
 * and a real transcript's neighbouring lines are overwhelmingly `tool_use`/`tool_result` records,
 * which `lineText` correctly yields `""` for. Counting raw lines therefore produced an ADR with an
 * empty Context — the exact "compose from the transcript window" clause failing silently while every
 * hermetic fixture (all-prose lines) passed. The window is measured in MESSAGES OF PROSE, not lines.
 */
const SCAN_FACTOR = 25;

/**
 * Dereference the cursor into a window over the RAW transcript lines.
 *
 * ⚠ `sourceLine` is 1-BASED (the producer stamps `lineIdx + 1`), so the index is `sourceLine - 1`.
 * Returns `null` when the line is out of range — a reported `stale`, never a crash.
 *
 * The cited line is read at its exact index; the surrounding context scans OUTWARD past tool-only
 * lines until it has `radius` prose messages or hits the `SCAN_FACTOR` bound (see above).
 */
export function readWindow(raw: string, sourceLine: number, radius: number): Window | null {
  const rawLines = raw.split("\n");
  const idx = sourceLine - 1; // ⚠ 1-based cursor → 0-based index. The headline off-by-one guard.
  if (idx < 0 || idx >= rawLines.length) return null;
  const scan = (step: 1 | -1): string[] => {
    const out: string[] = [];
    const maxScan = radius * SCAN_FACTOR;
    for (let n = 1; n <= maxScan && out.length < radius; n++) {
      const i = idx + step * n;
      if (i < 0 || i >= rawLines.length) break;
      const t = lineText(rawLines[i]).trim();
      if (t) out.push(t);
    }
    return step === -1 ? out.reverse() : out; // both directions read oldest-first
  };
  return { line: lineText(rawLines[idx]), before: scan(-1), after: scan(1) };
}

/** Collapse transcript prose to a single line and cap it, so an ADR field stays one field. */
export function oneLine(text: string, cap = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/**
 * The ADR title. Derived from the cited line's own text (the transcript, never the truncated
 * candidate), first sentence-ish, capped. Falls back to the candidate title when the line yields
 * nothing usable — an ADR with an empty heading would be worse than a coarse one.
 */
export function adrTitle(lineTextValue: string, fallback: string): string {
  const first = oneLine(lineTextValue.split(/(?<=[.!?])\s/)[0] ?? "", 90).trim();
  return first.length >= 12 ? first : oneLine(fallback, 90);
}

/**
 * Compose the ADR from the TRANSCRIPT WINDOW — never from the truncated candidate.
 *
 * The mapping is mechanical and honest, which is the point: `Context` is what was being said
 * BEFORE the decision line, `Decision` is the line itself, `Consequences` is what followed. A
 * generator cannot know whether a decision is still in force, so `Status` is always `Open` (the
 * prior art's legend: unresolved) — a generated `Accepted` would be a claim this tool cannot
 * verify, and the whole point of the exercise is not asserting what it has not checked. A human
 * promotes it to `Accepted`/`Deferred` when they confirm it.
 */
export function composeAdr(candidate: Candidate, window: Window, number: number): Adr {
  return {
    number,
    title: adrTitle(window.line, candidate.title),
    status: ADR_STATUS,
    context: window.before.length ? oneLine(window.before.join(" ")) : "(no preceding transcript context at this cursor)",
    decision: oneLine(window.line, 700),
    consequences: window.after.length
      ? oneLine(window.after.join(" "))
      : "(no following transcript context at this cursor — the decision closes the window)",
    marker: markerFor(candidate.provenance),
    provenance: candidate.provenance,
  };
}

/**
 * Render one ADR block in the prior art's exact format, plus two additions the ACs require:
 * the cursor MARKER comment (idempotency — see header) and a `**Provenance:**` line (AC3 mandates
 * each generated ADR carry session/line/timestamp/project; the prior art is hand-written and has
 * that only in its file header).
 *
 * The caller owns the newlines around an appended block, so this leads with a blank line and ends
 * with one — appending to a file that ends on its last ADR's Consequences yields the same
 * one-blank-line separation the prior art uses.
 */
export function renderAdr(adr: Adr): string {
  const { p, toString } = lines();
  p();
  p(`## ADR-${String(adr.number).padStart(4, "0")} — ${adr.title}`);
  p(adr.marker);
  p(`**Status:** ${adr.status}`);
  p(`**Context:** ${adr.context}`);
  p(`**Decision:** ${adr.decision}`);
  p(`**Consequences:** ${adr.consequences}`);
  p(
    `**Provenance:** session \`${adr.provenance.sessionId}\` line ${adr.provenance.sourceLine} · ` +
      `${adr.provenance.timestamp} · project \`${adr.provenance.projectSlug}\``,
  );
  p();
  return toString();
}

/**
 * The one-time file header — the prior art's provenance block plus its status legend. Written with
 * `writeIfAbsent`, so it is created once and can never overwrite an existing file (that is the
 * never-clobber rule, enforced by the syscall rather than by a check).
 */
export function renderHeader(queueDir: string, projectsRoot: string): string {
  const { p, toString } = lines();
  p("# Decisions — generated provenance record");
  p();
  p("> ADR-style record of *why things are shaped the way they are*, extracted from session");
  p("> transcripts rather than hand-typed. Generated by `adr-generator` (Epic 15, Story 15.4).");
  p(">");
  p(`> **Primary source:** the raw session transcripts under \`${projectsRoot}\` — each ADR below cites`);
  p("> its exact session and 1-based line. **Secondary:** the harvester candidate queue at");
  p(`> \`${queueDir}\`, which SELECTS which sessions/lines are worth composing (it never supplies ADR`);
  p("> content — its candidates are 500-char truncated slices).");
  p(">");
  p("> Status legend: **Accepted** (in force) · **Deferred** (decided, not yet built) · **Open** (unresolved).");
  p("> Everything generated here starts **Open** — a generator cannot verify that a decision is still");
  p("> in force. Promote it by hand once you have confirmed it.");
  p();
  p("---");
  return toString();
}

/** Everything `buildReport` needs from the outside world, injected so the core stays pure. */
export interface BuildDeps {
  /** Current content of the out-file (`""` when it does not exist). Read ONCE per run. */
  existing: string;
  /** sessionId → raw transcript text, or `null` when the cursor does not resolve. */
  readTranscript: (sessionId: string) => string | null;
  /** sessionId → the resolved path, for reporting. `null` mirrors `readTranscript`. */
  transcriptPath?: (sessionId: string) => string | null;
  /** Lines of context either side of the cited line. */
  radius: number;
}

/**
 * Route every queue input into exactly one terminal bucket and compose the ADRs for the ones that
 * survive. PURE — the only disk contact is the injected `readTranscript`, so the whole decision is
 * unit-testable with no filesystem, and `--dry-run` is just "do not run the writer afterwards".
 *
 * ⚠ ORDER IS LOAD-BEARING, per candidate: check the MARKER first, and allocate `max+1` ONLY for a
 * candidate that will actually append. The naive read (scan `max` once, allocate N sequential
 * numbers, then gate the appends) BURNS a number for every skipped candidate — emitted ADRs come
 * out `0015, 0018, 0019` and the next run's `max` jumps past the gaps. `max` is tracked in memory
 * across the run because each append mutates the file.
 */
export function buildReport(inputs: AdrInput[], deps: BuildDeps): AdrReport {
  const startingMax = highestAdrNumber(deps.existing);
  const markers = existingMarkers(deps.existing);
  let max = startingMax;
  const verdicts: Verdict[] = [];

  for (const input of inputs) {
    // ── 1. malformed (highest precedence). A file that vanished between walk and read folds in
    //       here with reason `missing`; it is not a sixth bucket.
    if (input.raw === null) {
      verdicts.push({ bucket: "malformed", file: input.file, reason: "missing" });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.raw);
    } catch {
      verdicts.push({ bucket: "malformed", file: input.file, reason: "unparseable" });
      continue;
    }
    if (!isCandidate(parsed)) {
      verdicts.push({ bucket: "malformed", file: input.file, reason: "bad-shape" });
      continue;
    }
    const candidate = parsed;
    const marker = markerFor(candidate.provenance);

    // ── 2. skipped — not decision-shaped. Never worth a transcript lookup.
    if (!isDecisionShaped(candidate)) {
      verdicts.push({
        bucket: "skipped",
        file: input.file,
        reason: `not decision-shaped (tags: ${candidate.tags.join(", ")})`,
        provenance: candidate.provenance,
        marker,
      });
      continue;
    }

    // ── 3. stale — VERIFY AGAINST LIVE before emission (the brain-check property). Three ways to
    //       drift, all REPORTED with the cursor, none silently fixed and none a crash.
    const raw = deps.readTranscript(candidate.provenance.sessionId);
    const path = deps.transcriptPath?.(candidate.provenance.sessionId) ?? undefined;
    if (raw === null) {
      verdicts.push({
        bucket: "stale",
        file: input.file,
        reason: `transcript not found for session ${candidate.provenance.sessionId}`,
        provenance: candidate.provenance,
        marker,
      });
      continue;
    }
    const window = readWindow(raw, candidate.provenance.sourceLine, deps.radius);
    if (window === null) {
      verdicts.push({
        bucket: "stale",
        file: input.file,
        reason: `line ${candidate.provenance.sourceLine} is past EOF of the cited transcript`,
        provenance: candidate.provenance,
        marker,
        transcript: path,
      });
      continue;
    }
    const excerpt = minedExcerpt(candidate.content);
    if (excerpt === null) {
      verdicts.push({
        bucket: "stale",
        file: input.file,
        reason: "candidate content is not in the producer's `## Type / ## Context` shape — nothing to verify against",
        provenance: candidate.provenance,
        marker,
        transcript: path,
      });
      continue;
    }
    // EXACT, not fuzzy: the excerpt IS `text.slice(0, 500)` of this line, so an equal-length prefix
    // comparison is the precise "still says what it said" check.
    if (window.line.slice(0, excerpt.length) !== excerpt) {
      verdicts.push({
        bucket: "stale",
        file: input.file,
        reason: `quoted text no longer matches line ${candidate.provenance.sourceLine} of the cited transcript`,
        provenance: candidate.provenance,
        marker,
        transcript: path,
      });
      continue;
    }

    // ── 4. duplicate — the MARKER PRE-CHECK is the detector (never `appendIfMissing`'s return: a
    //       write-path detector cannot fire under --dry-run, and the digests would disagree).
    //       The in-run `markers` set makes two candidate files sharing one cursor resolve the same
    //       way in a single run as they would across two runs.
    if (markers.has(marker)) {
      verdicts.push({
        bucket: "duplicate",
        file: input.file,
        reason: "an ADR for this cursor is already present",
        provenance: candidate.provenance,
        marker,
        transcript: path,
      });
      continue;
    }

    // ── 5. emitted — allocate the number ONLY now, so no number is burned by a skip.
    max += 1;
    markers.add(marker);
    verdicts.push({
      bucket: "emitted",
      file: input.file,
      provenance: candidate.provenance,
      marker,
      transcript: path,
      adr: composeAdr(candidate, window, max),
    });
  }

  const counts: Record<Bucket, number> = { malformed: 0, skipped: 0, stale: 0, duplicate: 0, emitted: 0 };
  for (const v of verdicts) counts[v.bucket] += 1;
  return { total: inputs.length, counts, startingMax, verdicts };
}

/** The human digest. */
export function renderHuman(report: AdrReport, out: string, dryRun: boolean): string {
  const { p, toString } = lines();
  p(`# ADR generator — ${report.total} candidate${report.total === 1 ? "" : "s"}`);
  p();
  p(`- **out:** \`${out}\`${dryRun ? " *(dry run — nothing written)*" : ""}`);
  p(`- **highest existing ADR:** ${report.startingMax === 0 ? "none" : `ADR-${String(report.startingMax).padStart(4, "0")}`}`);
  p();
  p("| bucket | count |");
  p("|---|---|");
  for (const b of PRECEDENCE) p(`| ${b} | ${report.counts[b]} |`);
  p(`| **total** | **${report.total}** |`);
  p();

  const emitted = report.verdicts.filter((v) => v.bucket === "emitted");
  if (emitted.length) {
    p(`## Emitted (${emitted.length})`);
    for (const v of emitted) p(v.adr ? renderAdr(v.adr) : "");
    p();
  }

  const needsHuman = report.verdicts.filter((v) => v.bucket === "stale" || v.bucket === "malformed");
  if (needsHuman.length) {
    p(`## Needs a human (${needsHuman.length})`);
    p();
    for (const v of needsHuman) {
      const cursor = v.provenance ? ` — cursor \`${v.provenance.sessionId}:${v.provenance.sourceLine}\`` : "";
      p(`- **[${v.bucket}]** \`${v.file}\`${cursor}: ${v.reason ?? ""}`);
    }
    p();
  }

  // The selection-precision measurement §Known-input-quality asks for — reported, never "fixed":
  // the confidence formula is producer-side and ripples into the contract every 15.x story consumes.
  const considered = report.counts.skipped + report.counts.emitted + report.counts.duplicate + report.counts.stale;
  if (considered > 0) {
    const rate = ((report.counts.skipped / considered) * 100).toFixed(1);
    p(`> Selection precision: ${report.counts.skipped}/${considered} well-formed candidates were not decision-shaped (${rate}%).`);
    p("> Flagged, not fixed — the confidence/typing formula is producer-side (15.3's substrate-gap successor).");
  }
  return toString();
}

// ============================================================================
// EDGE — disk reads, argv, stdout, the writer. Every path is injected via a flag
// (brain-check's `arg()` shape), implemented with `core.flagValue` so `--k=v` works too.
// ============================================================================

/** Read the queue: every `.json` file under `queueDir`, path-sorted so the report is deterministic. */
export function readQueue(queueDir: string): AdrInput[] {
  // `walkFiles` is fail-soft on a missing root (→ []) — exactly the runs-degraded contract.
  const files = walkFiles(queueDir, (path) => path.endsWith(".json")).sort();
  // `readIfExists` (not `loadJson`): the caller must distinguish missing / malformed / valid, and
  // `loadJson` collapses the first two into its fallback with no way to tell them apart.
  return files.map((file) => ({ file, raw: readIfExists(file) }));
}

/**
 * ONE walk for the whole run: sessionId (exact basename, `.jsonl` stripped) → transcript path.
 *
 * `walkFiles` has no early exit (it drains its stack), so a per-candidate walk would be
 * O(candidates × ~2,762 files). It is also UNBOUNDED-recursive, which is exactly what makes it
 * correct here: ~15% of the population is the subagent tier at depth ≥3.
 *
 * ⚠ Keep the `.jsonl` predicate. `walkFiles` returns ALL files and `basename(p, ".jsonl")` leaves a
 * name UNCHANGED when the suffix does not match, so a file literally named `<sessionId>` (other
 * extension, or none) would otherwise claim the key. Same guard the producer's `discoverSessions`
 * uses.
 *
 * Lossless because session basenames are unique tree-wide (verified live: 2762 files / 2762 unique
 * basenames, zero collisions). Resolution is EXACT-EQUALITY: the producer's own session lookup uses
 * `basename(...).includes(sel.sessionId)` — a SUBSTRING match that COLLIDES across the subagent
 * tier's long shared `agent-*` prefixes, after which the verify step would happily confirm the
 * WRONG file. Do not copy that idiom.
 */
export function buildTranscriptIndex(projectsRoot: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const p of walkFiles(projectsRoot, (p) => p.endsWith(".jsonl"))) {
    index.set(basename(p, ".jsonl"), p);
  }
  return index;
}

const KNOWN_FLAGS = new Set([
  "queue",
  "projects",
  "root",
  "out",
  "window",
  "dry-run",
  "json",
  "strict",
  "help",
]);

/**
 * Unknown-flag guard. A sibling tool inherits NOTHING from the harvester's own `KNOWN_FLAGS`
 * allowlist (good — zero merge collision), so it must own one or it silently accepts typos.
 * Value tokens are skipped so `--out --dry-run`-style mistakes are caught by `flagArg` below, and
 * a legitimate `--out --weird-looking-path` is not misread as a flag.
 */
export function unknownFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const name = a.slice(2).split("=")[0];
    if (!KNOWN_FLAGS.has(name)) out.push(a);
  }
  return out;
}

const VALUE_FLAGS = ["queue", "projects", "root", "out", "window"] as const;

/**
 * `core.flagValue` is VALUE-FLAG-BLIND: the space form returns `args[i + 1]` unconditionally, so
 * `--out --dry-run` yields `"--dry-run"` as the output path and the tool writes a file literally
 * named `--dry-run`. Reject a `--`-prefixed result as a USAGE error (exit 2) — never a silent
 * fallback to the default, which would be exactly the silent-wrong-answer class this story exists
 * to prevent. The unknown-flag guard does not rescue it: `--dry-run` IS a known flag.
 */
export function flagArg(argv: string[], name: string): { value?: string; error?: string } {
  const raw = flagValue(argv, name);
  if (raw === undefined) return {};
  if (raw.startsWith("--")) return { error: `--${name} expects a value, got the flag \`${raw}\`` };
  if (raw === "") return { error: `--${name} expects a non-empty value` };
  return { value: raw };
}

const HELP = `adr-generator — session transcript → structured ADR digest, with provenance to the line

  bun adr-generator.ts [options]
    --root <dir>       repo the default --out is anchored to (default ~/Dev/personal/std-public)
    --out <file>       ADR file to APPEND to    (default <root>/docs/DECISIONS.generated.md)
    --queue <dir>      candidate queue          (default <framework>/MEMORY/KNOWLEDGE/_harvest-queue)
    --projects <dir>   session transcripts root (default <claude-home>/projects)
    --window <n>       transcript lines of context either side of the cursor (default 6)
    --dry-run          compose and report, write NOTHING
    --json             the verdict array instead of markdown (one entry per queue file)
    --strict           exit 1 when anything needs a human (stale or malformed). Default: exit 0
    --help             this text

  The queue SELECTS (which sessions decided something, and where); the transcript COMPOSES (the
  reasoning). A candidate's own text is a 500-char truncated slice and is never ADR content.

  It only ever APPENDS, to a file it owns by default. Pedro's hand-written docs/DECISIONS.md is
  reachable ONLY via an explicit --out, never as a default.`;

/**
 * Resolve the home directory the framework/claude dirs derive from. `||`, deliberately NOT `??`:
 * an EMPTY `HOME` is as unusable as an absent one, and `??` would pass `""` straight through.
 */
export function resolveHome(envHome: string | undefined, fallback: string): string {
  return envHome || fallback;
}

/** Framework + claude dirs, mirroring the producer's own precedence (LIFEOS_DIR → PAI_DIR → derive). */
export function defaultDirs(home: string): { frameworkDir: string; claudeDir: string } {
  const frameworkDir = process.env.LIFEOS_DIR || process.env.PAI_DIR || join(home, ".claude", "PAI");
  return { frameworkDir, claudeDir: join(home, ".claude") };
}

export function main(argv: string[]): number {
  if (hasFlag(argv, "help")) {
    console.log(HELP);
    return 0;
  }

  const unknown = unknownFlags(argv);
  if (unknown.length) {
    log(`✗ unknown flag(s): ${unknown.join(", ")}\n\n${HELP}`);
    return 2;
  }
  const resolved: Record<string, string | undefined> = {};
  for (const name of VALUE_FLAGS) {
    const { value, error } = flagArg(argv, name);
    if (error) {
      log(`✗ ${error}`);
      return 2;
    }
    resolved[name] = value;
  }

  const home = resolveHome(process.env.HOME, homedir());
  const { frameworkDir, claudeDir } = defaultDirs(home);
  const root = resolve(resolved.root ?? join(home, "Dev/personal/std-public"));
  // ⚠ ABSOLUTE by construction. A bare `docs/DECISIONS.generated.md` is relative to NOTHING, so a
  // bare invocation from an arbitrary cwd would scatter stray `docs/` trees.
  const out = resolve(resolved.out ?? join(root, "docs", "DECISIONS.generated.md"));
  const queueDir = resolved.queue ?? join(frameworkDir, "MEMORY", "KNOWLEDGE", "_harvest-queue");
  const projectsRoot = resolved.projects ?? process.env.CLAUDE_PROJECTS_ROOT ?? join(claudeDir, "projects");

  let radius = 6;
  if (resolved.window !== undefined) {
    const n = Number(resolved.window);
    if (!Number.isInteger(n) || n < 0 || n > 200) {
      log(`✗ --window expects an integer between 0 and 200, got: ${resolved.window}`);
      return 2;
    }
    radius = n;
  }

  const dryRun = hasFlag(argv, "dry-run");
  const index = buildTranscriptIndex(projectsRoot);
  const report = buildReport(readQueue(queueDir), {
    existing: readIfExists(out) ?? "",
    readTranscript: (sessionId) => {
      const path = index.get(sessionId);
      return path === undefined ? null : readIfExists(path);
    },
    transcriptPath: (sessionId) => index.get(sessionId) ?? null,
    radius,
  });

  if (!dryRun) writeAdrs(report, out, queueDir, projectsRoot);

  if (hasFlag(argv, "json")) emitJson(report.verdicts);
  else console.log(renderHuman(report, out, dryRun));

  // Findings are INFORMATION, not failure — exit 0 by default even when ADRs were emitted.
  // `--strict` is the opt-in CI semantic: non-zero only when something actually needs a human.
  if (hasFlag(argv, "strict") && report.counts.stale + report.counts.malformed > 0) return 1;
  return 0;
}

/**
 * The ONLY writer. Additive by construction:
 *   • `writeIfAbsent` for the header — O_CREAT|O_EXCL, so it CANNOT overwrite an existing file
 *     (`atomicWrite` is deliberately not used anywhere in this tool: on an existing file it is
 *     exactly the clobber the never-rewrite rule forbids);
 *   • `appendIfMissing` per ADR — marker-gated atomic EOF concat, prior bytes preserved.
 *
 * `appendIfMissing` returning `false` here is a REDUNDANT RACE GUARD, not the `duplicate` detector
 * (that is the marker pre-check in `buildReport`, so the count is identical under `--dry-run`).
 * If it ever fires, something wrote the same cursor between our read and our append: the verdict is
 * downgraded so the bucket sum stays honest, and the race is logged rather than swallowed.
 */
export function writeAdrs(report: AdrReport, out: string, queueDir: string, projectsRoot: string): void {
  const emitted = report.verdicts.filter((v) => v.bucket === "emitted");
  if (!emitted.length) return;
  writeIfAbsent(out, renderHeader(queueDir, projectsRoot));
  for (const v of emitted) {
    if (!v.adr) continue;
    if (!appendIfMissing(out, v.adr.marker, renderAdr(v.adr))) {
      v.bucket = "duplicate";
      v.reason = "race: the cursor appeared in the out-file between the pre-check and the append";
      report.counts.emitted -= 1;
      report.counts.duplicate += 1;
      log(`⚠ ${v.adr.marker} appeared between pre-check and append — counted as duplicate`);
    }
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
