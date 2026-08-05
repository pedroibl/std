// Story 1.1 — the nk-fence body codec (NK-1.4). Pure (D1): zero node:*/fs/DOM/network, no
// process/document refs. `core` is the SOLE owner of this grammar — nothing else hand-rolls fence
// `key: value` parsing or writing, and every writer goes through `serializeFenceBody`.
//
// SCOPE: a fenced code block whose info string is `nk-<type>` (NK-2) — both its BODY (the `key: value`
// lines inside) and, since Story 2.1, its CONTAINER (info string and delimiters, via `locateFence`).
// Never the note's YAML frontmatter: the render seam's field values come from the body (NK-1.8), and
// `parseFrontmatter` (src/core/parse.ts) stays the CALLER's tool for the `nk-type:` opt-in.
//
// The container used to be disclaimed here, and that was right while the DOM post-processor was the
// only reader — Obsidian had already split the block into `<pre>/<code>` before `core` saw it, so the
// delimiters never reached this file. The CLI reads raw markdown and has no such host, so the
// container grammar comes home to the codec that already owns the body. `locateFence` and
// `edge/post-processor.ts`'s `findFence` are TWO LOCATORS OF ONE GRAMMAR — `^nk-([a-z]+)$` here,
// `/^language-nk-([a-z]+)$/` there — exactly as `core-html.ts` and `edge/nkcard.ts` are two
// serializers of one tree (NK-1.3). Change the grammar in one and you must change it in the other.
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
//   8. ARRAY-INDEX KEYS ARE DROPPED — both on parse and on write. A key that is a canonical
//      non-negative integer in `0 … 2^32-2` (`0`, `1`, `2`, `4294967294`) is an array index, and
//      JavaScript orders those keys NUMERICALLY ahead of every string key regardless of insertion
//      order: `2: two\n1: one` came back as `1: one\n2: two`, so parity was silently false for them.
//      `01`, `1.5`, `-1`, `4294967295` are NOT array indices and keep their insertion order, so they
//      are kept. See KNOWN LIMITS for why they are dropped rather than order-preserved.
//
// Because of 1–4 and 8, `serialize(parse(body))` is the body's CANONICAL form and the codec is
// idempotent from there: `serialize(parse(serialize(parse(b)))) === serialize(parse(b))` for every
// `b`. FR16 parity — `serialize(parse(body)) === body` — is exact on a canonical body, i.e. one that
// survives 1–8; a body carrying an array-index key is normalized, never round-tripped.
//
// KNOWN LIMITS (declared, not bugs): a scalar that literally reads `[a, b]` round-trips as a list;
// a list element containing a comma cannot be expressed (no escape syntax); and an array-index key
// cannot be carried at all. That last one is a consequence of the pinned public type — `FenceFields`
// is a `Record` (the story pins it, and NK-1.8 pins `noteToRenderSpec(fields, rubric, injected)`), and
// no `Record` can preserve insertion order across array-index keys. Preserving it would need an order
// side-channel outside the record — a hidden property every hand-built `FenceFields` would lack, or a
// second `serializeFenceBody` argument every writer would have to thread — both API changes, not codec
// fixes. Dropping is the codec's existing answer for a line it cannot represent (rule 2), and `0`/`1`/
// `2` are not meaningful nk field names. All three stay out until a real note needs them (D2).

/** The fields carried by an nk-fence body — the render seam's input (NK-1.8). */
export type FenceFields = Record<string, string | string[]>;

// The delimiter is the single source; the written separator derives from it, so parse and serialize
// cannot drift apart if the grammar's separator ever changes.
const LIST_DELIMITER = ",";
const LIST_SEPARATOR = `${LIST_DELIMITER} `;

// A canonical non-negative integer with no leading zero. Paired with the `< 2**32 - 1` bound below,
// this is exactly the ECMA-262 array-index predicate — the key class the engine reorders.
const CANONICAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;

/**
 * Is this key one JavaScript stores as an array index, and therefore reorders numerically ahead of
 * every string key? Those cannot round-trip through a `Record`, so the codec drops them (rule 8).
 */
function isArrayIndexKey(key: string): boolean {
  return CANONICAL_INTEGER.test(key) && Number(key) < 2 ** 32 - 1;
}

/**
 * Join list elements for the written form, OWN elements only. `Array.prototype.join` resolves each
 * index with Get, which walks the prototype chain: a hand-built sparse value with `Array.prototype[0]`
 * poisoned wrote `tags: [POISONED]` into a fence body — a value the record never carried. A hole
 * contributes the empty string here, exactly as `join` does on an unpolluted prototype, so a dense
 * list (everything `parseFenceBody` produces) is written byte-identically.
 */
function joinOwn(values: readonly unknown[]): string {
  const parts: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const element = Object.prototype.hasOwnProperty.call(values, i) ? values[i] : undefined;
    parts.push(element === undefined || element === null ? "" : String(element));
  }
  return parts.join(LIST_SEPARATOR);
}

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
  // NULL PROTOTYPE, deliberately. On a plain `{}`, `__proto__: [x]` hits the prototype SETTER rather
  // than storing a field, and the key vanished from the parsed record entirely — a fence line the
  // author wrote and the codec silently ate. Here every key is stored as data, and no inherited name
  // (`constructor`, `toString`) can masquerade as a field when the render seam reads it back.
  const fields = Object.create(null) as FenceFields;
  for (const line of body.split(/\r\n|\r|\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue; // no key → skip
    const key = line.slice(0, colon).trim();
    if (key.length === 0) continue; // whitespace-only key → skip
    if (isArrayIndexKey(key)) continue; // cannot survive a Record's key order — rule 8
    const raw = line.slice(colon + 1).trim();
    fields[key] = raw.startsWith("[") && raw.endsWith("]") ? parseList(raw) : raw;
  }
  return fields;
}

