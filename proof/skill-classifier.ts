/**
 * skill-classifier — tag a mined candidate by the ARTIFACT it pertains to
 * ============================================================================
 * Epic 15, Story 15.3. A pure, disk-free classifier over one `MinedMemory` and
 * an INJECTED catalog, returning tags for the candidate's existing `tags` array
 * (`skill:<Name>` / `tool:<Name>`, or the first-class `unclassified`).
 *
 *   classifyArtifact(m: MinedMemory, catalog: Catalog): string[]
 *
 * ── WHY THIS EXISTS: THE ROUTER CURRENTLY HAS NO INPUT ──────────────────────
 * 15.2 routes a candidate to a skill/tool by `provenance.projectSlug` — which is
 * the SESSION'S CWD, slug-encoded (`harvester.ts` `discoverSessions`,
 * `basename(dirname(p))`), not an artifact identity. 15.2's first contact with a
 * populated queue measured the consequence: 80 candidates, six distinct slugs,
 * NOT ONE naming a tool or skill (three are `/private/tmp` throwaways) — an
 * honest unrouted rate of 100% (80/80). So this is not a precision upgrade
 * layered on a working router; it is the missing input to a router that cannot
 * route anything. The bar is correspondingly higher: beating a baseline of zero
 * is not the same as being useful, which is why the rate is REPORTED (AC2) and
 * why a wrong tag is treated as worse than no tag.
 *
 * ── THE SIGNAL, AND ITS CEILING, STATED HONESTLY (AC3) ──────────────────────
 * A mined candidate carries only: `content`/`context` (raw text slices, 500/300
 * chars), `project` (the cwd slug), `sourcePattern`, `confidence`, and the
 * provenance tuple. The ONLY artifact-bearing signal among them is a NAME
 * MENTION IN THE TEXT. That is the whole ceiling:
 *   • a mention can be truncated away by the 500-char slice → no match, and we
 *     deliberately do not half-guess a prefix;
 *   • a mention is not the same as pertaining to the artifact (see the frames
 *     below);
 *   • an artifact edited but never NAMED in prose is unreachable — that is the
 *     substrate gap Story 15.3 AC4 flags rather than fixes: the transcript's
 *     `Edit`/`Write` `tool_use` `file_path`s are discarded by the harvester's
 *     text-only content extractor before mining ever sees them.
 * MEASURED against real transcripts with a 59-skill/85-tool catalog: 38/396
 * classified (10%). That is a real move from the 100%-unrouted baseline and it is
 * still not enough — which is the gap note's whole point, stated as a number
 * rather than massaged.
 * `context` is not scanned separately: both are slices of the SAME text and
 * `context` (0..300) is a strict prefix of `content` (0..500), so scanning
 * `content` strictly dominates.
 *
 * ── THE DISCRIMINATOR: A SCAFFOLDING-FRAME DENY-LIST ────────────────────────
 * The most common thing a session transcript says about a skill is not a
 * learning about it — it is the harness echoing its own preamble, e.g. a leading
 * `Base directory for this skill: …/.claude/skills/<Name>`. A naive "does the
 * text mention a skill path?" heuristic tags every such candidate with a skill
 * from pure boilerplate. So the classifier strips known scaffolding frames from
 * the HEAD of the content and scans only what remains. Frames are matched at the
 * start (the payload may legitimately discuss a skill later, and it should still
 * win — see `stripScaffoldingFrames`).
 *
 * NOT USED, deliberately — `memoryType` as a co-signal. `MemoryType` has no
 * `correction` value (that lives on `HarvestedLearning.type`, the harvest path,
 * which never reaches the queue) and every queued candidate carries a
 * `memoryType` BY CONSTRUCTION (it is in the queue because it matched a
 * MINING_PATTERN_MAP regex), so it filters nothing — the echo passes it.
 *
 * ALSO NOT USED — re-running `CORRECTION_PATTERNS` over `content` as positive
 * evidence. It is genuinely available (those patterns run only in
 * `extractLearnings`, never on the mine path) and was considered, but it gates
 * on "is this a correction?", not "which artifact is this about?" — it would cut
 * recall on decisions/preferences/milestones without improving precision on the
 * echo, which the frame deny-list already rejects on its FRAME rather than its
 * content type. Left as available headroom, not adopted.
 *
 * ── D4 / NFR3 ──────────────────────────────────────────────────────────────
 * No skill name, tool name, or estate path is baked in. The catalog is injected
 * DATA (`--catalog <file>`, `{skills:[…],tools:[…]}`), mirroring 15.2's `--map`
 * and `brain-check.ts`'s `arg()` idiom. This file lives in std-public `proof/`
 * as a std CONSUMER — never library surface, so nothing here reaches `src/**`.
 */

import type { MinedMemory } from "./harvester";

// ============================================================================
// CONTRACT
// ============================================================================

export type ArtifactKind = "skill" | "tool";

