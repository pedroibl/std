#!/usr/bin/env bun
/**
 * gotchas-promoter — the MEMORY→`Gotchas` bridge  (Epic 15, Story 15.2)
 * ============================================================================
 * Reads the harvester's candidate queue, routes each candidate to the skill/tool
 * artifact its session pertained to, locates that artifact's `Gotchas` section,
 * and REPORTS the pair to a human with full `file:line` provenance.
 *
 *   bun gotchas-promoter.ts [--queue <dir>] [--map <file>] [--min-confidence <n>]
 *                           [--json] [--strict] [--help]
 *
 * ── THE HEADLINE INVARIANT: THIS TOOL NEVER EDITS A SKILL ────────────────────
 * It reports candidates; a human applies them. There is deliberately NO apply /
 * patch mode, no matter how well-guarded — a skill's instructions are load-bearing
 * and a bad automatic edit is worse than a missing one (and a REMOVED skill is
 * worse still, so deletion is equally out). Everything this tool produces goes to
 * stdout. It touches the filesystem for READS only:
 *   • `walkFiles` + `readIfExists` (std/fsx) — the queue, the map, the artifacts
 * and it imports no module capable of mutating the disk. Two gates back that up:
 *   • the story's AC4 grep (a cheap TRIPWIRE over names), and
 *   • the real proof — `gotchas-promoter.test.ts` hashes a fixture skills tree
 *     before and after a full run and asserts byte-identity. A name-grep can never
 *     prove absence of mutation; a tree hash catches an edited AND a vanished file.
 * If you are extending this tool: the hash test is the contract. Keep it green.
 *
 * ── THE ROUTING MAP IS LOSSY BY CONSTRUCTION ─────────────────────────────────
 * `provenance.projectSlug` is the SESSION'S CWD, slug-encoded — not a skill
 * identity. A session that corrects the `_CreateStdTool` skill while sitting in
 * `~/Dev/personal/std` is stamped with the std repo's slug. So routing here is a
 * coarse, honest heuristic with a first-class `unrouted` bucket whose count is the
 * measure of how lossy it is. Story 15.3 sharpens the signal (it tags candidates by
 * the tool/skill they pertain to) and swaps in behind this same report.
 *
 * Matching is EXACT, never substring/prefix: three real slugs in Pedro's tree are
 * prefixes of one another (`…-personal-std`, `…-personal-std-public`,
 * `…-personal-std--bmad-output`), so a prefix match mis-routes all three to one
 * artifact. `projectLabel` is a DISPLAY inverse only and is lossy even at that
 * (it cannot tell `_` from `.`) — never route on it.
 *
 * ── SUBSTRATE ───────────────────────────────────────────────────────────────
 *   std/core   flagValue / hasFlag (CLI) · findSection (the Gotchas anchor)
 *   std/fsx    walkFiles (queue discovery) · readIfExists · resolveFrameworkDir
 *   std/report lines (human render) · emitJson / log (the --json contract)
 *
 * `Provenance` is IMPORTED as a type from the harvester (exported there since
 * Story 15.1) rather than re-declared — one contract, one definition. It is a
 * `type`-only specifier, so it erases at build time and this tool carries no
 * runtime coupling to the producer: it still runs when the harvester is broken
 * (the dependency-free discipline inherited from `brain-check.ts`).
 *
 * DEV NOTE: lives in std-public `proof/` as a std CONSUMER (never library surface,
 * so not under src/**). Production home is ~/.claude/PAI/TOOLS/; the live deploy is
 * a later Epic-17 batch step, not part of this story.
 */

import { findSection, flagValue, hasFlag } from "std/core";
import { readIfExists, resolveFrameworkDir, walkFiles } from "std/fsx";
import { emitJson, lines, log } from "std/report";

import type { Provenance } from "./harvester";

import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// CONTRACT
// ============================================================================

/**
 * The five TERMINAL buckets. Every queue file lands in exactly one, and the counts
 * sum to the queue file count — that sum is the proof nothing was silently dropped.
 */
export type Bucket = "malformed" | "filtered" | "unrouted" | "no-target-section" | "routed";

/**
 * Bucket PRECEDENCE, first match wins. `malformed` MUST be first (you cannot read a
 * `confidence` off an unvalidated shape) and `no-target-section` necessarily follows
 * resolution. Recorded here so "exactly one of five" is well-defined.
 *
 * KNOWN COST, disclosed rather than hidden: `filtered` sits AHEAD of `unrouted`, so
 * whenever `--min-confidence` is on, an unmatched-slug candidate below the threshold
 * is absorbed into `filtered` and the `unrouted` count under-reports — degrading the
 * very metric Story 15.3 needs. Mitigation: `unrouted` is also emitted as a
 * NON-terminal co-tag (`Verdict.unroutedCoTag`), counted in `Report.unroutedCoTagged`
 * and surfaced wherever the unrouted rate is printed.
 */
