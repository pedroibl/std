// Story 1.2 — the `nk-node` tree (NK-1 rule 3). Pure (D1): zero node:*/fs/DOM/network, no
// process/document refs.
//
// This tree is the SINGLE OWNER of the card's markup structure and of the `nk-` class contract. Two
// serializers walk it and neither re-derives anything: the headless HTML string builder
// (`core-html.ts`, this story) and the edge DOM builder (`nk-node → document.createElement`, Story
// 1.3). That is what makes preview == vault true by construction (NK-1 rule 2) rather than by a diff
// test — if the structure lived in each serializer, the two would drift.
//
// The rules this file encodes:
//
//   - A node is plain JSON: `{ tag, class?, text?, children? }`. No DOM, no functions, no class
//     instances — `JSON.parse(JSON.stringify(tree))` deep-equals `tree` (NK-1 rule 1).
//   - Every `class` value is `nk-`-prefixed. Never `dk-` (dashkit) or `cn-` — the two note-report
//     edges share a vault and must never share a namespace (AD-8 / NK-2).
//   - Nothing is computed here: the id and the timestamp are already IN the spec, injected upstream
//     at `noteToRenderSpec(fields, rubric, injected)` (Story 1.1). `cardTree` only lowers them. No
//     clock, no `Math.random`, no module-level counter (D4, NFR2 determinism).
//   - A value the spec does not carry yields NO node. The tree never contains the string
//     "undefined" — omission is the degraded form (mirrors FR5).
//   - ABSENT AND PRESENT-BUT-EMPTY ARE DIFFERENT STATES. FR5's omit rule is about a field the spec
//     does not carry; a field row the spec DOES carry with `value: ""` is present, and the fence
//     codec's normalization rule 3 makes `key: ` the canonical way an author writes exactly that
//     (`core-fence.ts`). Conflating the two dropped the whole row after `validate` had blessed it,
//     so the HTML contradicted the spec — see `valueLeaf` below for where the line is drawn.
//
// TOTALITY: `cardTree` takes a *validated* spec, but its parameter type is only a compile-time
// promise — a hand-built object, a JSON blob, or a sparse `fields` array all reach it at runtime.
// Story 1.1 shipped two ACs that were false for exactly this reason (a prototype-chain version name,
// a sparse array serializing its hole to `null`), so every read below is own-property and
// type-checked, and anything unusable is omitted rather than lowered into a broken node.
//
// The line runs between the SPEC and its FIELDS. Field-level junk degrades — a non-string value, a
// hole, a missing title all yield no node, never a broken one. A `spec` that is not an object at all
// is not degraded input, it is a caller who skipped `validate`, and it is rejected by name (see
// `cardTree`). "Own-property" means `hasOwnProperty`, for INDICES as well as named keys: `i in arr`
// answers true for a numeric property inherited from `Array.prototype`, so it re-opened the very
// sparse-array hole it was written to close (see `ownIndex`).

import type { RenderSpec } from "./core-renderspec";

/**
 * One node of the markup tree — plain JSON by construction. `class` is the only attribute v1 needs;
 * Story 1.3 may add an attribute map, but that is an ADDITIVE change reviewed against both
 * serializers, never a forked node type on the edge side.
 */
export type NkNode = {
  tag: string;
  class?: string;
  text?: string;
  children?: NkNode[];
};

/**
 * The declared child order of a card, top to bottom. Byte-determinism (AC #3) rests on this order
 * being fixed HERE, in the tree, so it survives any later refactor of either serializer.
 *
 *   nk-card
 *     nk-card-title      the heading            (omitted when the spec carries no title)
 *     nk-card-fields     one nk-field per row   (omitted when no row survives)
 *       nk-field
 *         nk-field-label
 *         nk-field-value   scalar
 *         nk-field-values  list → one nk-field-value <li> per element
 *     nk-card-meta       provenance, in order: version, kind, id, generatedAt
 */
const META_KEYS = ["version", "kind", "id", "generatedAt"] as const;

