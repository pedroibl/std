// Story 8.1 (FR21) — the sprint/summary vocabulary: parse a BMAD `sprint-status.yaml`'s
// `development_status:` block into rows, and reduce those rows to a progress summary. Pure (D1/NFR1):
// zero node:*/fs/DOM/network, no process/document, no clock, no `yaml` import — the YAML text arrives
// as a `string` argument; the readFileSync stays at the edge.
//
// Harvested behaviour-faithfully from TWO real Obsidian consumers (AD-8 rule 4 — the Rule-of-Three
// that earns this promotion): the note-report vault's `dashkit.ts` dashboard engine and the zDrafts
// vault's `cn`-pattern. Their shared parse/summarize vocabulary is promoted DOWN into core rather than
// copied sideways between the two edges (AD-8). Each vault's own glue (CSS tokens, glyph maps, the
// project registry) stays caller-local and is NOT promoted.
//
// The 10-cell progress-bar geometry is NOT re-derived here — `bar` lives in `./bar` (promoted in Story
// 12.2, which named this story as its importer) and renderers/tests import it. This module owns only
// the status vocabulary, the parse, and the summary.
//
// ERROR MODEL — graceful-empty, never a throw, never a `Result`. This is the documented FR5 exception
// (same as `parse.ts`): a malformed or headerless sprint file is the EXPECTED case for a dashboard that
// renders whatever it can, so `parseStatusMap` degrades to `{}` and the row parsers to `[]` rather than
// throwing. Do not "fix" this into a throw or a Result union.
//
// BEHAVIOUR-FAITHFUL PORT (D-3). Three defects were measured by execution and are PINNED here, not
// fixed, so Story 8.2's migration onto this module stays a pure substitution with zero dashboard drift.
// Each is named in the docstring of the function it lives on and pinned by a `KNOWN GAP` test; see
// `_bmad-output/implementation-artifacts/deferred-work.md` §"Deferred from 8-1" for the un-defer
// triggers.

// ── status vocabulary ───────────────────────────────────────────────────────
// Exported (module-private in the origin) so a second edge stops re-declaring its own status sets.
// SCREAMING_CASE ReadonlySet, following the GLYPH/NO_ACTION precedent in severity.ts.

/** Statuses counted as shipped. */
export const SPRINT_DONE: ReadonlySet<string> = new Set(["done"]);
/** Statuses counted as in-flight (pending, not yet shipped). Enumerated NOWHERE in the epic/PRD AC. */
export const SPRINT_PROG: ReadonlySet<string> = new Set(["in-progress", "review", "ready-for-dev"]);
/** Terminal-but-not-shipped states: excluded from the bar math (neither done nor pending), reported
 *  separately as `closed`. FOUR members — `wont-do` is missing from every AC that enumerates this set. */
export const SPRINT_CLOSED: ReadonlySet<string> = new Set([
  "superseded",
  "cancelled",
  "wont-do",
  "deferred",
]);

export type SprintRow = { key: string; status: string };
export type SprintSummary = {
  total: number;
  done: number;
  prog: number;
  remaining: number;
  pct: number;
  closed: number;
};

// ── predicates ──────────────────────────────────────────────────────────────

/** Story rows: `N-M-…` (bare-digit segments only). KNOWN GAP G1 — a first segment that is not a bare
 *  digit run (e.g. `2-0a-…`) matches neither this nor `isOpsKey`, so those rows are silently dropped
 *  from every dashboard. See deferred-work.md §"Deferred from 8-1". */
export const isStoryKey = (k: string): boolean => /^\d+-\d+-/.test(k);
/** Out-of-epic operational rows: `ops-N-…`. */
export const isOpsKey = (k: string): boolean => /^ops-\d+-/.test(k);
export const isDone = (s: string): boolean => SPRINT_DONE.has(s);
export const isProg = (s: string): boolean => SPRINT_PROG.has(s);
export const isClosed = (s: string): boolean => SPRINT_CLOSED.has(s);

// ── parse ─────────────────────────────────────────────────────────────────────