export const PRECEDENCE: readonly Bucket[] = ["malformed", "filtered", "unrouted", "no-target-section", "routed"];

/**
 * Heading probe — the depths to try. `findSection` matches a LITERAL heading at a fixed
 * `#`-depth, but real skills vary: probing only `"## Gotchas"` would report `no-target-section`
 * for every `### Gotchas` skill — a false negative indistinguishable from the genuine ~16% of
 * skills that have no such section, silently corrupting the counts. These three cover 100% of
 * the live census (47×`##`, 1×`###`, no `####+`).
 *
 * ORDER IS NOT PRECEDENCE. `locateGotchas` resolves by EARLIEST POSITION IN THE FILE, not by
 * this array's order — a `### Gotchas` above a later `## Gotchas` wins. The list is a set of
 * depths to look for; nothing reads its ordering. (It was probe-order-wins until the 15.2 code
 * review; the array is unchanged, only the resolution rule moved, so do not read precedence
 * back into it.)
 */
export const HEADINGS: readonly string[] = ["## Gotchas", "### Gotchas", "# Gotchas"];

/** `projectSlug` → artifact path. Injected DATA (a JSON file), never baked in (D4/NFR3). */
export type SlugMap = Record<string, string>;

/** One queue file as read from disk. `raw === null` means it vanished between walk and read. */
export interface PromoterInput {
  file: string;
  raw: string | null;
}

/** The shape a queue candidate must actually have on disk before anything downstream reads it. */
export interface Candidate {
  provenance: Provenance;
  confidence: number;
  content: string;
}

export interface Verdict {
  /** The terminal bucket (exactly one, per PRECEDENCE). */
  bucket: Bucket;
  /** The queue file this verdict is about. */
  file: string;
  /** Why, for `malformed`: `missing` | `unparseable` | `bad-shape`. */
  reason?: string;
  slug?: string;
  confidence?: number;
  content?: string;
  provenance?: Provenance;
  /** The mapped artifact — set for `routed` and `no-target-section`. */
  artifact?: string;
  /** The heading that matched, e.g. `"### Gotchas"` — records the depth. */
  heading?: string;
  /** 1-based LINE of the `Gotchas` heading (derived; `findSection` yields char offsets). */
  anchorLine?: number;
  /** NON-terminal: the slug was unmatched but a higher-precedence bucket claimed it. */
  unroutedCoTag?: boolean;
}

export interface Report {
  /** Queue file count — `counts` must sum to this. */
  total: number;
  counts: Record<Bucket, number>;
  /** The applied threshold, or `null` when the filter is OFF (the default). */
  minConfidence: number | null;
  /** How many candidates had an unmatched slug absorbed by a higher-precedence bucket. */
  unroutedCoTagged: number;
  verdicts: Verdict[];
}

// ============================================================================
// PURE CORE — zero disk. `readArtifact` is injected so routing is unit-testable.
// ============================================================================

/**
 * RUNTIME shape guard. `JSON.parse` hands back `any`; the disk is not bound by our types,
 * so a parseable-but-wrong-shaped file (`{}`, `[]`, `"x"`) would sail through a cast and
 * then throw a TypeError the moment something reads `provenance.projectSlug`.
 *
 * It guards EVERY field a downstream consumer reads — not just the routing key. A partial
 * guard accepts `{provenance:{projectSlug:"s"}}` and the report then prints
 * `sessionId=undefined sourceLine=undefined`, defeating the whole point ("the human can
 * open the exact source line"). Do not trim this as redundant.
 */
export function isCandidate(value: unknown): value is Candidate {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  const p = c.provenance;
  if (typeof p !== "object" || p === null) return false;
  const prov = p as Record<string, unknown>;
  return (
    typeof prov.projectSlug === "string" &&
    typeof prov.sessionId === "string" &&
    typeof prov.sourceLine === "number" &&
    Number.isInteger(prov.sourceLine) &&
    prov.sourceLine > 0 &&
    typeof prov.timestamp === "string" &&
    typeof c.confidence === "number" &&
    !Number.isNaN(c.confidence) &&
    c.confidence >= 0 &&
    c.confidence <= 1 &&
    typeof c.content === "string"
  );
}

