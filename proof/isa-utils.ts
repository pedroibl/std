// VENDORED for the Story 12.5 proof harness — a subset copy of
// ~/.claude/hooks/lib/isa-utils.ts (only the ISC-criteria-list parser `checkpoint.ts` needs) so
// `proof/checkpoint.ts` type-checks and self-tests hermetically inside std-public CI (which has no
// ~/.claude tree).
//
// The PRODUCTION checkpoint tool at ~/.claude/PAI/TOOLS/Checkpoint.ts imports the REAL shared module
// by relative path (`../../hooks/lib/isa-utils`) — this copy exists ONLY for the proof. Kept
// byte-identical to the source subset it mirrors; it is the one real shared edge dependency (D4) and
// stays in the tool, never in std/src (same vendoring pattern as `proof/learning-utils.ts`, Story 11.1).

// ── Criteria section parsing ──────────────────────────────────────────────
//
// One canonical regex, centralized. Matches every historical heading variant:
//   ## Criteria
//   ## ISC Criteria
//   ## IDEAL STATE CRITERIA (Verification Criteria)
//     ### Criteria               (sub-heading inside IDEAL STATE block)
// Case-insensitive. Section ends at the next `## ` (H2) heading, `---`, or EOF.
export const CRITERIA_HEADING_RE =
  /^(?:##\s+(?:ISC\s+)?Criteria\b[^\n]*|##\s+IDEAL\s+STATE\s+CRITERIA\b[^\n]*|###\s+Criteria\b[^\n]*)$/im;

// Returns the criteria-section body (without the heading line), or null if no
// recognized heading was found.
export function extractCriteriaSection(content: string): string | null {
  const headingMatch = CRITERIA_HEADING_RE.exec(content);
  if (!headingMatch || headingMatch.index === undefined) return null;
  const startOfBody = headingMatch.index + headingMatch[0].length;
  const rest = content.slice(startOfBody);
  // End at the next H2 (`## ` but not `### `), a YAML doc terminator, or EOF.
  const endMatch = rest.match(/\n##\s+(?!#)|\n---\s*\n/);
  const body = endMatch ? rest.slice(0, endMatch.index) : rest;
  return body;
}

export interface CriterionEntry {
  id: string;
  description: string;
  type: "criterion" | "anti-criterion";
  status: "pending" | "completed";
  createdInPhase?: string;
  /**
   * Legacy category code from pre-v5.3.0 ISAs ([F]/[S]/[B]/[N]/[E]/[A]).
   * Algorithm v5.3.0 dropped bracketed category tags from the on-disk format;
   * new ISAs leave this `undefined`. Retained for backward-compat parsing of
   * historical ISAs in MEMORY/WORK/.
   */
  category?: string;
}

// ── Category tokens (legacy, pre-v5.3.0) ──────────────────────────────────
const VALID_CATEGORIES = new Set(["F", "S", "B", "N", "E", "A"]);

export function parseCriteriaList(content: string): CriterionEntry[] {
  const body = extractCriteriaSection(content);
  if (body === null) return [];
  return body
    .split("\n")
    .filter((l) => l.match(/^- \[[ x]\]/))
    .map((line): CriterionEntry | null => {
      const checked = line.startsWith("- [x]");

      // Primary parse (Algorithm v5.3.0+): `- [x] ISC-1: description` — bare ISC ID, `:` required.
      // Backward-compat: also accepts pre-v5.3.0 bracketed format `- [x] ISC-1 [F]: description`
      // and legacy nested `- [x] ISC-1 [F][grep]: description`.
      let textMatch = line.match(/^- \[[ x]\]\s*(ISC-[\w-]+)(?:\s+\[([A-Za-z]+)\](?:\[\w+\])?)?:\s*(.*)/);

      // Fallback: no trailing `:` — e.g. `- [x] ISC-1 description` or
      // `- [x] ISC-1 [COMPLETE] description` (status word in brackets, no colon).
      // Accept the line but strip any non-category bracket tokens from the text.
      if (!textMatch) {
        const loose = line.match(/^- \[[ x]\]\s*(ISC-[\w-]+)\s+(.*)/);
        if (loose) {
          const rest = loose[2].replace(/\[[A-Za-z]+\]\s*/g, "").trim();
          if (rest.length > 0) {
            textMatch = [line, loose[1], undefined as unknown as string, rest] as RegExpMatchArray;
          }
        }
      }
      if (!textMatch) return null;

      const id = textMatch[1];
      const rawCategory = textMatch[2];
      // Only accept real category codes; drop captured status words like COMPLETE/DONE/WIP.
      const category =
        rawCategory && VALID_CATEGORIES.has(rawCategory.toUpperCase()) ? rawCategory.toUpperCase() : undefined;
      const description = textMatch[3].trim();
      // Algorithm v5.5.0+: anti-criteria detected by `Anti:` prose prefix on the description.
      // Backward-compat: legacy ISAs (v5.3.0–v5.4.0) used `ISC-A-N` numbering.
      const isAnti = /^Anti:\s/i.test(description) || id.includes("-A-");
      return {
        id,
        description,
        type: isAnti ? ("anti-criterion" as const) : ("criterion" as const),
        status: checked ? ("completed" as const) : ("pending" as const),
        category,
      };
    })
    .filter((c): c is CriterionEntry => c !== null);
}
