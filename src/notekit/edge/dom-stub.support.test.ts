// Story 1.3 — tests for the TEST STUB (⚠️-2).
//
// A stub is production code for the tests that run against it, and an unfaithful one produces green
// that means nothing. Every assertion here pins a behaviour some production claim depends on: the file
// header of `dom-stub.support.ts` lists which claim rests on which behaviour, and this file is what
// stops that list from drifting away from the code.
//
// The deliberate leniencies (cycles, node moves, live collections, invalid tag names) are asserted
// too, with the reason they are safe — so a later reader learns the stub's shape from a test rather
// than from a surprise in the vault.

import { test, expect, describe } from "bun:test";

import { isText, makeEl, makeStubDoc, makeText, notFoundError } from "./dom-stub.support";

describe("the stub models the failures production is guarded on", () => {
  test("replaceChild THROWS NotFoundError when the node is not a child of this parent", () => {
    // The post-processor's one DOM mutation is guarded on exactly this. A stub that returned quietly
    // would let the guard be deleted with every test still green.
    const parent = makeEl("div");
    const kept = makeEl("p");
    const stranger = makeEl("pre");
    parent.appendChild(kept);

    let caught: unknown = null;
    try {
      parent.replaceChild(makeEl("div"), stranger);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("NotFoundError");
    // And it is a REJECTION, not a partial mutation: the parent is exactly as it was.
    expect(parent.children).toEqual([kept]);
  });

  test("replaceChild on a real child swaps in place and returns the replaced node", () => {
    const parent = makeEl("div");
    const first = makeEl("p");
    const target = makeEl("pre");
    const last = makeEl("p");
    for (const child of [first, target, last]) parent.appendChild(child);

    const card = makeEl("div");
    expect(parent.replaceChild(card, target)).toBe(target);
    expect(parent.children).toEqual([first, card, last]);
  });

  test("a stale parent is the real scenario: the child is removed, then the replace is rejected", () => {
    // What a renderer that re-arranged the container would do between the scan and the mutation.
    const parent = makeEl("div");
    const pre = makeEl("pre");
    parent.appendChild(pre);
    parent.nodes.length = 0; // the renderer detached it
    expect(() => parent.replaceChild(makeEl("div"), pre)).toThrow(/not a child/);
  });

  test("notFoundError carries the DOMException name real DOM reports", () => {
    expect(notFoundError("x").name).toBe("NotFoundError");
    expect(notFoundError("x").message).toBe("x");
  });
});

describe("the two behaviours the stub models exactly (header rules 1 and 2)", () => {
  test("assigning textContent DROPS every existing child", () => {
    // Why `nkTreeToDom` must set text BEFORE appending children: the reverse order deletes the subtree.
    const el = makeEl("div");
    el.appendChild(makeEl("span"));
    el.appendChild(makeText("tail"));
    el.textContent = "replaced";
    expect(el.children).toEqual([]);
    expect(el.nodes.length).toBe(1);
    expect(el.textContent).toBe("replaced");

    el.textContent = "";
    expect(el.nodes.length).toBe(0);
  });

  test("textContent reads the concatenation of every descendant's text", () => {
    const el = makeEl("div");
    const inner = makeEl("span");
    inner.textContent = "b";
    el.appendChild(makeText("a"));
    el.appendChild(inner);
    el.appendChild(makeText("c"));
    expect(el.textContent).toBe("abc");
  });

  test("tagName is UPPERCASE, as a real HTML document reports it", () => {
    expect(makeEl("pre").tagName).toBe("PRE");
    expect(makeEl("PRE").tagName).toBe("PRE");
  });

  test("children is elements only; nodes carries the text as well", () => {
    const el = makeEl("div");
    const kid = makeEl("p");
    el.appendChild(makeText("loose"));
    el.appendChild(kid);
    expect(el.children).toEqual([kid]);
    expect(el.nodes.map((n) => (isText(n) ? "text" : "el"))).toEqual(["text", "el"]);
  });
});

describe("the deliberate leniencies — asserted, with why each is safe", () => {
  test("appendChild does NOT reject a cycle, unlike real DOM's HierarchyRequestError", () => {
    // Safe because production never re-parents a node: it appends fresh, detached elements. The one
    // fixture that needs a cyclic container builds it by hand instead of relying on this.
    const el = makeEl("div");
    expect(() => el.appendChild(el)).not.toThrow();
    expect(el.children).toEqual([el]);
  });

  test("appendChild does NOT move the node out of its previous parent, unlike real DOM", () => {
    const a = makeEl("div");
    const b = makeEl("div");
    const kid = makeEl("p");
    a.appendChild(kid);
    b.appendChild(kid);
    expect(a.children).toEqual([kid]);
    expect(b.children).toEqual([kid]);
  });

  test("children is a fresh array per read — a real HTMLCollection is live", () => {
    // The post-processor's `childrenOf` snapshots because the real thing is live; the stub cannot
    // express that, so `post-processor.test.ts` pins the claim with a hand-built live collection.
    const el = makeEl("div");
    el.appendChild(makeEl("p"));
    const first = el.children;
    el.appendChild(makeEl("p"));
    expect(first.length).toBe(1);
    expect(el.children.length).toBe(2);
  });

  test("createElement accepts a tag real DOM would refuse", () => {
    // Safe because every tag the edge passes comes from the NK_TAGS allowlist or is a literal.
    expect(() => makeStubDoc().createElement("not a tag")).not.toThrow();
  });

  test("getElementById searches only under head, which is where the edge's one id lives", () => {
    const doc = makeStubDoc();
    const style = doc.createElement("style");
    style.id = "nk-base-styles";
    doc.head.appendChild(style);
    expect(doc.getElementById("nk-base-styles")).toBe(style);
    expect(doc.getElementById("nk-missing")).toBeNull();
  });
});
