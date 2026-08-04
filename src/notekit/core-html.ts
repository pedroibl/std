// Story 1.2 — the headless HTML projection (FR7). Pure (D1): zero node:*/fs/DOM/network, no
// process/document refs.
//
// A thin string serializer over the `nk-node` tree — the *other* half of the pair whose first half is
// Story 1.3's `nk-node → DOM` edge builder. Neither re-derives markup: the structure and the `nk-`
// class contract live in `core-nknode.ts` (NK-1 rule 3), and both serializers only walk it. That is
// what makes the CLI preview and the vault render identical by construction (NK-1 rule 2).
//
//   - NO injected parameter. Any id or timestamp is ALREADY in the tree, injected upstream at
//     `noteToRenderSpec(fields, rubric, injected)` (Story 1.1) and lowered by `cardTree`. Weaving a
//     value in at serialize time would land it in this string but not in the tree, so the edge's DOM
//     builder could not emit it — preview ≠ vault, the exact break NK-1 rule 2 exists to prevent.
//   - Deterministic (NFR2): no clock, no `Math.random`, no module-level counter, and a fixed emission
//     order — attributes then text then children. The same tree is byte-identical every run.
//   - Escaping is `core.escapeHtml` (src/core/text.ts), the estate's one escaper, used for text AND
//     attribute values. Never hand-rolled — dashkit's edge escapes through the same function.
//
// OUTPUT SHAPE: a self-contained fragment — one element, no surrounding document, no external
// stylesheet, script, or runtime needed to read it. There is no inter-tag whitespace, so the string
// is byte-stable and cannot pick up whitespace-sensitivity in a host that later embeds it.
//
// FAIL-LOUD ON A MALFORMED NODE: `NkNode` is a compile-time promise, and a hand-built or JSON-parsed
// tree can carry a hole, a non-string `text`, or a `tag` like `div><script`. Silently coercing those
// would emit broken — potentially injectable — markup, so each one throws naming the offending path.
// This is the estate's re-throw doctrine (src/core/result.ts): a caller that wants a Result wraps it.

import { escapeHtml } from "../core";
import { cardTree } from "./core-nknode";
import type { NkNode } from "./core-nknode";
import type { RenderSpec } from "./core-renderspec";

// An HTML element name: a letter, then letters/digits/hyphen (covers custom elements too). A `tag`
// is the one node value that CANNOT be made safe by escaping — escaping it would produce
// `&lt;div&gt;` as a tag name, which is not markup at all — so it is validated instead.
const TAG_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

/** Read a property as DATA — own properties only, so no inherited name can masquerade as a field. */
function own(record: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

function fail(path: string, message: string): never {
  throw new Error(`nk-node at ${path}: ${message}`);
}

/** An optional string-valued property: absent, or a string. Anything else is a malformed node. */
function optionalString(node: object, key: string, path: string): string | undefined {
  const value = own(node, key);
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(path, `"${key}" must be a string, got ${typeof value}`);
  return value;
}

/**
 * Serialize one node and its subtree. `path` is the position in the tree (`root.children[1]`), so a
 * malformed node reports WHERE it is rather than just that something was wrong.
 */
function serialize(node: unknown, path: string): string {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    fail(path, `expected an object, got ${node === null ? "null" : typeof node}`);
  }

  const tag = own(node, "tag");
  if (typeof tag !== "string" || !TAG_NAME.test(tag)) {
    fail(path, `"tag" must match ${TAG_NAME.source}, got ${JSON.stringify(tag)}`);
  }

  // Emission order is fixed here: attribute, then text, then children. An empty class is omitted
  // rather than written as `class=""` — a node with no class carries none either way, and one rule
  // for both keeps the bytes stable.
  const cls = optionalString(node, "class", path);
  const attrs = cls === undefined || cls.length === 0 ? "" : ` class="${escapeHtml(cls)}"`;

  const text = optionalString(node, "text", path);
  const body = text === undefined ? "" : escapeHtml(text);

  const children = own(node, "children");
  let inner = body;
  if (children !== undefined) {
    if (!Array.isArray(children)) fail(path, `"children" must be an array`);
    // Indexed, not `map`ped: `map` SKIPS holes, so a sparse `children` would quietly serialize a gap
    // instead of reporting it. A hole is a malformed node, not an empty one.
    for (let i = 0; i < children.length; i++) {
      const at = `${path}.children[${i}]`;
      if (!(i in children)) fail(at, "missing — children must be dense");
      inner += serialize(children[i], at);
    }
  }

  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/**
 * The `nk-node` tree → a self-contained HTML string. Pure, deterministic, Obsidian-free: the same
 * tree yields byte-identical output on every call.
 */
export function nkTreeToHtml(node: NkNode): string {
  return serialize(node, "root");
}

/**
 * The one call a caller needs for a card — the CLI's `notekit render` preview (Story 2.1) shells to
 * this. The two-step stays public on purpose: Story 1.3's edge walks `cardTree(spec)` to DOM, so both
 * paths serialize the SAME tree. The signature is pinned at `(spec) => string` — no injected
 * parameter, ever (see the header).
 */
export function renderCardHtml(spec: RenderSpec): string {
  return nkTreeToHtml(cardTree(spec));
}
