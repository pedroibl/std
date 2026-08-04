// Story 1.3 — the Obsidian post-processor (FR4, FR6, NK-1.8, NK-2). The entry the vault's note-level
// host calls once per rendered note.
//
// THE FIELD SOURCE IS THE FENCE BODY, NEVER FRONTMATTER (NK-1.8, ⚠️-3). This is the decision the
// whole degrade story rests on, so it is worth stating plainly:
//
//   - NK-2 forces it. The nk-fence is a FENCED CODE BLOCK precisely so its `key: value` body stays
//     out of the inline-field index the vault's query plugin builds. Card data in frontmatter would
//     be indexed, and would collide with the sibling dashboard edge that owns frontmatter in the same
//     notes. Disjoint regions is what lets both edges live in one note.
//   - FR6 needs it. The plugin-off view IS the literal fence body, so the rendered card is a subset
//     of it BY CONSTRUCTION — one source, no hand-duplicated data. If the card were built from
//     frontmatter, "the degraded form is a superset" would be a claim about two independent regions
//     staying in sync, which nothing could enforce.
//
// The only frontmatter this path reads is the `nk-type:` OPT-IN — presence, not value. The ROUTING
// type is the fence info string, which Obsidian surfaces as `code.language-nk-<type>`. That split is
// NK-1.8 rule 2, and it matches what `core-renderspec.ts` already encodes: `noteToRenderSpec` takes
// `kind` from the injected rubric because "the caller resolved the note type from the fence info
// string before picking it". The caller is this file. It resolves from the fence.
//
// NEVER THROW INTO THE NOTE (FR4 / AC #2). Obsidian renders notes in one pass; an exception escaping
// here can leave the note half-drawn. Every outcome is therefore a returned value, and the last
// resort is a visible `nk-notice` element carrying the error text. That is not swallowing — a notice
// the reader can see is louder than an exception the host discards, and the alternative (fail-loud by
// propagation) trades a corrupted note for a message nobody reads. The purely functional layers below
// keep their fail-loud contract; this shell is where it is converted into something a reader sees.
//
// AND THAT PROMISE IS STRUCTURAL, NOT A TALLY OF THE PATHS BELOW. It used to be the latter: every
// designed failure returned, and the one DOM MUTATION sat outside the guarded region, where a real
// `replaceChild` throws `NotFoundError` if the `<pre>` is no longer a child of the parent the scan
// captured — a renderer that re-arranged the container would have escaped the contract at the single
// point the contract was not enforced. Two changes close it: the mutation is guarded and falls back to
// the same append every other unreplaceable `<pre>` takes, and `postProcess` is a `try` shell over the
// whole body so a host whose DOM refuses even the notice still returns. The shell is a NET, not the
// degrade mechanism — every failure the vault can actually produce is handled below it and returns a
// notice; the tests assert the net is never the thing that caught it.
//
// NON-CORRUPTING MEANS THE NOTICE IS AN ADDITION. On any degrade the `<pre>` STAYS — the reader keeps
// the plain-markdown fence body, which is the whole point of FR6 — and the notice is appended to the
// container. Prose is never rewritten, moved, or removed. Only a SUCCESSFUL render replaces the
// `<pre>`, and it replaces exactly that one element.

import { parseFenceBody } from "../core-fence";
import { noteToRenderSpec, validate } from "../core-renderspec";
import type { Injected } from "../core-renderspec";
import { resolveTemplate } from "../core-registry";
import type { NoteTypeRegistry } from "../core-registry";
import { dispatch } from "./dispatch";

/** The frontmatter key whose PRESENCE opts a note into rendering (NK-1.8 rule 2). */
const OPT_IN_KEY = "nk-type";

/**
 * The class Obsidian puts on a fenced code block's `<code>`, carrying the info string. NK-4 pins the
 * fence grammar at `^nk-[a-z]+$`, so the captured type is `[a-z]+` — an info string outside that
 * grammar is not an nk-fence and the post-processor leaves it alone.
 */
const FENCE_CLASS = /^language-nk-([a-z]+)$/;

/**
 * How deep the container scan will walk. A rendered note is a shallow tree, so this is generous; it
 * exists so a hand-built or cyclic container cannot spin the walk forever. Same reasoning as the
 * tree's own depth bound, applied to the other direction of traversal.
 */
const MAX_SCAN_DEPTH = 32;

