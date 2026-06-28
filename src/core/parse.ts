// Story 9.1 — the structured-parse kit: NDJSON lines, YAML frontmatter blocks, and balanced JSON
// pulled from noisy LLM/CLI output. Pure (D1): zero node:*/fs/DOM/network, no process/document.
//
// DELIBERATE graceful-skip, NOT fail-loud. The estate rule is to re-throw unexpected errors (FR5,
// see result.ts), but malformed input is the EXPECTED case for these three — they mirror the ~15
// hand-rolled copies across PAI/Tools that tolerate junk lines, missing frontmatter, and prose
// around a JSON blob. So they degrade to `[]` / `{}` / `null` instead of throwing. (Same spirit as
// config.ts's optional-config reads.) Do not "fix" this into a throw.

/**
 * Parse newline-delimited JSON: one value per line, blank lines skipped, a line that fails
 * `JSON.parse` skipped (never thrown). Returns the values that parsed, in order. The element type is
 * the caller's to assert — this primitive is shape-agnostic; filter on shape after parsing.
 */
export function parseNdjson<T = unknown>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip a non-JSON line — malformed input is expected here
    }
  }
  return out;
}

/** Strip one layer of matching surrounding single/double quotes; otherwise return as-is. */
function unquote(s: string): string {
  const q = s[0];
  if (s.length >= 2 && (q === '"' || q === "'") && s[s.length - 1] === q) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Parse a leading YAML frontmatter block (`---` … `---`) into a flat record. Returns `{}` when there
 * is no block. Each line splits on its FIRST `:` (so a value may contain colons); an `[a, b]` value
 * becomes a `string[]`, and surrounding quotes are stripped from scalars and array elements. Lines
 * without a key are skipped. Only this flat array/quote heuristic — richer YAML stays in the caller.
 */
export function parseFrontmatter(text: string): Record<string, string | string[]> {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string | string[]> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue; // no key → skip
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    if (raw.startsWith("[") && raw.endsWith("]")) {
      result[key] = raw
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter((s) => s.length > 0);
    } else {
      result[key] = unquote(raw);
    }
  }
  return result;
}

/**
 * Pull the first balanced JSON value out of noisy text (LLM prose, markdown fences, CLI banners).
 * Tries the first `{…}` then the first `[…]`, returning whichever `JSON.parse`s first; `null` if
 * neither parses. Caller asserts the result type. (Greedy match favours an object when both are
 * present — give it object-or-array-shaped output, not both interleaved.)
 */
export function extractJson<T = unknown>(text: string): T | null {
  const objectMatch = text.match(/\{[\s\S]*\}/);
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  for (const candidate of [objectMatch?.[0], arrayMatch?.[0]]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
