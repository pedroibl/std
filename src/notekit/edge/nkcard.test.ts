import { test, expect, describe, beforeEach, afterEach } from "bun:test";

import { escapeHtml } from "../../core";
import { nkTreeToHtml, NK_MAX_DEPTH } from "../core-html";
import { cardTree } from "../core-nknode";
import type { NkNode } from "../core-nknode";
import { noteToRenderSpec, validate } from "../core-renderspec";
import type { Injected, RenderSpec, Rubric } from "../core-renderspec";
import { parseFenceBody } from "../core-fence";
import { asStub, installStubDoc, makeStubDoc, stubToHtml } from "./dom-stub.support";
import type { StubDoc, StubEl } from "./dom-stub.support";
import { ensureStyles, nkTreeToDom, renderCardDom } from "./nkcard";

let doc: StubDoc;
let restore: () => void;

beforeEach(() => {
  doc = makeStubDoc();
  restore = installStubDoc(doc);
});
afterEach(() => {
  restore();
});

const INJECTED: Injected = { id: "nk-1", generatedAt: "2026-08-05T00:00:00.000Z" };

const RUBRIC: Rubric = {
  kind: "card",
  titleField: "title",
  fields: [
    { key: "status", label: "Status" },
    { key: "tags", label: "Tags" },
    { key: "url" },
  ],
};

/** Every class and id the tree emitted, flattened — the AD-8 / NK-2 namespace assertion's input. */
function allClasses(el: StubEl, out: string[] = []): string[] {
  if (el.className.length > 0) out.push(el.className);
  if (el.id.length > 0) out.push(el.id);
  for (const child of el.children) allClasses(child, out);
  return out;
}

// ───────────────────────────── the tree → DOM walk (AC #1) ─────────────────────────────

describe("nkTreeToDom — structure", () => {
  test("builds tag, class and text from the tree", () => {
    const el = asStub(nkTreeToDom({ tag: "div", class: "nk-card", text: "hello" }));
    expect(el.tagName).toBe("DIV");
    expect(el.className).toBe("nk-card");
    expect(el.textContent).toBe("hello");
  });

  test("recurses into children in declared order", () => {
    const el = asStub(
      nkTreeToDom({
        tag: "div",
        class: "nk-card",
        children: [
          { tag: "h3", class: "nk-card-title", text: "T" },
          { tag: "span", class: "nk-field-label", text: "L" },
        ],
      }),
    );
    expect(el.children.map((c) => c.tagName)).toEqual(["H3", "SPAN"]);
    expect(el.children.map((c) => c.className)).toEqual(["nk-card-title", "nk-field-label"]);
  });

  test("an empty class is omitted, not written as an empty attribute", () => {
    expect(asStub(nkTreeToDom({ tag: "div", class: "" })).className).toBe("");
  });

  test("TEXT IS SET BEFORE CHILDREN — a node carrying both keeps both", () => {
    // The regression this exists for: `textContent =` wipes every existing child, so setting text
    // after the append loop silently deletes the whole subtree. The stub models that wipe, so if the
    // order in `build` is ever flipped, this assertion is what fails.
    const el = asStub(
      nkTreeToDom({ tag: "div", class: "nk-card", text: "lead", children: [{ tag: "span" }] }),
    );
    expect(el.children.length).toBe(1);
    expect(el.textContent).toBe("lead");
  });
});

// ───────────────────── the tree's constraints, enforced on BOTH serializers ─────────────────────

describe("nkTreeToDom — NK_TAGS and NK_MAX_DEPTH (single-owner, NK-1.3)", () => {
  test("a tag outside the allowlist is refused, exactly as the string serializer refuses it", () => {
    const evil: NkNode = { tag: "script", text: "alert(1)" };
    expect(() => nkTreeToDom(evil)).toThrow(/not in the nk-node tag allowlist/);
    expect(() => nkTreeToHtml(evil)).toThrow(/not in the nk-node tag allowlist/);
  });

  test("no allowlisted tag is executable, resource-loading, or void", () => {
    // Guards the pair rather than the list: whatever the allowlist grows to, the DOM builder must
    // never be able to materialize one of these.
    for (const tag of ["script", "style", "iframe", "object", "embed", "link", "img", "br", "a"]) {
      expect(() => nkTreeToDom({ tag })).toThrow(/tag allowlist/);
    }
  });

  test("a cycle terminates on the depth bound instead of exhausting the stack", () => {
    const loop = { tag: "div", class: "nk-card" } as NkNode;
    loop.children = [loop];
    expect(() => nkTreeToDom(loop)).toThrow(new RegExp(`exceeds the ${NK_MAX_DEPTH}-level limit`));
  });

  test("both serializers agree on the depth at which a tree becomes too deep", () => {
    const deep = (levels: number): NkNode => {
      let node: NkNode = { tag: "span", text: "leaf" };
      for (let i = 1; i < levels; i++) node = { tag: "div", children: [node] };
      return node;
    };
    const ok = deep(NK_MAX_DEPTH);
    expect(() => nkTreeToDom(ok)).not.toThrow();
    expect(() => nkTreeToHtml(ok)).not.toThrow();

    const tooDeep = deep(NK_MAX_DEPTH + 1);
    expect(() => nkTreeToDom(tooDeep)).toThrow(/exceeds the/);
    expect(() => nkTreeToHtml(tooDeep)).toThrow(/exceeds the/);
  });
});

