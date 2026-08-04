// Story 1.1 — the nk-fence body codec (NK-1.4). Pure (D1): zero node:*/fs/DOM/network, no
// process/document refs. `core` is the SOLE owner of this grammar — nothing else hand-rolls fence
// `key: value` parsing or writing, and every writer goes through `serializeFenceBody`.
//
// SCOPE: the body of a fenced code block whose info string is `nk-<type>` (NK-2) — the lines *inside*
// the fence, never the note's YAML frontmatter. The render seam's field values come from here
// (NK-1.8); `parseFrontmatter` (src/core/parse.ts) stays the CALLER's tool for the `nk-type:` opt-in,
// outside core. The fence container itself (info string, delimiters) is owned downstream, not here.
//
// FR16 parity is defined as `serializeFenceBody(parseFenceBody(body)) === body`, modulo the
// normalization declared below.
//
// DECLARED NORMALIZATION (what a non-canonical body loses on the round trip):
//   1. Line endings — CRLF and lone CR become LF.
//   2. Blank lines, lines with no `:`, and lines whose key is empty are DROPPED (not preserved).
//   3. Key and value are trimmed; output is exactly `key: value` — one space after the colon.
//   4. A repeated key keeps its LAST occurrence (a record has one slot per key).
//   5. Lists — `[a, b]` is the sole list syntax. Elements are split on `,`, trimmed, and empties
//      dropped; serialization re-joins with `", "`. `[]` round-trips as the empty list.
//   6. Values are LITERAL: unlike `parseFrontmatter`, this codec does NOT strip surrounding quotes.
//      The fence body is the plugin-off degraded view a human reads (FR6), so what is written is
//      what is read back.
//   7. Only the FIRST `:` splits a line, so colon-bearing values (`url: https://x.y/z`) survive whole.
//
// Because of 1–4, `serialize(parse(body))` is the body's CANONICAL form and the codec is idempotent
// from there: `serialize(parse(serialize(parse(b)))) === serialize(parse(b))` for every `b`.
//
// KNOWN LIMITS (declared, not bugs): a scalar that literally reads `[a, b]` round-trips as a list,
// and a list element containing a comma cannot be expressed — there is no escape syntax. Both stay
// out until a real note needs them (D2, Rule of Three).

/** The fields carried by an nk-fence body — the render seam's input (NK-1.8). */
export type FenceFields = Record<string, string | string[]>;

// The delimiter is the single source; the written separator derives from it, so parse and serialize
// cannot drift apart if the grammar's separator ever changes.
const LIST_DELIMITER = ",";
const LIST_SEPARATOR = `${LIST_DELIMITER} `;

/** Parse `[a, b]` into its elements: split on the delimiter, trim, drop empties. */
function parseList(raw: string): string[] {
  return raw
    .slice(1, -1)
    .split(LIST_DELIMITER)
    .map((element) => element.trim())
    .filter((element) => element.length > 0);
}

/**
 * Parse an nk-fence body into fields. Each line splits on its FIRST `:` (so a value may contain
 * colons — the splitting idiom is `parseFrontmatter`'s); an `[a, b]` value becomes a `string[]`.
 * Lines without a key are skipped. See the header for the full declared normalization.
 */
export function parseFenceBody(body: string): FenceFields {
  const fields: FenceFields = {};
  for (const line of body.split(/\r\n|\r|\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue; // no key → skip
    const key = line.slice(0, colon).trim();
    if (key.length === 0) continue; // whitespace-only key → skip
    const raw = line.slice(colon + 1).trim();
    fields[key] = raw.startsWith("[") && raw.endsWith("]") ? parseList(raw) : raw;
  }
  return fields;
}

/**
 * Write fields back as an nk-fence body — the exact inverse of `parseFenceBody` on a canonical body.
 * This is the ONLY sanctioned writer of the fence grammar (NK-1.4); never hand-roll the `key: value`
 * form. Insertion order of the record is the line order of the output.
 */
export function serializeFenceBody(fields: FenceFields): string {
  return Object.entries(fields)
    .map(([key, value]) => {
      const written = Array.isArray(value) ? `[${value.join(LIST_SEPARATOR)}]` : value;
      return `${key}: ${written}`;
    })
    .join("\n");
}
