// Story 1.3 — the hand-rolled `document` stub the edge tests run against (⚠️-2).
//
// ZERO DEP, DELIBERATELY. `bun test` has no DOM and devDeps are frozen at {@types/bun, typescript,
// yaml}. Reaching for happy-dom or jsdom would add a runtime-adjacent dependency and break the
// zero-dep contract (D4/NFR3), so the estate's other Obsidian edges install a minimal hand-rolled
// `document` on `globalThis` instead. This is that idiom, extended with exactly the surface the
// notekit edge touches and no more.
//
// It lives in a shared `.support.ts` rather than being copied into three test files because the
// semantics below are the load-bearing part, and three drifting copies of a stub is three chances for
// a test to pass against a fiction. The filename matches neither `bun test`'s discovery globs nor the
// edge tsconfig's `**/*.test.ts` carve-out, so it is typechecked under `types: []` alongside the
// deployed sources — which is correct: it is plain DOM-typed code with no test-runner imports.
//
// WHERE IT IS FAITHFUL, AND WHY THAT MATTERS. A stub that models what is convenient makes tests that
// assert about the stub. Two behaviours here are modelled exactly because production code depends on
// them and a lazier stub would hide a real bug:
//
//   1. TEXT IS A CHILD NODE, and `textContent =` REPLACES EVERY CHILD. That is real DOM, and it is
//      why `nkTreeToDom` must set text BEFORE appending children. Model `textContent` as an
//      independent string field and that ordering bug becomes invisible — the stub would happily keep
//      both, while the vault would render a card stripped down to its title.
//   2. `tagName` IS UPPERCASE. Real DOM reports `PRE`, and the fence scan compares case-insensitively
//      because of it. A lowercase stub would let a case-sensitive comparison ship green and then
//      match nothing in Obsidian.
//   3. `replaceChild` THROWS `NotFoundError` when the node to replace is not a child of this parent.
//      That is real DOM's `NotFoundError` `DOMException`, and the post-processor's one DOM mutation is
//      guarded on exactly it. A stub that returned quietly here would let that guard be deleted with
//      every test still green — the green lie this file exists to prevent.
//
// WHERE IT IS DELIBERATELY LENIENT, AND WHY THAT IS SAFE. The rest of the divergence from real DOM is
// listed here rather than left to be rediscovered; each line names the production claim that would
// have to change before the leniency starts to matter:
//
//   - `appendChild` does not reject a CYCLE. Real DOM throws `HierarchyRequestError` when the new node
//     is an inclusive ancestor of the parent. Nothing in production ever re-parents a node — it appends
//     freshly-created, detached elements — so no claim rests on the rejection. The one fixture that
//     needs a cyclic container therefore builds it by hand (`nodes.push`), the way a hostile or
//     hand-built container would arrive, not by calling `appendChild`.
//   - `appendChild` does not MOVE the node out of its previous parent. Real DOM does. Same reason: the
//     edge only ever appends fresh elements, and `replaceChild`'s replacement is always detached.
//   - `children` is a fresh array per read; a real `HTMLCollection` is LIVE. `childrenOf` in the
//     post-processor snapshots for exactly that reason, and since the stub cannot express liveness the
//     claim is pinned instead by a hand-built live collection in `post-processor.test.ts`.
//   - `createElement` never throws. Real DOM throws `InvalidCharacterError` on an invalid tag name;
//     `nkcard.ts` only ever passes a member of the `NK_TAGS` allowlist (all valid element names) or the
//     literal `"div"`/`"style"`, which is what makes that unreachable rather than merely unlikely.
//   - `getElementById` searches only under `head`. The only id-guarded element the edge owns is the
//     injected `<style>`, which lives in head.
//   - `className` is a plain string. Real DOM hands back an `SVGAnimatedString` on an SVG element, and
//     `fenceTypeOf` reads it defensively because of that; the fixture for that case plants a non-string
//     `className` directly rather than relying on the stub to model SVG.

/** A text node — modelled explicitly so `textContent` can behave the way the real thing does. */
export type StubText = { nodeType: 3; data: string };

/** An element. `nodes` is the full child list (text and elements); `children` is elements only. */
export type StubEl = {
  nodeType: 1;
  tagName: string;
  className: string;
  id: string;
  nodes: Array<StubEl | StubText>;
  readonly children: StubEl[];
  textContent: string;
  appendChild(child: StubEl | StubText): StubEl | StubText;
  replaceChild(next: StubEl | StubText, prev: StubEl | StubText): StubEl | StubText;
};