/** The `nk-` class for each meta key. A table so the order above and the classes cannot drift apart. */
const META_CLASSES: Record<(typeof META_KEYS)[number], string> = {
  version: "nk-card-version",
  kind: "nk-card-kind",
  id: "nk-card-id",
  generatedAt: "nk-card-generated",
};

/**
 * The tags an `nk-node` tree may use. Well-formed is not the same as safe: a tag-shape regex alone
 * accepted `script`, and `nkTreeToHtml({tag:"script", text:"alert(1)"})` emitted
 * `<script>alert(1)</script>`. Escaping does not help — `text` is escaped for TEXT context, and a
 * script body needs no metacharacters at all. `cardTree` emits only `div|h3|span|ul|li` today, but
 * that is a property of ONE producer, not of the tree type: `NkNode` is public, its declared input is
 * plain JSON, and plain JSON is exactly the shape that later arrives deserialized from somewhere less
 * trusted (an agent's output, a file, the wire). So the tag is checked against a list, not a shape.
 *
 * The set is what the card family plausibly needs, and nothing that executes, loads, embeds, or
 * navigates. Deliberately out:
 *   - `script`/`style`/`iframe`/`object`/`embed`/`link`/`meta`/`svg`/`math`/`form`/`input`/`button` —
 *     executable, resource-loading, or interactive.
 *   - VOID elements (`br`, `hr`, `img`, …) — the HTML serializer emits `<t>…</t>` for every node, and
 *     `<br></br>` parses as TWO `<br>`s. A tag a serializer cannot emit correctly does not belong on
 *     the list; admitting them is a serializer change, not a list edit.
 *   - `a`/`img` — inert without an attribute map, and the moment one lands they become the `href`/
 *     `src` injection surface. They join in the SAME review that adds attributes, never ahead of it.
 *
 * ADDING A TAG IS AN ADDITIVE CHANGE REVIEWED AGAINST BOTH SERIALIZERS — the headless HTML string
 * builder (`core-html.ts`) and the edge DOM builder (`edge/nkcard.ts`) — exactly as an additive change
 * to `NkNode` itself is. The two must never disagree about what a tree may contain, or the
 * single-owner property (NK-1.3) is gone and preview ≠ vault.
 *
 * IT LIVES HERE because it describes the TREE, not either serializer (retro action E1-A2). It was
 * first written in `core-html.ts` because that serializer needed it first, and the DOM builder then
 * imported it from there — an edge→html import that made the DOM path depend on the HTML path for a
 * rule neither one owns. Both now import it from the tree, which is the file whose invariants it
 * states.
 */
export const NK_TAGS: ReadonlySet<string> = new Set([
  "article",
  "blockquote",
  "code",
  "dd",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "ul",
]);

/**
 * How deep a tree may nest. `cardTree` produces five levels (card → fields → field → ul → li), so
 * this is ample headroom for any later renderer while still failing long before the JS stack does.
 * Without it, a cyclic or pathological hand-built tree died with `RangeError: Maximum call stack size
 * exceeded` — an engine error naming nothing, where every other malformed-node case names its path.
 *
 * A depth bound alone also terminates a CYCLE, because a cycle is just unbounded depth; a visited-set
 * would only improve the message for that one input class, at the cost of allocating on every
 * serialize. It goes in when a caller actually deserializes untrusted trees and needs to tell an
 * honest deep tree from a loop (D2 — not on speculation).
 *
 * SAME HOME, SAME REASON as `NK_TAGS` (E1-A2): the bound is a property of what an `nk-node` TREE may
 * contain, not of one serializer, and both serializers need the identical bound. Two copies of `64`
 * in two files is precisely the drift that ends the single-owner property (NK-1.3): one path would
 * keep walking a tree the other had already refused, and preview ≠ vault. One owner, both serializers
 * import it.
 */
export const NK_MAX_DEPTH = 64;