export interface CatalogEntry {
  name: string;
  kind: ArtifactKind;
}

/** Injected DATA — never baked (D4/NFR3). */
export type Catalog = readonly CatalogEntry[];

/** The tag emitted when nothing can be attributed. A FIRST-CLASS outcome (AC2). */
export const UNCLASSIFIED = "unclassified";

/**
 * Scaffolding frames, matched ONLY at the head of the content.
 *
 * Order matters: each terminated tag-block pattern is tried before its
 * unterminated twin, so a complete `<system-reminder>…</system-reminder>` is
 * stripped as a unit while a block cut open by the miner's 500-char slice
 * consumes the rest. Consuming the rest is the CONSERVATIVE direction: we cannot
 * see where the frame ends, so we refuse to attribute anything after it rather
 * than guess an artifact (AC2 — a wrong tag is worse than none).
 */
const SCAFFOLD_TAGS = [
  "system-reminder",
  "task-notification",
  "command-message",
  "command-name",
  "command-args",
  "command-contents",
  "local-command-stdout",
];

const SCAFFOLD_FRAMES: RegExp[] = [
  // The observed headline: a LEADING `Base directory for this skill: <path>` line.
  // Case-insensitive to match the estate sibling (`harvest-backup-positive.ts`,
  // the `/i` skip-filter): the harness's casing is not a contract, and a
  // lower-cased echo minted the same false `skill:` tag.
  /^Base directory for this [^\n:]*:[^\n]*(?:\n|$)/i,
  /^Launching skill:[^\n]*(?:\n|$)/i,
  // A LEADING `ARGUMENTS:` line is the harness echoing the invocation's args —
  // the names in it are what was CALLED, not what the learning is ABOUT. Only
  // the line is consumed, so the payload beneath it still classifies.
  /^ARGUMENTS:[^\n]*(?:\n|$)/i,
  // A LEADING slash-command invocation line (`/bmad-help`, `/code-review …`).
  // The command token must END at whitespace or EOL — WITHOUT that the pattern
  // eats the first line of any candidate beginning with a lower-cased absolute
  // path, and 15.2 measured three real `/private/tmp/…` slugs in the live queue.
  /^[ \t]*\/[a-z][A-Za-z0-9._-]*(?:[ \t][^\n]*)?(?:\n|$)/,
  // Harness tag blocks — terminated first, then the truncated form.
  new RegExp(`^<(${SCAFFOLD_TAGS.join("|")})>[\\s\\S]*?</\\1>[ \\t]*(?:\\n|$)`),
  new RegExp(`^<(?:${SCAFFOLD_TAGS.join("|")})>[\\s\\S]*$`),
];

// ============================================================================
// AC3 — the deny-list
// ============================================================================

/**
 * Strip known scaffolding frames from the HEAD of `content`, repeatedly (real
 * transcripts stack them: a `<command-message>` then the skill preamble).
 *
 * Anchored at the start on purpose. A frame phrase appearing mid-payload is
 * PROSE — a learning may legitimately quote the boilerplate it is complaining
 * about — and stripping it there would delete the payload it belongs to.
 */
export function stripScaffoldingFrames(content: string): string {
  let rest = content.trimStart();
  for (let guard = 0; guard < 32; guard++) {
    const before = rest;
    for (const frame of SCAFFOLD_FRAMES) {
      const hit = frame.exec(rest);
      if (hit) {
        rest = rest.slice(hit[0].length).trimStart();
        break;
      }
    }
    if (rest === before) break;
  }
  return rest.trim();
}

// ============================================================================
// AC1 / AC2 — the classifier
// ============================================================================

/**
 * Boundary-aware, case-SENSITIVE mention test.
 *
 * `\b` is wrong here: catalogued names contain `-` and `_` (`bmad-agent-dev`,
 * `_CreateStdTool`), and `\b` treats `-` as a boundary — so `std` would match
 * inside `std-public`, the exact prefix trap that mis-routes three real slugs in
 * 15.2. The lookarounds below exclude `-` and `_` as well as word chars, while
 * still allowing `/`, `.`, and whitespace to delimit a name (so
 * `~/.claude/skills/_CreateStdTool/SKILL.md` and `PAI/TOOLS/X.ts` both match).
 */
function mentions(payload: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(payload);
}

/**
 * The story's deliverable: `(m: MinedMemory, catalog) → string[]`.
 *
 * Typed over `MinedMemory`, NOT over the queue candidate — at the classification
 * seam (inside the mined loop, before the dry-run gate) the queue candidate does
 * not exist yet, and its `content` is a rewritten markdown blob rather than the
 * raw sliced text this matches against.
 *
 * Returns `[UNCLASSIFIED]` — never `[]` — so every candidate carries exactly one
 * terminal outcome and the counts always sum.
 */
