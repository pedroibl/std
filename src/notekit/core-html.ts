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
// tree can carry a hole, a non-string `text`, a `tag` like `div><script`, a well-formed-but-dangerous
// `tag` like `script`, or a cycle. Silently coercing those would emit broken — potentially
// injectable — markup, or die with a `RangeError` naming nothing, so each one throws naming the
// offending path. Two of those guards are about a tree the CALLER built rather than `cardTree`:
// `NK_TAGS` (which tags may be emitted at all) and `NK_MAX_DEPTH` (how far the walk will recurse).
// Both are EXPORTED because they describe the TREE, not this serializer, and Story 1.3's DOM builder
// enforces the same two — one owner, two serializers, no drift (NK-1.3).
// This is the estate's re-throw doctrine (src/core/result.ts): a caller that wants a Result wraps it.

import { escapeHtml } from "../core";
import { cardTree } from "./core-nknode";
import type { NkNode } from "./core-nknode";
import type { RenderSpec } from "./core-renderspec";

// An HTML element name: a letter, then letters/digits/hyphen (covers custom elements too). A `tag`
// is the one node value that CANNOT be made safe by escaping — escaping it would produce
// `&lt;div&gt;` as a tag name, which is not markup at all — so it is validated instead.
const TAG_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * The tags an `nk-node` tree may use. Well-formed is not the same as safe: `TAG_NAME` alone accepted
 * `script`, and `nkTreeToHtml({tag:"script", text:"alert(1)"})` emitted `<script>alert(1)</script>`.
 * Escaping does not help — `text` is escaped for TEXT context, and a script body needs no
 * metacharacters at all. `cardTree` emits only `div|h3|span|ul|li` today, but that is a property of
 * this function's ONE current caller, not of the function: it is public, its declared input is plain
 * JSON, and plain JSON is exactly the shape that later arrives deserialized from somewhere less
 * trusted (an agent's output, a file, the wire). So the tag is checked against a list, not a shape.
 *
 * The set is what the card family plausibly needs, and nothing that executes, loads, embeds, or
 * navigates. Deliberately out:
 *   - `script`/`style`/`iframe`/`object`/`embed`/`link`/`meta`/`svg`/`math`/`form`/`input`/`button` —
 *     executable, resource-loading, or interactive.
 *   - VOID elements (`br`, `hr`, `img`, …) — this serializer emits `<t>…</t>` for every node, and
 *     `<br></br>` parses as TWO `<br>`s. A tag it cannot emit correctly does not belong on the list;
 *     admitting them is a serializer change, not a list edit.
 *   - `a`/`img` — inert without an attribute map, and the moment one lands they become the `href`/
 *     `src` injection surface. They join in the SAME review that adds attributes, never ahead of it.
 *
 * ADDING A TAG IS AN ADDITIVE CHANGE REVIEWED AGAINST BOTH SERIALIZERS — this HTML one and Story
 * 1.3's `nk-node → DOM` builder — exactly as an additive change to `NkNode` itself is. The two must
 * never disagree about what a tree may contain, or the single-owner property (NK-1.3) is gone and
 * preview ≠ vault.
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
 * EXPORTED (Story 1.3, additive — no behaviour change) for the same reason `NK_TAGS` is: the bound is
 * a property of what an `nk-node` TREE may contain, not of this one serializer, and Story 1.3's
 * `nk-node → DOM` builder needs the identical bound. Two copies of `64` in two files is precisely the
 * drift that ends the single-owner property (NK-1.3): the DOM path would keep walking a tree the HTML
 * path had already refused, and preview ≠ vault. One owner, both serializers import it.
 */
export const NK_MAX_DEPTH = 64;

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
function serialize(node: unknown, path: string, depth: number): string {
  if (depth > NK_MAX_DEPTH) {
    fail(path, `nesting exceeds the ${NK_MAX_DEPTH}-level limit — a deeper tree, or a cycle`);
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    fail(path, `expected an object, got ${node === null ? "null" : typeof node}`);
  }

  const tag = own(node, "tag");
  if (typeof tag !== "string" || !TAG_NAME.test(tag)) {
    fail(path, `"tag" must match ${TAG_NAME.source}, got ${JSON.stringify(tag)}`);
  }
  // Well-formed but not permitted — the `script`/`style` class of tag (see NK_TAGS). Reported apart
  // from the shape failure above so the two say what they actually mean.
  if (!NK_TAGS.has(tag)) {
    fail(path, `"tag" ${JSON.stringify(tag)} is not in the nk-node tag allowlist (NK_TAGS)`);
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
    //
    // The hole test is `hasOwnProperty`, not `i in children`: `in` answers true for an index
    // inherited from `Array.prototype`, so with `Array.prototype[0]` set to a node-shaped object a
    // sparse `children` SERIALIZED IT — `<div class="nk-card"><div class="nk-x">POISONED</div></div>`
    // — markup from a value the tree never carried. The same guard `own` applies to named keys.
    for (let i = 0; i < children.length; i++) {
      const at = `${path}.children[${i}]`;
      if (!Object.prototype.hasOwnProperty.call(children, i)) {
        fail(at, "missing — children must be dense");
      }
      inner += serialize(children[i], at, depth + 1);
    }
  }

  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/**
 * The `nk-node` tree → a self-contained HTML string. Pure, deterministic, Obsidian-free: the same
 * tree yields byte-identical output on every call.
 */
export function nkTreeToHtml(node: NkNode): string {
  return serialize(node, "root", 1);
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