/**
 * Read a property as DATA. A bare `record[key]` walks the prototype chain, so on a plain object
 * `spec["constructor"]` is `Object` — a function, which is not JSON and must never reach a node.
 * Own properties only (the same guard Story 1.1 put on the fence record).
 */
function own(record: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Is index `i` an OWN element of `values` — the array counterpart of `own` above.
 *
 * `i in values` is NOT this check, and the difference is a live bug rather than a style point: `in`
 * accepts numeric properties inherited from `Array.prototype`, so with `Array.prototype[0]` set, the
 * HOLE in `["", , "c"]` answers `0 in values === true` and the inherited value is lowered into the
 * tree as if the spec carried it. The hole guard was written to keep exactly that value out, and `in`
 * was the idiom that let it back in. Own properties only, everywhere an index is read.
 */
function ownIndex(values: readonly unknown[], i: number): boolean {
  return Object.prototype.hasOwnProperty.call(values, i);
}

/** A short, safe rendering of an unusable input for an error message (mirrors `core-renderspec`). */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/**
 * A string worth rendering in an IDENTITY slot — the title, a field's label, a meta value. Those
 * slots are bare scalars with no wrapper around them to say "present, but blank", so an empty one is
 * indistinguishable from an absent one; and `validate` already rejects empty for every one of them
 * (`requireNonEmptyString` in `core-renderspec.ts`), so a blank can only reach here on a hand-built
 * spec. Empty is therefore read as absent and the node is omitted (FR5). A field's VALUE is the
 * different case — it has a key and a label attesting its presence — and goes through `valueLeaf`.
 */
function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** An identity leaf carrying text, or nothing at all when the value is absent/empty/not a string. */
function leaf(tag: string, cls: string, value: unknown): NkNode | undefined {
  const text = textOf(value);
  return text === undefined ? undefined : { tag, class: cls, text };
}

/**
 * A VALUE leaf, where PRESENCE decides — not content. A field row reaches us as `{key, label, value}`,
 * so `value: ""` is a value the spec carries and the author wrote on purpose (`bio: ` is the codec's
 * canonical empty form, rule 3). Dropping it is data loss nobody asked for, and it makes the HTML
 * disagree with the spec `validate` blessed — the AC #2 break the third review caught. So a string is
 * always a node, `""` included, and the empty node is what the empty value looks like.
 *
 * A NON-string is still nothing: that value is unusable, not empty, and there is no honest node to
 * emit for it. The "never emit the string `undefined`" guarantee is unchanged — an absent field emits
 * no node at all, and a present one emits its own text, never a stringified placeholder.
 */
function valueLeaf(tag: string, cls: string, value: unknown): NkNode | undefined {
  return typeof value === "string" ? { tag, class: cls, text: value } : undefined;
}

/** Drop the omitted children, keeping declared order. */
function present(nodes: readonly (NkNode | undefined)[]): NkNode[] {
  return nodes.filter((node): node is NkNode => node !== undefined);
}

/**
 * A list value → `<ul>` of `<li>`. Elements go through `valueLeaf` for the same reason the scalar does
 * — `["a", "", "c"]` is three carried values and renders three `<li>`s — so the two shapes of an empty
 * value cannot diverge: whatever `""` does as a scalar, it does as an element.
 *
 * Indexed rather than `map`ped because `map` SKIPS holes and copies them into its result: a sparse
 * `["a", , "c"]` would emit a node whose text is `undefined`, which is precisely what the omit rule
 * forbids. A hole is a value that ISN'T there — the absent case — and so are non-string elements.
 * The hole test is `ownIndex`, never `in` — see `ownIndex` for the leak `in` opened here.
 */
function listNode(values: readonly unknown[]): NkNode {
  const items: NkNode[] = [];
  for (let i = 0; i < values.length; i++) {
    if (!ownIndex(values, i)) continue;
    const item = valueLeaf("li", "nk-field-value", values[i]);
    if (item !== undefined) items.push(item);
  }
  return { tag: "ul", class: "nk-field-values", children: items };
}

/**
 * One rubric-selected field → one `nk-field` row (label, then value). A row whose value is neither a
 * string nor an array is omitted whole: a label with nothing beside it is a worse artifact than a
 * missing row. An empty string is NOT that case — it is a carried value (see `valueLeaf`), so its row
 * survives, exactly as an empty array's row already did.
 */
function fieldNode(row: unknown): NkNode | undefined {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return undefined;
  const value = own(row, "value");
  const isList = Array.isArray(value);
  if (!isList && typeof value !== "string") return undefined;

  // The label falls back to the key — the same default `noteToRenderSpec` applies when the rubric
  // entry omits one, so a hand-built spec degrades to the rubric's own rule rather than to blank.
  // `textOf` first, not `??`: an empty-string label is absent for our purposes, and `??` only falls
  // back on null/undefined, so it would keep the blank and never reach the key.
  const labelText = textOf(own(row, "label")) ?? textOf(own(row, "key"));
  const label = leaf("span", "nk-field-label", labelText);
  const rendered = isList ? listNode(value) : valueLeaf("span", "nk-field-value", value);
  return { tag: "div", class: "nk-field", children: present([label, rendered]) };
}

/** The rows, in spec order. Indexed for the sparse-array reason spelled out on `listNode`. */
function fieldNodes(fields: unknown): NkNode[] {
  if (!Array.isArray(fields)) return [];
  const rows: NkNode[] = [];
  for (let i = 0; i < fields.length; i++) {
    if (!ownIndex(fields, i)) continue;
    const node = fieldNode(fields[i]);
    if (node !== undefined) rows.push(node);
  }
  return rows;
}

/** The provenance row: version, kind, id, generatedAt — the fixed order declared in `META_KEYS`. */
function metaNode(spec: object): NkNode | undefined {
  const parts = present(META_KEYS.map((key) => leaf("span", META_CLASSES[key], own(spec, key))));
  return parts.length === 0 ? undefined : { tag: "div", class: "nk-card-meta", children: parts };
}

/**
 * Lower a validated nk-card RenderSpec into the `nk-node` tree. Pure and deterministic: the same spec
 * always yields the same tree, and no FIELD-level input shape produces a node carrying `undefined`.
 *
 * A non-object `spec` is the one input that is rejected rather than degraded, and the two functions on
 * either side of this one in the pipeline both already do exactly that: `validate`'s `dispatch`
 * (`core-renderspec.ts`) fails with `"RenderSpec must be an object, got null"`, and `serialize`
 * (`core-html.ts`) fails with `"expected an object, got null"`. Neither normalizes, so neither does
 * this — a third convention in one slice is worse than either one of them.
 *
 * Normalizing to an empty record was the alternative, and it is the wrong trade here: `null` and
 * `undefined` already died on `hasOwnProperty` with a raw `TypeError` naming nothing, but `"str"` and
 * `7` sailed through and returned `<div class="nk-card"></div>` — a well-formed card built from
 * garbage, indistinguishable from a genuinely empty one. Silently rendering an empty card for input
 * that was never a spec is the failure mode this slice fails loud to avoid; the caller skipped
 * `validate`, and that is a caller bug worth naming, not a value worth degrading.
 */
export function cardTree(spec: RenderSpec): NkNode {
  // Reachable at runtime despite the type: `RenderSpec` is erased, and this is called from the CLI
  // (Story 2.1) and later from notewright, where a JSON blob or a hand-built object really can arrive.
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new Error(`RenderSpec at spec: expected an object, got ${describe(spec)}`);
  }

  const rows = fieldNodes(own(spec, "fields"));
  const fields: NkNode | undefined =
    rows.length === 0 ? undefined : { tag: "div", class: "nk-card-fields", children: rows };

  return {
    tag: "div",
    class: "nk-card",
    children: present([leaf("h3", "nk-card-title", own(spec, "title")), fields, metaNode(spec)]),
  };
}