// ───────────────────────────── malformed nodes fail loud, by path ─────────────────────────────

describe("nkTreeToDom — malformed nodes", () => {
  test("a non-object node names its path", () => {
    expect(() => nkTreeToDom("nope" as unknown as NkNode)).toThrow(
      /nk-node at root: expected an object, got string/,
    );
    expect(() => nkTreeToDom(null as unknown as NkNode)).toThrow(/expected an object, got null/);
    expect(() => nkTreeToDom([] as unknown as NkNode)).toThrow(/expected an object, got object/);
  });

  test("a non-string tag, class or text is a malformed node", () => {
    expect(() => nkTreeToDom({ tag: 7 } as unknown as NkNode)).toThrow(/"tag" must be a string/);
    expect(() => nkTreeToDom({ tag: "div", class: 7 } as unknown as NkNode)).toThrow(
      /"class" must be a string/,
    );
    expect(() => nkTreeToDom({ tag: "div", text: {} } as unknown as NkNode)).toThrow(
      /"text" must be a string/,
    );
  });

  test("a malformed child reports its INDEX in the tree", () => {
    expect(() =>
      nkTreeToDom({ tag: "div", children: [{ tag: "span" }, 7] } as unknown as NkNode),
    ).toThrow(/nk-node at root.children\[1\]: expected an object, got number/);
  });

  test("non-array children is a malformed node", () => {
    expect(() => nkTreeToDom({ tag: "div", children: {} } as unknown as NkNode)).toThrow(
      /"children" must be an array/,
    );
  });
});

// ───────────────────────── adversarial: the prototype chain (the fourth time) ─────────────────────────

describe("nkTreeToDom — prototype poisoning", () => {
  test("a HOLE in children is refused even when Array.prototype supplies a node for it", () => {
    // `i in children` answers TRUE for an index inherited from Array.prototype, so the guard written
    // to keep holes out is exactly the guard that lets a poisoned value in. `hasOwnProperty` is the
    // only read that does not walk the chain — this is the fifth site of the bug that has now bitten
    // this slice four times, and it arrives here as a real appended element rather than as markup.
    const proto = Array.prototype as unknown as Record<number, unknown>;
    try {
      proto[0] = { tag: "div", class: "nk-poisoned", text: "POISONED" };
      const sparse = new Array(1) as NkNode[];
      expect(() => nkTreeToDom({ tag: "div", class: "nk-card", children: sparse })).toThrow(
        /children\[0\]: missing — children must be dense/,
      );
    } finally {
      delete proto[0];
    }
  });

  test("an inherited `text` is not read as the node's text", () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto["text"] = "POISONED";
      const el = asStub(nkTreeToDom({ tag: "div", class: "nk-card" }));
      expect(el.textContent).toBe("");
    } finally {
      delete proto["text"];
    }
  });

  test("an inherited `class` is not read as the node's class", () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto["class"] = "dashboard-prefix-poisoned";
      const el = asStub(nkTreeToDom({ tag: "div" }));
      expect(el.className).toBe("");
    } finally {
      delete proto["class"];
    }
  });

  test("inherited `children` are not walked", () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto["children"] = [{ tag: "span", class: "nk-poisoned", text: "POISONED" }];
      const el = asStub(nkTreeToDom({ tag: "div", class: "nk-card" }));
      expect(el.children.length).toBe(0);
    } finally {
      delete proto["children"];
    }
  });

  test("an inherited `tag` cannot supply a tag the node never declared", () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto["tag"] = "div";
      expect(() => nkTreeToDom({} as unknown as NkNode)).toThrow(/"tag" must be a string/);
    } finally {
      delete proto["tag"];
    }
  });
});

