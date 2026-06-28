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
 * is no block. Tolerates both LF and CRLF line endings. Each line splits on its FIRST `:` (so a value
 * may contain colons); an `[a, b]` value becomes a `string[]`, and surrounding quotes are stripped
 * from scalars and array elements. Lines without a key are skipped. Only this flat array/quote
 * heuristic — richer YAML (quoted commas inside arrays, nesting) stays in the caller.
 */
export function parseFrontmatter(text: string): Record<string, string | string[]> {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string | string[]> = {};
  for (const line of match[1].split(/\r?\n/)) {
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
 * Pull a JSON value out of noisy text (LLM prose, markdown fences, CLI banners). Each candidate is a
 * greedy outermost match — the first `{` to the last `}`, and the first `[` to the last `]`. The
 * candidate whose opening bracket appears FIRST in the text is tried first, so an array-of-objects
 * `[{…}]` yields the array rather than its inner object; the other candidate is the fallback. Returns
 * whichever `JSON.parse`s first, else `null`. Caller asserts the result type. (Because the match is
 * greedy-outermost, two separate top-level blobs in one string won't both parse — pass one value's
 * worth of output.)
 */
export function extractJson<T = unknown>(text: string): T | null {
  const objectMatch = text.match(/\{[\s\S]*\}/)?.[0];
  const arrayMatch = text.match(/\[[\s\S]*\]/)?.[0];
  const firstObject = text.indexOf("{");
  const firstArray = text.indexOf("[");
  // Try the bracket type that opens first, so `[{…}]` resolves to the array, not the inner object.
  const arrayLeadsOff = firstArray !== -1 && (firstObject === -1 || firstArray < firstObject);
  const order = arrayLeadsOff ? [arrayMatch, objectMatch] : [objectMatch, arrayMatch];
  for (const candidate of order) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