/**
 * Parse every `key: value` under `development_status:` into a flat map (epics, stories, retros, ops).
 * Tolerates a trailing `# comment` after the value.
 *
 * Contract (graceful-empty, never a throw, never a Result — the FR5 exception, see the module header):
 *   - Missing `development_status:` header → `{}`.
 *   - Two headers → only the text BETWEEN the first two (`split(...)[1]`).
 *   - Duplicate keys → LAST wins (later line overwrites).
 *   - A trailing `# comment` after the value is tolerated and stripped.
 *   - Comment-only lines and box-drawing/`# ───` lines are skipped (no `key: value` match).
 *   - Column-0 keys inside the segment are ignored — a leading indent (tab or space, any depth) is
 *     required by the `^\s+` anchor.
 *   - CRLF is tolerated, but by ABSORPTION not by design: the `\s*` before `$` in the value regex eats
 *     the trailing `\r`. Do not "tidy" the `\s*` away — it is load-bearing for CRLF input.
 *   - Keys/values are NOT lower-cased. The `/i` flag makes the charset case-insensitive, so `DONE` is
 *     captured as-written; `SPRINT_DONE.has("DONE")` is then `false` (the sets are lower-case).
 *
 * KNOWN GAP G2 — the segment runs to EOF, not to the next column-0 key. A `development_status:` block
 * followed by e.g. `action_items:` leaks that block's indented `status: open` line into the map. Real:
 * std/gen-image/temporal-ai-bots all surface `map["status"] === "open"`. Harmless for
 * parseSprint/parseOps (`status` fails both key filters) but a `parseStatusMap` consumer is exposed.
 *
 * KNOWN GAP G3 — the value charset is `[a-z-]+`: no quotes, no digits. A quoted (`"done"` / `'done'`)
 * or digit-bearing (`done2`, `v2-done`) value fails the line regex and the whole row is silently
 * dropped. If a BMAD tool ever starts quoting statuses, the board empties with every gate green.
 */
export function parseStatusMap(raw: string): Record<string, string> {
  const seg = raw.split(/^development_status:\s*$/m)[1] || "";
  const map: Record<string, string> = {};
  for (const line of seg.split("\n")) {
    const m = line.match(/^\s+([a-z0-9][a-z0-9.-]*):\s*([a-z-]+)\s*(?:#.*)?$/i);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

/** Shared body of parseSprint/parseOps: the map's keys, filtered by `pred`, in file order
 *  (`Object.keys` insertion order). One definition — do not inline a second parse loop (the 9.5
 *  jaccard-reuses-tokenize rule). */
function parseRows(raw: string, pred: (k: string) => boolean): SprintRow[] {
  const map = parseStatusMap(raw);
  return Object.keys(map)
    .filter(pred)
    .map((key) => ({ key, status: map[key]! }));
}

/** Story rows only (`N-M-…`), in file order. Inherits G1 (see `isStoryKey`) and G2/G3 (see
 *  `parseStatusMap`). `epic-*` and `*-retrospective` keys land in the map and are excluded here. */
export function parseSprint(raw: string): SprintRow[] {
  return parseRows(raw, isStoryKey);
}

/** Out-of-epic operational rows (`ops-N-…`), in file order. Inherits G2/G3 (see `parseStatusMap`). */
export function parseOps(raw: string): SprintRow[] {
  return parseRows(raw, isOpsKey);
}

// ── summarize ─────────────────────────────────────────────────────────────────

/**
 * Reduce rows to a progress summary. `active` = rows whose status is not in `SPRINT_CLOSED`; the bar
 * math (`total`/`done`/`prog`/`remaining`/`pct`) is over `active`, and `closed` is the rest.
 *
 *   - `remaining = total - done - prog` is a DELIBERATE catch-all: any active status outside both
 *     `SPRINT_DONE` and `SPRINT_PROG` (e.g. `backlog`, `optional`, `open`) lands in `remaining`
 *     silently. This is intentional — do not "fix" it into an unknown-bucket or a throw.
 *   - `pct = round(done/total * 100)` uses `Math.round` (HALF-UP): `1/8 → 13`, `5/8 → 63`, and
 *     `199/200 → 100` while the sprint is NOT complete. That false-100 is the ported behaviour.
 *   - `total === 0 → pct 0` (guarded, no division).
 */
export function summarize(rows: SprintRow[]): SprintSummary {
  const active = rows.filter((r) => !isClosed(r.status));
  const total = active.length;
  const done = active.filter((r) => isDone(r.status)).length;
  const prog = active.filter((r) => isProg(r.status)).length;
  return {
    total,
    done,
    prog,
    remaining: total - done - prog,
    pct: total ? Math.round((done / total) * 100) : 0,
    closed: rows.length - active.length,
  };
}
