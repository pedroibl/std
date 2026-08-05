// Story 1.3 — the Obsidian edge's DOM serializer (FR5, NK-1 rules 3+5, AD-6).
//
// This file is the OTHER half of the pair whose first half is `core-html.ts`. Neither re-derives
// markup: the structure and the `nk-` class contract live in `core-nknode.ts`, and both serializers
// only walk that one tree — a string builder there, `document.createElement` here. That is what makes
// preview == vault true BY CONSTRUCTION (NK-1 rule 2, NFR8) rather than by a runtime diff. If either
// side decided structure for itself, the two would drift and NFR8 would be a hope.
//
// AD-6: plain `document.createElement` only. No JS Engine API, no Obsidian API, no plugin import.
// The vault's note-level host runs the deploy bundle; the slice renders with standard DOM and nothing
// else, so the edge stays testable against a hand-rolled stub and portable across host plugins.
//
// THE TREE IS THE SINGLE OWNER, SO THIS FILE ENFORCES THE TREE'S CONSTRAINTS, NOT ITS OWN. Both
// `NK_TAGS` and `NK_MAX_DEPTH` are imported from `core-html.ts`, where the tag allowlist already
// carried the instruction that adding a tag "is an ADDITIVE CHANGE REVIEWED AGAINST BOTH
// SERIALIZERS ... The two must never disagree about what a tree may contain, or the single-owner
// property (NK-1.3) is gone and preview != vault." Honouring them here is that rule applied:
//
//   - `NK_TAGS` is not merely a parity concern on this side, it is the SECURITY boundary. The string
//     serializer's escaping cannot neutralize a `script` tag, and neither can DOM's: an element built
//     with `createElement("script")`, given a body via `textContent`, and then inserted into the
//     document RUNS. A tree arriving from an agent, a file, or the wire is exactly the plain JSON the
//     allowlist exists for, so the DOM path checks it too — a DOM builder that trusted a tag the HTML
//     builder rejects would be the more dangerous of the two, not the more permissive.
//   - `NK_MAX_DEPTH` terminates a cycle. A hand-built tree whose child points at an ancestor is
//     unbounded depth; without the bound this recursion dies on `RangeError` after allocating a very
//     large amount of DOM, naming nothing. Same bound, same message shape, same path reporting.
//
// FAIL-LOUD, and this file is where that is safe. `nkTreeToDom` throws on a malformed node exactly as
// `nkTreeToHtml` does — the two must agree about what they REFUSE as much as about what they emit.
// The "never throw into the note" contract (FR4/AC #2) is honoured one level up, in the
// post-processor, which turns any throw from here into a visible notice. Swallowing it here instead
// would leave both callers — the post-processor AND the CLI (Story 2.1) — unable to tell a rendered
// card from a silently-empty one.

import { cardTree, NK_TAGS, NK_MAX_DEPTH } from "../core-nknode";
import type { NkNode } from "../core-nknode";
import type { RenderSpec } from "../core-renderspec";

/** The id of the injected `<style>` element. `nk-`-prefixed like every class this slice owns. */
const STYLE_ID = "nk-base-styles";

/** Read a property as DATA — own properties only (the guard both core serializers apply). */
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
 * Build one node and its subtree. `path` is the position in the tree (`root.children[1]`), so a
 * malformed node reports WHERE it is — the same messages the string serializer produces, because a
 * caller debugging a tree should not have to learn two vocabularies for one failure.
 */