/** What the post-processor did. Every path returns one of these; none of them throws. */
export type PostProcessResult =
  | { action: "noop"; reason: "no-opt-in" | "no-fence" }
  | { action: "rendered"; nkType: string; element: HTMLElement }
  | {
      action: "notice";
      nkType: string;
      reason: "unknown-type" | "invalid-spec" | "render-error";
      detail: string;
      element: HTMLElement;
    }
  /**
   * The last resort, and the one outcome that needs no DOM to report: the host's document refused
   * even the notice. Distinct from `notice` on purpose — a notice means the reader can SEE what went
   * wrong, and this variant is exactly the case where nothing could be shown. Unreachable for any
   * container Obsidian hands over; if it ever appears in a vault, the host is broken, not the note.
   */
  | { action: "failed"; reason: "host-dom-unusable"; detail: string };

/** Everything the post-processor needs. Nothing is read from a file, a path, or a clock (D4). */
export type PostProcessInput = {
  /** The rendered note element the host hands over. Searched, never rebuilt. */
  container: HTMLElement;
  /** The note's frontmatter. Only `nk-type`'s PRESENCE is consulted (NK-1.8 rule 2). */
  frontmatter: Readonly<Record<string, unknown>>;
  /** The caller-local note-type registry (D4 — injected, never read from `src/`). */
  registry: NoteTypeRegistry;
  /** The id and timestamp `core` must not compute for itself (D4, determinism). */
  injected: Injected;
};

