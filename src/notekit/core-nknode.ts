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
 */
function listNode(values: readonly unknown[]): NkNode {
  const items: NkNode[] = [];
  for (let i = 0; i < values.length; i++) {
    if (!(i in values)) continue;
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
    if (!(i in fields)) continue;
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
 * Lower a validated nk-card RenderSpec into the `nk-node` tree. Pure and total: the same spec always
 * yields the same tree, and no input shape produces a node carrying `undefined`.
 */
export function cardTree(spec: RenderSpec): NkNode {
  const rows = fieldNodes(own(spec, "fields"));
  const fields: NkNode | undefined =
    rows.length === 0 ? undefined : { tag: "div", class: "nk-card-fields", children: rows };

  return {
    tag: "div",
    class: "nk-card",
    children: present([leaf("h3", "nk-card-title", own(spec, "title")), fields, metaNode(spec)]),
  };
}