/**
 * Locate the artifact's `Gotchas` section and return its 1-based LINE plus the heading depth
 * that matched. `null` when the artifact is unreadable or has no such section (both are the
 * real, common `no-target-section` case — never a crash, never an invented section).
 *
 * `findSection` returns CHARACTER OFFSETS (`SectionBounds{start,bodyStart,bodyEnd}`), not
 * line numbers, and nothing in `core` converts them — so the line is derived here. Reporting
 * `bounds.start` as a line would emit a plausible-looking wrong anchor.
 *
 * RESOLUTION RULE (changed by the 15.2 code review): every depth in `HEADINGS` is probed and the
 * EARLIEST match in the file wins — not the first depth that happens to hit. Probe-order-wins let
 * a `## Gotchas` far down the file beat a `### Gotchas` near the top, which is the wrong anchor to
 * hand a human. Known trade-off, recorded rather than hidden: a `### Gotchas` SUBSECTION nested
 * under some earlier `##` now outranks the document's own top-level `## Gotchas`. That is
 * unreachable in the live population (no skill carries two Gotchas headings — 47×`##` + 1×`###`,
 * disjoint), so this buys correctness on the reviewer's case at no measured cost. If a skill ever
 * grows both, revisit: the right rule then is probably "shallowest depth, earliest among equals".
 */
export function locateGotchas(
  artifact: string,
  readArtifact: (path: string) => string | null,
): { heading: string; anchorLine: number } | null {
  const body = readArtifact(artifact);
  if (body === null) return null;
  let earliest: { heading: string; start: number } | null = null;
  for (const heading of HEADINGS) {
    const bounds = findSection(body, heading);
    if (bounds) {
      if (earliest === null || bounds.start < earliest.start) {
        earliest = { heading, start: bounds.start };
      }
    }
  }
  if (earliest) {
    return { heading: earliest.heading, anchorLine: body.slice(0, earliest.start).split("\n").length };
  }
  return null;
}

/**
 * Route every queue input into exactly one terminal bucket. PURE — the only disk contact is
 * the injected `readArtifact`, so the whole routing decision is unit-testable with no disk.
 */
export function buildReport(
  inputs: PromoterInput[],
  map: SlugMap,
  opts: { readArtifact: (path: string) => string | null; minConfidence?: number | null },
): Report {
  const minConfidence = opts.minConfidence ?? null;
  const verdicts: Verdict[] = [];

  for (const input of inputs) {
    // ── 1. malformed (highest precedence) — a vanished file folds in here with reason
    //       `missing`; it is NOT a sixth bucket.
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

    const { provenance, confidence, content } = parsed;
    const slug = provenance.projectSlug;
    const artifact = Object.hasOwn(map, slug) ? map[slug] : undefined; // EXACT match — never a prefix
    const base: Verdict = { bucket: "routed", file: input.file, slug, confidence, content, provenance };

    // ── 2. filtered — before `unrouted` (see PRECEDENCE), so an unmatched slug absorbed
    //       here is co-tagged rather than silently lost from the unrouted rate.
    if (minConfidence !== null && confidence < minConfidence) {
      verdicts.push({ ...base, bucket: "filtered", ...(artifact === undefined ? { unroutedCoTag: true } : { artifact }) });
      continue;
    }

    // ── 3. unrouted — the honest measure of how lossy the cwd-slug heuristic is.
    if (artifact === undefined) {
      verdicts.push({ ...base, bucket: "unrouted" });
      continue;
    }

    // ── 4/5. no-target-section vs routed.
    const anchor = locateGotchas(artifact, opts.readArtifact);
    if (anchor === null) {
      verdicts.push({ ...base, bucket: "no-target-section", artifact });
      continue;
    }
    verdicts.push({ ...base, bucket: "routed", artifact, heading: anchor.heading, anchorLine: anchor.anchorLine });
  }

  const counts: Record<Bucket, number> = { malformed: 0, filtered: 0, unrouted: 0, "no-target-section": 0, routed: 0 };
  for (const v of verdicts) counts[v.bucket] += 1;

  return {
    total: inputs.length,
    counts,
    minConfidence,
    unroutedCoTagged: verdicts.filter((v) => v.unroutedCoTag === true).length,
    verdicts,
  };
}

// ============================================================================
// RENDER — human markdown. Reports; never applies.
// ============================================================================

const pct = (c: number): string => `${(c * 100).toFixed(0)}%`;

/**
 * Group routed candidates by artifact, worst-confidence LAST.
 *
 * Confidence is rendered per candidate ON PURPOSE. The mine path currently yields mostly
 * low-confidence prompt echoes, and the report must make that noise VISIBLE to the reviewer
 * rather than launder it into clean-looking markdown. Flag, don't fix — the input-quality
 * repair belongs to Story 15.3.
 */