/** Read a property as DATA — own properties only. */
function own(record: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Has the note opted in? PRESENCE of a non-empty `nk-type` string, nothing more — the routing type
 * comes from the fence, so the VALUE here is not consulted and a disagreement between the two is not
 * an error: the frontmatter key says "render me", the fence says "as this". A note may legitimately
 * carry several fences of different types under one opt-in.
 *
 * `own`, not `frontmatter[OPT_IN_KEY]`: frontmatter arrives from a YAML parse the caller ran, and on
 * a plain-object result an inherited name would answer for a key the author never wrote.
 */
function hasOptIn(frontmatter: Readonly<Record<string, unknown>>): boolean {
  if (typeof frontmatter !== "object" || frontmatter === null) return false;
  const value = own(frontmatter, OPT_IN_KEY);
  return typeof value === "string" && value.length > 0;
}

/** An element's tag name, lowercased. Real DOM reports `PRE`; a stub or XML host may report `pre`. */
function tagOf(el: unknown): string {
  if (typeof el !== "object" || el === null) return "";
  const name = (el as { tagName?: unknown }).tagName;
  return typeof name === "string" ? name.toLowerCase() : "";
}

/**
 * The nk-type carried by an element's class list, or null. `className` is read defensively because it
 * is NOT always a string in the DOM — on an SVG element it is an `SVGAnimatedString`, and calling
 * `.split` on one throws. Tokens are split on whitespace because Obsidian adds its own classes
 * alongside the language class.
 */
function fenceTypeOf(el: unknown): string | null {
  if (typeof el !== "object" || el === null) return null;
  const cls = (el as { className?: unknown }).className;
  if (typeof cls !== "string") return null;
  for (const token of cls.split(/\s+/)) {
    const match = FENCE_CLASS.exec(token);
    if (match !== null) return match[1]!;
  }
  return null;
}

/** The element children of a node, as a plain array — `HTMLCollection` is live, so snapshot it. */
function childrenOf(el: unknown): unknown[] {
  if (typeof el !== "object" || el === null) return [];
  const kids = (el as { children?: unknown }).children;
  if (kids === null || typeof kids !== "object") return [];
  const length = (kids as { length?: unknown }).length;
  if (typeof length !== "number" || !Number.isFinite(length) || length < 0) return [];
  const out: unknown[] = [];
  for (let i = 0; i < length; i++) out.push((kids as Record<number, unknown>)[i]);
  return out;
}

/** A located nk-fence: the `<pre>` to replace, its parent, the `<code>` body, and the routed type. */
type Fence = { pre: unknown; parent: unknown; code: unknown; nkType: string };

/**
 * Find the first nk-fence in the container: a `<pre>` whose element child is a `<code>` carrying a
 * `language-nk-<type>` class. Hand-walked rather than delegated to `querySelector` on purpose — the
 * walk is then THIS file's logic under test, not a selector engine a stub would have to reimplement,
 * and it needs nothing beyond `tagName`, `className`, and `children`.
 *
 * Depth-first and first-match: v1 renders one card per note (D2). A note with several fences keeps
 * the rest as plain fenced code, which is a readable degrade rather than a silent partial render.
 */
function findFence(root: unknown, depth: number = 0): Fence | null {
  if (depth > MAX_SCAN_DEPTH) return null;
  for (const child of childrenOf(root)) {
    if (tagOf(child) === "pre") {
      for (const grandchild of childrenOf(child)) {
        if (tagOf(grandchild) !== "code") continue;
        const nkType = fenceTypeOf(grandchild);
        if (nkType !== null) return { pre: child, parent: root, code: grandchild, nkType };
      }
    }
    const found = findFence(child, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** The fence body — `textContent`, defensively, since a stub or a text-free node may not carry one. */
function bodyOf(code: unknown): string {
  if (typeof code !== "object" || code === null) return "";
  const text = (code as { textContent?: unknown }).textContent;
  return typeof text === "string" ? text : "";
}

/** Build the visible, non-corrupting degrade marker. Appended beside the fence, never over it. */
function noticeElement(message: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "nk-notice";
  el.textContent = message;
  return el;
}

/** A short, safe rendering of a thrown value for the notice text. */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Render a note's nk-fence, or degrade. The whole contract in one place:
 *
 *   no `nk-type:` frontmatter  → no-op, note untouched         (the note did not opt in)
 *   no nk-fence in the note    → no-op, note untouched         (nothing to match — AC #2)
 *   unregistered fence type    → `<pre>` kept + one notice     (AC #2)
 *   spec fails `validate`      → `<pre>` kept + one notice     (never a throw — AC #2)
 *   anything else throws       → `<pre>` kept + one notice     (the note still renders)
 *   otherwise                  → the `<pre>` becomes the card  (AC #1)
 *
 * The `try` is the structural half of "never throws" (see the header). It catches nothing the vault
 * can produce — every designed failure returns from `run` — and exists so the contract is enforced by
 * the shape of this function rather than by an audit of every statement inside it.
 */
export function postProcess(input: PostProcessInput): PostProcessResult {
  try {
    return run(input);
  } catch (e) {
    return { action: "failed", reason: "host-dom-unusable", detail: `notekit: ${messageOf(e)}` };
  }
}

/** The whole body, one level in, so the shell above can be a pure guard. */
function run(input: PostProcessInput): PostProcessResult {
  const { container, frontmatter, registry, injected } = input;

  if (!hasOptIn(frontmatter)) return { action: "noop", reason: "no-opt-in" };

  const fence = findFence(container);
  if (fence === null) return { action: "noop", reason: "no-fence" };

  const { nkType } = fence;

  const degrade = (
    reason: "unknown-type" | "invalid-spec" | "render-error",
    detail: string,
  ): PostProcessResult => {
    const element = noticeElement(detail);
    container.appendChild(element);
    return { action: "notice", nkType, reason, detail, element };
  };

  const template = resolveTemplate(nkType, registry);
  const renderer = dispatch(nkType, registry);
  if (template === null || renderer === null) {
    return degrade("unknown-type", `notekit: no renderer registered for nk-type "${nkType}"`);
  }

  // From here on, everything is wrapped. `parseFenceBody` and `noteToRenderSpec` are total on a
  // string and a well-formed rubric, but the rubric comes from a hand-authored config file and the
  // renderer will throw on a malformed tree — both are real inputs, and neither is allowed to take
  // the note down with it.
  let element: HTMLElement;
  try {
    const fields = parseFenceBody(bodyOf(fence.code));
    const result = validate(noteToRenderSpec(fields, template.rubric, injected));
    if (!result.ok) {
      return degrade("invalid-spec", `notekit: ${result.error.message}`);
    }
    element = renderer(result.value);
  } catch (e) {
    return degrade("render-error", `notekit: could not render nk-${nkType} — ${messageOf(e)}`);
  }

  // Replace exactly the one `<pre>`, leaving every sibling — all the note's prose — untouched. A
  // `<pre>` with no parent cannot be replaced in place; appending keeps the card visible rather than
  // dropping it, and the fence stays too, which is the same shape as every other degrade here.
  //
  // A REJECTED REPLACEMENT TAKES THE SAME FALLBACK, and this is the one mutation in the file, so it is
  // also the one place the "never throws" contract could leak. Real DOM throws `NotFoundError` when
  // `fence.pre` is no longer a child of `fence.parent` — the parent is CAPTURED by the scan and then
  // the renderer runs, so any renderer that re-arranges the container invalidates it. v1's single
  // renderer builds a detached element and touches nothing, so the capture holds today; the guard is
  // what keeps that from being a property of the renderer table rather than of this function.
  const parent = fence.parent as { replaceChild?: (a: unknown, b: unknown) => unknown } | null;
  let replaced = false;
  if (parent !== null && typeof parent.replaceChild === "function") {
    try {
      parent.replaceChild(element, fence.pre);
      replaced = true;
    } catch {
      replaced = false;
    }
  }
  if (!replaced) container.appendChild(element);

  return { action: "rendered", nkType, element };
}