function build(node: unknown, path: string, depth: number): HTMLElement {
  if (depth > NK_MAX_DEPTH) {
    fail(path, `nesting exceeds the ${NK_MAX_DEPTH}-level limit — a deeper tree, or a cycle`);
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    fail(path, `expected an object, got ${node === null ? "null" : typeof node}`);
  }

  const tag = own(node, "tag");
  if (typeof tag !== "string") {
    fail(path, `"tag" must be a string, got ${typeof tag}`);
  }
  // Membership in the allowlist subsumes a well-formedness check: every entry is a valid element
  // name, so a tag that passes here can never make `createElement` throw `InvalidCharacterError`.
  // Checking the list rather than a shape is the point — `script` is perfectly well-formed.
  if (!NK_TAGS.has(tag)) {
    fail(path, `"tag" ${JSON.stringify(tag)} is not in the nk-node tag allowlist (NK_TAGS)`);
  }

  const el = document.createElement(tag);

  // Emission order mirrors the string serializer: attribute, then text, then children. An empty class
  // is omitted rather than written as `class=""`, matching `core-html.ts` byte for byte.
  const cls = optionalString(node, "class", path);
  if (cls !== undefined && cls.length > 0) el.className = cls;

  // TEXT BEFORE CHILDREN IS LOAD-BEARING, NOT STYLE. Assigning `textContent` REMOVES every existing
  // child node, so setting it after the loop would silently delete the whole subtree just built —
  // a card that renders as its own title and nothing else. The string serializer concatenates text
  // then children, so this order is also what keeps the two outputs structurally identical.
  const text = optionalString(node, "text", path);
  if (text !== undefined) el.textContent = text;

  const children = own(node, "children");
  if (children !== undefined) {
    if (!Array.isArray(children)) fail(path, `"children" must be an array`);
    // Indexed, not `map`ped or spread: both SKIP holes, and both resolve an index with Get, which
    // walks the PROTOTYPE CHAIN. With a node-shaped object on `Array.prototype[0]`, a sparse
    // `children` would have built and appended a real element for a child the tree never carried —
    // the identical leak the string serializer documents, arriving here as DOM instead of markup.
    // `hasOwnProperty`, never `i in children`, for exactly that reason.
    for (let i = 0; i < children.length; i++) {
      const at = `${path}.children[${i}]`;
      if (!Object.prototype.hasOwnProperty.call(children, i)) {
        fail(at, "missing — children must be dense");
      }
      el.appendChild(build(children[i], at, depth + 1));
    }
  }

  return el;
}

/**
 * The `nk-node` tree → a detached DOM element. Pure of the vault: it touches the global `document`
 * and nothing else, so it runs unchanged against a stub in `bun test` and against Obsidian's real
 * document in the vault.
 */
export function nkTreeToDom(node: NkNode): HTMLElement {
  return build(node, "root", 1);
}

/**
 * Inject the shared `nk-` styles once, id-guarded so a re-render cannot duplicate them (the idiom the
 * estate's other Obsidian edge established). Every selector is `nk-`-prefixed; the slice styles its
 * own regions and never reaches into another edge's (AD-8 / NK-2).
 *
 * `style` is deliberately NOT in `NK_TAGS` and that is not an inconsistency: the allowlist governs
 * what a DATA-DRIVEN tree walk may materialize from caller-supplied JSON. This element is built here,
 * from a literal, with a body this file owns — no input reaches it.
 *
 * Colours come from Obsidian's own CSS variables rather than fixed values, so a card inherits the
 * reader's theme instead of fighting it.
 */
export function ensureStyles(id: string = STYLE_ID): void {
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    .nk-card { margin: 0.6em 0; padding: 14px 16px; border-radius: 10px;
      background: var(--background-secondary); border: 1px solid var(--background-modifier-border); }
    .nk-card-title { margin: 0 0 0.5rem; font-size: 1.05em; line-height: 1.3; }
    .nk-card-fields { display: flex; flex-direction: column; gap: 0.3rem; }
    .nk-field { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; }
    .nk-field-label { flex: 0 0 auto; min-width: 7rem; font-size: 0.72em; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--text-muted); }
    .nk-field-value { flex: 1 1 12rem; color: var(--text-normal); }
    .nk-field-values { flex: 1 1 12rem; margin: 0; padding-left: 1.1rem; }
    .nk-field-values .nk-field-value { display: list-item; }
    .nk-card-meta { margin-top: 0.7rem; display: flex; flex-wrap: wrap; gap: 0.6rem;
      font-size: 0.72em; color: var(--text-faint); font-family: var(--font-monospace); }
    .nk-notice { margin: 0.4em 0; padding: 0.5rem 0.8rem; border-radius: 8px; font-size: 0.85em;
      background: var(--background-secondary-alt); color: var(--text-muted);
      border: 1px solid var(--background-modifier-border); }
  `;
  document.head.appendChild(style);
}

/**
 * The `nk-card` renderer — the one renderer v1 ships (D2 / SM-C1). Styles first, then the same
 * `cardTree` the headless projection lowers, walked to DOM.
 */
export function renderCardDom(spec: RenderSpec): HTMLElement {
  ensureStyles();
  return nkTreeToDom(cardTree(spec));
}