export function renderHuman(report: Report): string {
  const { p, toString } = lines();
  p("# Gotchas candidates (review required — nothing was applied)");
  p();
  p(`${report.total} candidates in the queue.`);
  p();
  p(
    `- routed: ${report.counts.routed} · unrouted: ${report.counts.unrouted} · no-target-section: ${report.counts["no-target-section"]} · malformed: ${report.counts.malformed} · filtered: ${report.counts.filtered}`,
  );
  if (report.minConfidence !== null) {
    p(`- min-confidence filter APPLIED at ${report.minConfidence} (default is OFF).`);
    p(
      `  ⚠ \`filtered\` outranks \`unrouted\`, so the unrouted count under-reports while the filter is on: ${report.unroutedCoTagged} candidate(s) with an unmatched slug were absorbed into \`filtered\` and are co-tagged below.`,
    );
  }
  p();

  const routed = report.verdicts.filter((v) => v.bucket === "routed");
  if (routed.length > 0) {
    p("## Routed — a human applies these, this tool does not");
    p();
    const byArtifact = new Map<string, Verdict[]>();
    for (const v of routed) {
      const key = v.artifact ?? "";
      const bucket = byArtifact.get(key);
      if (bucket) bucket.push(v);
      else byArtifact.set(key, [v]);
    }
    for (const [artifact, group] of byArtifact) {
      // Worst LAST — the noise stays visible instead of leading.
      group.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
      p(`### ${artifact}`);
      p();
      for (const v of group) {
        p(`- **${artifact}:${v.anchorLine}** (\`${v.heading}\`) — ${pct(v.confidence ?? 0)} confidence`);
        p(`  - ${oneLine(v.content ?? "")}`);
        p(`  - provenance: session \`${v.provenance?.sessionId}\` · line ${v.provenance?.sourceLine} · ${v.provenance?.timestamp} · project \`${v.provenance?.projectSlug}\``);
      }
      p();
    }
  }

  section(p, report, "no-target-section", "No `Gotchas` section — the artifact resolved, the anchor did not", (v) =>
    `- ${v.artifact} — ${pct(v.confidence ?? 0)} · slug \`${v.slug}\` · session \`${v.provenance?.sessionId}\` line ${v.provenance?.sourceLine}`,
  );
  section(p, report, "unrouted", "Unrouted — no artifact for this slug (the cwd-slug heuristic is lossy; see 15.3)", (v) =>
    `- slug \`${v.slug}\` — ${pct(v.confidence ?? 0)} · session \`${v.provenance?.sessionId}\` line ${v.provenance?.sourceLine}`,
  );
  section(p, report, "filtered", "Filtered by --min-confidence (reported, never dropped)", (v) =>
    `- slug \`${v.slug}\`${v.unroutedCoTag === true ? " *(co-tagged: unrouted)*" : ""} — ${pct(v.confidence ?? 0)} · session \`${v.provenance?.sessionId}\` line ${v.provenance?.sourceLine}`,
  );
  section(p, report, "malformed", "Malformed queue files (skipped and reported, never a crash)", (v) =>
    `- ${v.file} — ${v.reason}`,
  );

  return toString();
}

function section(
  p: (line?: string) => void,
  report: Report,
  bucket: Bucket,
  title: string,
  row: (v: Verdict) => string,
): void {
  const group = report.verdicts.filter((v) => v.bucket === bucket);
  if (group.length === 0) return;
  p(`## ${title} (${group.length})`);
  p();
  for (const v of group) p(row(v));
  p();
}

/**
 * Flatten a candidate's text to one line. Candidate content is transcript-derived and may carry
 * newlines; interpolated verbatim it would forge headings and detach a provenance sub-bullet
 * from its entry — breaking the provenance-to-the-line guarantee. Truncated so a 500-char slice
 * does not swamp the report.
 */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat;
}

// ============================================================================
// EDGE — disk reads, argv, stdout. Every path is injected via a flag (brain-check's
// `arg()` shape), implemented with `core.flagValue` so `--k=v` works too.
// ============================================================================

/** Read the queue: every `.json` file under `queueDir`, path-sorted so the report is deterministic. */
export function readQueue(queueDir: string): PromoterInput[] {
  // `walkFiles` is fail-soft on a missing root (→ []), which is exactly the runs-degraded contract.
  const files = walkFiles(queueDir, (path) => path.endsWith(".json")).sort();
  // `readIfExists` (not `loadJson`): the caller must distinguish missing / malformed / valid, and
  // `loadJson` collapses the first two into its fallback with no way to tell them apart.
  return files.map((file) => ({ file, raw: readIfExists(file) }));
}