export function isText(node: StubEl | StubText): node is StubText {
  return node.nodeType === 3;
}

/**
 * The failure real DOM signals with a `NotFoundError` `DOMException`. Built from a plain `Error` with
 * the `name` set rather than from the `DOMException` constructor: the stub depends on no global beyond
 * what it installs, and `name` is the part a caller can branch on.
 */
export function notFoundError(message: string): Error {
  const e = new Error(message);
  e.name = "NotFoundError";
  return e;
}

/** Build a stub element. `tagName` is uppercased to match what a real HTML document reports. */
export function makeEl(tag: string): StubEl {
  const nodes: Array<StubEl | StubText> = [];
  const el: StubEl = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    className: "",
    id: "",
    nodes,
    get children(): StubEl[] {
      return nodes.filter((n): n is StubEl => !isText(n));
    },
    get textContent(): string {
      // Real DOM concatenates the text of every descendant, so this does too.
      return nodes.map((n) => (isText(n) ? n.data : n.textContent)).join("");
    },
    set textContent(value: string) {
      // The whole point of the stub: assigning textContent DROPS every existing child and leaves at
      // most one text node behind. Assigning "" leaves none at all.
      nodes.length = 0;
      if (value.length > 0) nodes.push({ nodeType: 3, data: value });
    },
    appendChild(child) {
      nodes.push(child);
      return child;
    },
    replaceChild(next, prev) {
      const at = nodes.indexOf(prev);
      if (at < 0) throw notFoundError("replaceChild: node is not a child of this parent");
      nodes[at] = next;
      return prev;
    },
  };
  return el;
}

/** A text node, for building fixtures that mix prose with elements. */
export function makeText(data: string): StubText {
  return { nodeType: 3, data };
}

export type StubDoc = {
  head: StubEl;
  createElement(tag: string): StubEl;
  getElementById(id: string): StubEl | null;
};

function findById(root: StubEl, id: string): StubEl | null {
  for (const child of root.children) {
    if (child.id === id) return child;
    const found = findById(child, id);
    if (found !== null) return found;
  }
  return null;
}

export function makeStubDoc(): StubDoc {
  const head = makeEl("head");
  return {
    head,
    createElement: (tag: string) => makeEl(tag),
    // The edge only ever id-guards the injected `<style>`, which lives in head — but the walk is
    // recursive so a test that parks an element deeper does not get a silently wrong answer.
    getElementById: (id: string) => (head.id === id ? head : findById(head, id)),
  };
}

/** Install the stub on `globalThis`, returning the restore thunk for `afterEach`. */
export function installStubDoc(doc: StubDoc): () => void {
  const slot = globalThis as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(slot, "document");
  const previous = slot["document"];
  slot["document"] = doc;
  return () => {
    // Restore by DELETING when there was no own `document` before, rather than assigning `undefined`.
    // Another suite in the same `bun test` process may install its own shim on the shared global, and
    // leaving an own `undefined` behind is not the same state as leaving none.
    if (had) slot["document"] = previous;
    else delete slot["document"];
  };
}

/** The cast every test needs: the edge returns `HTMLElement`, the stub is what it actually built. */
export function asStub(el: unknown): StubEl {
  return el as unknown as StubEl;
}

/**
 * Serialize a stub element to HTML with the SAME rules `core-html.ts` uses — attribute, then text,
 * then children; an empty class omitted; no inter-tag whitespace. This is what makes AC #4 provable
 * headlessly: run one tree through both serializers and the strings must be byte-identical.
 *
 * `escape` is injected rather than imported so this file stays free of any dependency on core; the
 * tests pass `core.escapeHtml`, the one escaper the string serializer uses.
 */
export function stubToHtml(el: StubEl, escape: (s: string) => string): string {
  const tag = el.tagName.toLowerCase();
  const attrs = el.className.length > 0 ? ` class="${escape(el.className)}"` : "";
  let inner = "";
  for (const node of el.nodes) {
    inner += isText(node) ? escape(node.data) : stubToHtml(node, escape);
  }
  return `<${tag}${attrs}>${inner}</${tag}>`;
}