export function classifyArtifact(m: MinedMemory, catalog: Catalog): string[] {
  const payload = stripScaffoldingFrames(m.content);
  if (!payload) return [UNCLASSIFIED];

  const tags = new Set<string>();
  for (const entry of catalog) {
    if (mentions(payload, entry.name)) tags.add(`${entry.kind}:${entry.name}`);
  }
  if (tags.size === 0) return [UNCLASSIFIED];
  return [...tags].sort();
}

/** True when a tag set represents a real attribution (not the unclassified bucket). */
export function isClassified(tags: readonly string[]): boolean {
  return tags.length > 0 && !tags.includes(UNCLASSIFIED);
}

// ============================================================================
// AC2 — the rate report (and its confidence-band breakdown)
// ============================================================================

export interface BandCount {
  total: number;
  classified: number;
}

export interface ClassificationStats {
  total: number;
  classified: number;
  unclassified: number;
  /** Keyed by rendered confidence band (`"30%"`), insertion-ordered. */
  byBand: Record<string, BandCount>;
}

export function emptyStats(): ClassificationStats {
  return { total: 0, classified: 0, unclassified: 0, byBand: {} };
}

/**
 * Render a confidence as its display band.
 *
 * ⚠ Never compare a mined confidence with `=== 0.3`. The dominant band is
 * produced by `0.2 + 0.1`, which in IEEE754 is `0.30000000000000004`. The
 * harvester's own console render already goes through `(c*100).toFixed(0)`, so
 * this matches it exactly and the two reports agree.
 */
export function bandOf(confidence: number): string {
  return `${(confidence * 100).toFixed(0)}%`;
}

export function recordClassification(
  stats: ClassificationStats,
  m: MinedMemory,
  tags: readonly string[],
): void {
  const hit = isClassified(tags);
  stats.total++;
  if (hit) stats.classified++;
  else stats.unclassified++;

  const band = bandOf(m.confidence);
  const bucket = (stats.byBand[band] ??= { total: 0, classified: 0 });
  bucket.total++;
  if (hit) bucket.classified++;
}

/**
 * The honest measure of whether this story delivered its "so that 15.2 can route
 * precisely" promise. Broken down by confidence band because the input itself is
 * suspect: a single weak pattern hit on a >200-char message lands on exactly the
 * minimum admissible score, and 80% of the live queue sits in that band. If
 * classification is poor there and fine above it, the dominant failure is the
 * INPUT, not the routing — see the gap note. This is a number to surface, not
 * one to massage.
 */
export function renderClassificationReport(stats: ClassificationStats): string[] {
  const pct = stats.total === 0 ? 0 : Math.round((stats.classified / stats.total) * 100);
  const out = [
    "",
    `\u{1F3F7}\u{FE0F}  Artifact classification: classified ${stats.classified}/${stats.total} (${pct}%), unclassified ${stats.unclassified}`,
  ];
  for (const [band, count] of Object.entries(stats.byBand)) {
    out.push(`   confidence ${band}: ${count.classified}/${count.total}`);
  }
  return out;
}

// ============================================================================
// Catalog injection — parsing the injected DATA
// ============================================================================

function readNames(source: Record<string, unknown>, key: string): string[] {
  const raw = source[key];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`catalog: \`${key}\` must be an array of names`);
  return raw.map((n) => {
    if (typeof n !== "string") throw new Error(`catalog: \`${key}\` must contain only strings`);
    if (n.trim() === "") throw new Error(`catalog: \`${key}\` contains an empty name`);
    return n.trim();
  });
}

/**
 * Parse the injected catalog document `{ "skills": [...], "tools": [...] }`.
 *
 * FAIL-LOUD on a wrong shape (FR5). A silently-empty catalog would classify
 * nothing and report an honest-looking 0% rate — indistinguishable from "the
 * signal isn't there", which is precisely the conclusion this story exists to
 * measure. A malformed catalog must never be able to fake that finding.
 */
export function parseCatalog(doc: unknown): Catalog {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("catalog: expected an object of the shape { skills: [...], tools: [...] }");
  }
  const source = doc as Record<string, unknown>;
  // A MISNAMED key (`skill`/`tool` for `skills`/`tools`) is the one malformed
  // shape that survives every check below: unknown keys are ignored, both known
  // keys read as absent, and the run reports an honest-looking 0% with every
  // candidate `unclassified` — the exact shape of "the signal isn't there",
  // which is the finding this story exists to measure. So: a document that
  // carries keys but NEITHER known key is an error, not an empty catalog.
  // `{}` stays legal (a deliberately empty catalog asserts nothing).
  const keys = Object.keys(source);
  if (keys.length > 0 && !("skills" in source) && !("tools" in source)) {
    throw new Error(
      `catalog: no \`skills\` or \`tools\` key (found: ${keys.join(", ")}) — a misnamed key would silently classify nothing`,
    );
  }
  return [
    ...readNames(source, "skills").map((name): CatalogEntry => ({ name, kind: "skill" })),
    ...readNames(source, "tools").map((name): CatalogEntry => ({ name, kind: "tool" })),
  ];
}