// ───────────────────────────── the `nk-` namespace (AC #1, AD-8 / NK-2) ─────────────────────────────

describe("the nk- namespace", () => {
  const spec = validate(
    noteToRenderSpec(
      parseFenceBody("title: A card\nstatus: live\ntags: [x, y]\nurl: https://e.example/a:b"),
      RUBRIC,
      INJECTED,
    ),
  );

  test("every class and id the card emits is nk-prefixed and crosses no sibling namespace", () => {
    expect(spec.ok).toBe(true);
    if (!spec.ok) return;
    const el = asStub(renderCardDom(spec.value));
    const emitted = allClasses(el);
    expect(emitted.length).toBeGreaterThan(0);
    for (const name of emitted) {
      expect(name).toMatch(/^nk-/);
      // The two sibling Obsidian edges share this vault; their prefixes must never appear here.
      expect(name).not.toMatch(/(?:^|\s)(?:dk|cn)-/);
    }
  });

  test("the injected style element and its rules are nk-prefixed too", () => {
    ensureStyles();
    const style = doc.head.children[0]!;
    expect(style.id).toBe("nk-base-styles");
    expect(style.textContent).toMatch(/\.nk-card\b/);
    expect(style.textContent).not.toMatch(/\.(?:dk|cn)-/);
  });
});

// ───────────────────────────── style injection is id-guarded ─────────────────────────────

describe("ensureStyles", () => {
  test("injects once, however many times it is called", () => {
    ensureStyles();
    ensureStyles();
    ensureStyles();
    expect(doc.head.children.length).toBe(1);
    expect(doc.head.children[0]!.tagName).toBe("STYLE");
  });

  test("renderCardDom injects the styles it needs", () => {
    const spec: RenderSpec = {
      version: "nk-v1",
      kind: "card",
      id: "i",
      generatedAt: "t",
      title: "T",
      fields: [],
    };
    renderCardDom(spec);
    renderCardDom(spec);
    expect(doc.head.children.length).toBe(1);
  });

  test("a caller-supplied id is honoured, so two bundles cannot collide", () => {
    ensureStyles("nk-other-styles");
    ensureStyles("nk-other-styles");
    expect(doc.head.children.length).toBe(1);
    expect(doc.head.children[0]!.id).toBe("nk-other-styles");
  });
});

// ───────────────────────── AC #4 — preview == vault, structurally (NFR8) ─────────────────────────

describe("preview == vault (AC #4)", () => {
  /** One tree, two serializers, byte-identical output — the property NK-1 rule 2 promises. */
  const agree = (tree: NkNode): void => {
    expect(stubToHtml(asStub(nkTreeToDom(tree)), escapeHtml)).toBe(nkTreeToHtml(tree));
  };

  test("a full card built from a fence body serializes identically on both paths", () => {
    const body = [
      "title: Ship the edge",
      "status: in review",
      "tags: [dom, degrade, parity]",
      "url: https://example.test/a:b?q=1",
    ].join("\n");
    const result = validate(noteToRenderSpec(parseFenceBody(body), RUBRIC, INJECTED));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    agree(cardTree(result.value));
  });

  test("text needing HTML escaping survives identically on both paths", () => {
    // The one place the two serializers do genuinely different work: the string builder escapes,
    // while the DOM builder relies on `textContent` never parsing markup. They must still agree.
    agree({
      tag: "div",
      class: "nk-card",
      children: [
        { tag: "h3", class: "nk-card-title", text: `<script>alert("x & y")</script>` },
        { tag: "span", class: "nk-field-value", text: "a < b && c > d" },
      ],
    });
  });

  test("a class needing escaping is escaped the same way on both paths", () => {
    agree({ tag: "div", class: `nk-card" onload="x` });
  });

  test("an empty-string field value renders as a present, empty node on both paths", () => {
    // Story 1.2's distinction: absent and present-but-empty are different states. Whatever the empty
    // value looks like, it must look the same in the vault as in the preview.
    const result = validate(
      noteToRenderSpec(parseFenceBody("title: T\nstatus: \ntags: []"), RUBRIC, INJECTED),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    agree(cardTree(result.value));
  });

  test("an empty card and a deeply nested tree both agree", () => {
    agree({ tag: "div", class: "nk-card" });
    let node: NkNode = { tag: "span", text: "leaf" };
    for (let i = 1; i < NK_MAX_DEPTH; i++) node = { tag: "div", class: "nk-x", children: [node] };
    agree(node);
  });
});