/**
 * Load the injected `projectSlug`→artifact map.
 *
 * A MISSING map is a legitimate cold-start: empty map, `present:false`, everything reports as
 * `unrouted`. A PRESENT-but-broken map is NOT softened — routing nothing while claiming a clean
 * run would make the report lie about the queue (fail-loud, FR5).
 */
export function loadMap(mapPath: string): { map: SlugMap; present: boolean } {
  const raw = readIfExists(mapPath);
  if (raw === null) return { map: Object.create(null), present: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`unparseable routing map: ${mapPath}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`routing map must be a JSON object of slug → artifact path: ${mapPath}`);
  }
  const map: SlugMap = Object.create(null);
  for (const [slug, artifact] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof artifact !== "string") {
      throw new Error(`routing map entry "${slug}" must be a string artifact path: ${mapPath}`);
    }
    if (artifact === "") {
      throw new Error(`routing map entry "${slug}" cannot be an empty path: ${mapPath}`);
    }
    map[slug] = artifact;
  }
  return { map, present: true };
}

const HELP = `gotchas-promoter — surface mined learnings as reviewable Gotchas candidates

  bun gotchas-promoter.ts [options]
    --queue <dir>            candidate queue      (default <framework>/MEMORY/KNOWLEDGE/_harvest-queue)
    --map <file>             slug → artifact map  (default <framework>/MEMORY/KNOWLEDGE/gotchas-map.json)
    --min-confidence <n>     drop candidates below n (0-1). OFF by default; always reported when applied
    --json                   the verdict array instead of markdown (one entry per queue file)
    --strict                 exit 1 when anything needs a human (routed or malformed). Default: exit 0
    --help                   this text

  It REPORTS candidates and never edits a skill. Applying one is a human's job, by design.`;

/**
 * Resolve the home directory the framework dir is derived from.
 *
 * `||`, deliberately NOT `??`: an EMPTY `HOME` is as unusable as an absent one, and `??` would
 * happily pass `""` through — `resolveFrameworkDir("")` then builds relative paths off the process
 * cwd and the tool silently reports "0 candidates" against the wrong tree. Extracted as a named
 * function purely so that distinction is testable; it has no other seam.
 */
export function resolveHome(envHome: string | undefined, fallback: string): string {
  return envHome || fallback;
}

export function main(argv: string[]): number {
  if (hasFlag(argv, "help")) {
    console.log(HELP);
    return 0;
  }

  const home = resolveHome(process.env.HOME, homedir());
  const frameworkDir = resolveFrameworkDir(home);
  const queueDir = flagValue(argv, "queue") ?? join(frameworkDir, "MEMORY", "KNOWLEDGE", "_harvest-queue");
  const mapPath = flagValue(argv, "map") ?? join(frameworkDir, "MEMORY", "KNOWLEDGE", "gotchas-map.json");

  const rawMin = flagValue(argv, "min-confidence");
  let minConfidence: number | null = null;
  if (rawMin !== undefined) {
    const n = Number(rawMin);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      log(`✗ --min-confidence expects a number between 0 and 1, got: ${rawMin}`);
      return 2;
    }
    minConfidence = n;
  }

  let map: SlugMap;
  let mapPresent: boolean;
  try {
    ({ map, present: mapPresent } = loadMap(mapPath));
  } catch (err) {
    log(`✗ ${(err as Error).message}`);
    return 2;
  }
  if (!mapPresent) log(`ℹ no routing map at ${mapPath} — every candidate will report as unrouted`);

  const report = buildReport(readQueue(queueDir), map, { readArtifact: readIfExists, minConfidence });

  // AC5: `--json` emits the CANDIDATE ARRAY (each with provenance + routing verdict) — not the
  // wrapper. Nothing is lost: `total` is the array length, the five bucket counts and the
  // `unroutedCoTagged` figure are recomputable from `bucket`/`unroutedCoTag` per entry, and the
  // bucket-sum invariant AC2 demands is therefore still provable by a machine consumer.
  if (hasFlag(argv, "json")) emitJson(report.verdicts);
  else console.log(renderHuman(report));

  // AC5: candidates are INFORMATION, not failure — exit 0 by default even when the queue is full.
  // `--strict` is the opt-in CI semantic: non-zero when something actually needs a human.
  if (hasFlag(argv, "strict") && report.counts.routed + report.counts.malformed > 0) return 1;
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