/**
 * Write fields back as an nk-fence body — the exact inverse of `parseFenceBody` on a canonical body.
 * This is the ONLY sanctioned writer of the fence grammar (NK-1.4); never hand-roll the `key: value`
 * form. Insertion order of the record is the line order of the output — except for array-index keys,
 * which the engine has already reordered by the time we can see them, so they are dropped here too
 * (rule 8) and the writer never emits a line the parser would refuse.
 */
export function serializeFenceBody(fields: FenceFields): string {
  return Object.entries(fields)
    .filter(([key]) => !isArrayIndexKey(key))
    .map(([key, value]) => {
      const written = Array.isArray(value) ? `[${joinOwn(value)}]` : value;
      return `${key}: ${written}`;
    })
    .join("\n");
}

// ── locateFence ─────────────────────────────────────────────────────────────────────────────────

/**
 * An nk-fence found in raw markdown: its routed type, its body, and four byte-faithful offsets into
 * the string it was found in.
 *
 * `body` is `markdown.slice(bodyStart, bodyEnd)` and therefore INCLUDES its trailing newline whenever
 * it is non-empty — `serializeFenceBody` emits none, so a writer splicing over `[bodyStart, bodyEnd)`
 * must re-add one or the closing delimiter glues onto the last field. The block bounds run from the
 * opening backtick run to just past the closing run's line terminator, so replacing
 * `[blockStart, blockEnd)` removes the whole fence and nothing else.
 */
export type LocatedFence = {
  /** The `[a-z]+` captured from the info string — `card`, not `nk-card`. Routes through the registry. */
  type: string;
  body: string;
  bodyStart: number;
  bodyEnd: number;
  blockStart: number;
  blockEnd: number;
};

/**
 * The info string of an nk-fence, trimmed. The DOM side enforces the same shape one level up, as the
 * class token `language-nk-<type>` (`edge/post-processor.ts` FENCE_CLASS) — one grammar, two locators.
 */
const FENCE_INFO = /^nk-([a-z]+)$/;

/** An opening fence line: optional indent, a run of three or more backticks, then the info string. */
const FENCE_OPEN = /^[ \t]*(`{3,})(.*)$/;

/** A closing fence line: optional indent, a backtick run, nothing else but whitespace. */
const FENCE_CLOSE = /^[ \t]*(`{3,})[ \t]*$/;

/** Where a line's content ends and the next line begins. Handles LF, CRLF and lone CR alike. */
function lineBounds(text: string, start: number): { end: number; next: number } {
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") return { end: i, next: i + 1 };
    if (ch === "\r") return { end: i, next: text[i + 1] === "\n" ? i + 2 : i + 1 };
  }
  return { end: text.length, next: text.length };
}

/**
 * Find the FIRST nk-fence in raw markdown, or `null` when there is none.
 *
 * TOTAL — `null` for every failure mode (no fence at all, an unterminated fence, an info string
 * outside the grammar), never a throw. That copies `resolveTemplate`'s deliberate totality
 * (`core-registry.ts`) and not `cardTree`'s throw, for the reason stated there: "no nk-fence here" is a
 * MODELED OUTCOME the CLI reports to the author, not a caller bug. `| null`, not `| undefined` — the
 * barrel and the registry both use `null`, and mixing the two is how a caller's `??` starts lying.
 *
 * Non-nk fences are walked THROUGH, not scanned into: a ```` ```js ```` block whose contents happen to
 * contain a line reading ```` ```nk-card ```` is code, not a fence, and matching it would let a code
 * sample rewrite the note. Only backtick fences are recognised — Obsidian emits `language-` classes for
 * those, and the DOM locator sees nothing else.
 */
export function locateFence(markdown: string): LocatedFence | null {
  if (typeof markdown !== "string") return null;

  let cursor = 0;
  while (cursor < markdown.length) {
    const line = lineBounds(markdown, cursor);
    const open = FENCE_OPEN.exec(markdown.slice(cursor, line.end));
    if (open === null) {
      cursor = line.next;
      continue;
    }

    const ticks = open[1]!;
    const info = FENCE_INFO.exec(open[2]!.trim());
    // The backtick run starts after whatever indent the line carried.
    const blockStart = cursor + markdown.slice(cursor, line.end).indexOf(ticks);
    const bodyStart = line.next;

    // Walk to this fence's closing delimiter — a run at least as long as the opening one.
    let scan = bodyStart;
    let closed: { bodyEnd: number; blockEnd: number } | null = null;
    while (scan < markdown.length) {
      const inner = lineBounds(markdown, scan);
      const close = FENCE_CLOSE.exec(markdown.slice(scan, inner.end));
      if (close !== null && close[1]!.length >= ticks.length) {
        closed = { bodyEnd: scan, blockEnd: inner.next };
        break;
      }
      scan = inner.next;
    }

    // An unterminated fence swallows the rest of the document either way: if it was ours we have no
    // block to report, and if it was not, nothing after it is a fence.
    if (closed === null) return null;

    if (info !== null) {
      return {
        type: info[1]!,
        body: markdown.slice(bodyStart, closed.bodyEnd),
        bodyStart,
        bodyEnd: closed.bodyEnd,
        blockStart,
        blockEnd: closed.blockEnd,
      };
    }
    cursor = closed.blockEnd; // a fence, but not one of ours — skip its whole block
  }
  return null;
}
