import { test, expect, describe, beforeEach, afterEach } from "bun:test";

import { parseFenceBody } from "../core-fence";
import type { NoteTypeRegistry } from "../core-registry";
import type { Injected, Rubric } from "../core-renderspec";
import { asStub, installStubDoc, makeEl, makeStubDoc, makeText } from "./dom-stub.support";
import type { StubDoc, StubEl } from "./dom-stub.support";
import { postProcess } from "./post-processor";

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
  fields: [{ key: "status", label: "Status" }, { key: "tags", label: "Tags" }, { key: "url" }],
};

const REGISTRY: NoteTypeRegistry = {
  noteTypes: { card: "plain-card" },
  templates: { "plain-card": { renderer: "nk-card", rubric: RUBRIC } },
};

const OPT_IN = { "nk-type": "card" } as const;

const BODY = [
  "title: Ship the edge",
  "status: in review",
  "tags: [dom, degrade, parity]",
  "url: https://example.test/a:b?q=1",
].join("\n");

const as = (value: unknown): NoteTypeRegistry => value as NoteTypeRegistry;
const el = (container: StubEl): HTMLElement => container as unknown as HTMLElement;

/**
 * A rendered note the way Obsidian hands it over: prose, then a fenced code block carrying the info
 * string on `code.language-nk-<type>`, then more prose.
 */
function makeNote(
  infoClass: string | null,
  body: string = BODY,
): { container: StubEl; pre: StubEl; before: StubEl; after: StubEl } {
  const container = makeEl("div");
  const before = makeEl("p");
  before.textContent = "prose before";
  const after = makeEl("p");
  after.textContent = "prose after";

  const pre = makeEl("pre");
  const code = makeEl("code");
  if (infoClass !== null) code.className = infoClass;
  code.textContent = body;
  pre.appendChild(code);

  container.appendChild(before);
  container.appendChild(pre);
  container.appendChild(after);
  return { container, pre, before, after };
}

/** A shallow structural snapshot — enough to prove "the note's other content is untouched". */
function snapshot(node: StubEl): unknown {
  return {
    tag: node.tagName,
    cls: node.className,
    kids: node.nodes.map((n) => (n.nodeType === 3 ? { text: n.data } : snapshot(n))),
  };
}

/** Collect a class's text from the rendered card, in document order. */
function textsWithClass(node: StubEl, cls: string, out: string[] = []): string[] {
  if (node.className === cls) out.push(node.textContent);
  for (const child of node.children) textsWithClass(child, cls, out);
  return out;
}

/** Count the notice elements anywhere under a container. */
function noticeCount(node: StubEl): number {
  return textsWithClass(node, "nk-notice").length;
}

// ─────────────────────────────── AC #1 — dispatch → card → DOM ───────────────────────────────

describe("postProcess — the rendering path (AC #1)", () => {
  test("replaces the fence with the card and leaves every sibling untouched", () => {
    const { container, pre, before, after } = makeNote("language-nk-card");
    const beforeSnap = snapshot(before);
    const afterSnap = snapshot(after);

    const result = postProcess({
      container: el(container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });

    expect(result.action).toBe("rendered");
    if (result.action !== "rendered") return;
    expect(result.nkType).toBe("card");
    expect(asStub(result.element).className).toBe("nk-card");

    // The `<pre>` is gone, replaced IN PLACE — same index, same siblings, same order.
    expect(container.children.map((c) => c.className)).toEqual(["", "nk-card", ""]);
    expect(container.children.includes(pre)).toBe(false);
    expect(snapshot(before)).toEqual(beforeSnap);
    expect(snapshot(after)).toEqual(afterSnap);
    expect(noticeCount(container)).toBe(0);
  });

  test("dispatches on the FENCE info string, not on the frontmatter value", () => {
    // NK-1.8 rule 2: frontmatter carries the opt-in, the fence carries the routing type. A
    // disagreement is not an error — the fence wins, because that is the region notekit owns.
    const { container } = makeNote("language-nk-card");
    const result = postProcess({
      container: el(container),
      frontmatter: { "nk-type": "primer" },
      registry: REGISTRY,
      injected: INJECTED,
    });
    expect(result.action).toBe("rendered");
    if (result.action !== "rendered") return;
    expect(result.nkType).toBe("card");
  });

  test("finds a fence nested inside a callout or wrapper", () => {
    const container = makeEl("div");
    const callout = makeEl("div");
    const inner = makeEl("div");
    const { container: note } = makeNote("language-nk-card");
    for (const child of note.nodes) inner.appendChild(child);
    callout.appendChild(inner);
    container.appendChild(callout);

    const result = postProcess({
      container: el(container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });
    expect(result.action).toBe("rendered");
  });

  test("tolerates the extra classes Obsidian puts alongside the language class", () => {
    const { container } = makeNote("is-loaded language-nk-card block-language-nk-card");
    expect(
      postProcess({
        container: el(container),
        frontmatter: OPT_IN,
        registry: REGISTRY,
        injected: INJECTED,
      }).action,
    ).toBe("rendered");
  });
});

// ────────────────────────────── AC #2 — no-op and the notice ──────────────────────────────

describe("postProcess — no-op (AC #2)", () => {
  test("no nk-fence in the note → no-op, container structurally identical", () => {
    const { container } = makeNote(null);
    const before = snapshot(container);
    const result = postProcess({
      container: el(container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });
    expect(result).toEqual({ action: "noop", reason: "no-fence" });
    expect(snapshot(container)).toEqual(before);
  });

  test("a note with no code block at all → no-op", () => {
    const container = makeEl("div");
    const p = makeEl("p");
    p.textContent = "just prose";
    container.appendChild(p);
    const before = snapshot(container);
    expect(
      postProcess({
        container: el(container),
        frontmatter: OPT_IN,
        registry: REGISTRY,
        injected: INJECTED,
      }),
    ).toEqual({ action: "noop", reason: "no-fence" });
    expect(snapshot(container)).toEqual(before);
  });

  test("no `nk-type:` frontmatter → no-op even with a well-formed fence present", () => {
    const { container } = makeNote("language-nk-card");
    const before = snapshot(container);
    for (const frontmatter of [{}, { "nk-type": "" }, { "nk-type": 7 }, { title: "x" }]) {
      expect(
        postProcess({
          container: el(container),
          frontmatter: frontmatter as Record<string, unknown>,
          registry: REGISTRY,
          injected: INJECTED,
        }),
      ).toEqual({ action: "noop", reason: "no-opt-in" });
    }
    expect(snapshot(container)).toEqual(before);
  });

  test("an info string outside the pinned `nk-[a-z]+` grammar is not an nk-fence", () => {
    // NK-4 pins the grammar. A near-miss must degrade to ordinary fenced code, not be half-routed.
    for (const cls of [
      "language-nk-Card",
      "language-nk-card2",
      "language-nk-",
      "language-nkcard",
      "language-nk-my-card",
      "language-typescript",
    ]) {
      const { container } = makeNote(cls);
      const before = snapshot(container);
      expect(
        postProcess({
          container: el(container),
          frontmatter: OPT_IN,
          registry: REGISTRY,
          injected: INJECTED,
        }),
      ).toEqual({ action: "noop", reason: "no-fence" });
      expect(snapshot(container)).toEqual(before);
    }
  });

  test("a `<pre>` with no `<code>` child, and a bare `<code>` with no `<pre>`, are both skipped", () => {
    const container = makeEl("div");
    const lonePre = makeEl("pre");
    lonePre.textContent = "title: x";
    const loneCode = makeEl("code");
    loneCode.className = "language-nk-card";
    loneCode.textContent = BODY;
    container.appendChild(lonePre);
    container.appendChild(loneCode);
    expect(
      postProcess({
        container: el(container),
        frontmatter: OPT_IN,
        registry: REGISTRY,
        injected: INJECTED,
      }),
    ).toEqual({ action: "noop", reason: "no-fence" });
  });
});

describe("postProcess — the non-corrupting notice (AC #2)", () => {
  test("an unregistered fence type keeps the fence and adds exactly one notice", () => {
    const { container, pre, before, after } = makeNote("language-nk-timeline");
    const beforeSnap = snapshot(before);
    const afterSnap = snapshot(after);
    const preSnap = snapshot(pre);

    const result = postProcess({
      container: el(container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });

    expect(result.action).toBe("notice");
    if (result.action !== "notice") return;
    expect(result.reason).toBe("unknown-type");
    expect(result.nkType).toBe("timeline");
    expect(result.detail).toMatch(/no renderer registered for nk-type "timeline"/);

    // The degrade is an ADDITION: the fence still shows its plain-markdown body, prose is byte-equal,
    // and exactly one element was added.
    expect(snapshot(pre)).toEqual(preSnap);
    expect(container.children.includes(pre)).toBe(true);
    expect(snapshot(before)).toEqual(beforeSnap);
    expect(snapshot(after)).toEqual(afterSnap);
    expect(noticeCount(container)).toBe(1);
    expect(asStub(result.element).className).toBe("nk-notice");
  });

  test("a spec that fails validate degrades with a notice, never a throw", () => {
    // `title` is the rubric's title field; without it `validate` rejects the spec by name.
    const { container, pre } = makeNote("language-nk-card", "status: in review");
    const preSnap = snapshot(pre);
    const result = postProcess({
      container: el(container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });
    expect(result.action).toBe("notice");
    if (result.action !== "notice") return;
    expect(result.reason).toBe("invalid-spec");
    expect(result.detail).toMatch(/"title" must be a non-empty string/);
    expect(snapshot(pre)).toEqual(preSnap);
    expect(noticeCount(container)).toBe(1);
  });

  test("an unexpected throw from the render path becomes a notice, not a broken note", () => {
    // A hand-authored config whose rubric is not iterable: `noteToRenderSpec` throws a raw TypeError.
    // Fail-loud is honoured by SHOWING it — a notice the reader sees beats an exception Obsidian eats
    // halfway through drawing the note.
    const registry = as({
      noteTypes: { card: "t" },
      templates: { t: { renderer: "nk-card", rubric: { kind: "card", titleField: "title", fields: 7 } } },
    });
    const { container, pre, after } = makeNote("language-nk-card");
    const afterSnap = snapshot(after);
    const preSnap = snapshot(pre);

    const result = postProcess({
      container: el(container),
      frontmatter: OPT_IN,
      registry,
      injected: INJECTED,
    });
    expect(result.action).toBe("notice");
    if (result.action !== "notice") return;
    expect(result.reason).toBe("render-error");
    expect(result.detail).toMatch(/could not render nk-card/);
    expect(snapshot(pre)).toEqual(preSnap);
    expect(snapshot(after)).toEqual(afterSnap);
    expect(noticeCount(container)).toBe(1);
  });

  test("no input shape makes postProcess throw", () => {
    const junkRegistries: unknown[] = [null, undefined, 7, "r", [], {}, { noteTypes: 1 }];
    for (const registry of junkRegistries) {
      const { container } = makeNote("language-nk-card");
      expect(() =>
        postProcess({
          container: el(container),
          frontmatter: OPT_IN,
          registry: as(registry),
          injected: INJECTED,
        }),
      ).not.toThrow();
    }
  });
});

// ────────────────── AC #3 — the degraded fence body is a SUPERSET of the card ──────────────────

describe("plugin-off degrade: the fence body is a superset of the card (AC #3, FR6)", () => {
  /**
   * The invariant, asserted on what is actually RENDERED rather than on the spec: every value the
   * card shows must appear verbatim in the fence body — the literal text a reader sees when the
   * plugin is off. It holds by construction because both draw on the ONE fence body (NK-1.8), and
   * that is exactly what makes it provable headlessly instead of needing a live plugin-off vault.
   *
   * Provenance (version/kind/id/generatedAt) is deliberately out of scope: it is injected metadata,
   * not a field, and AC #3 speaks of "every field shown in the rendered card".
   */
  const assertSuperset = (body: string): void => {
    const { container } = makeNote("language-nk-card", body);
    const result = postProcess({
      container: el(container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });
    expect(result.action).toBe("rendered");
    if (result.action !== "rendered") return;

    const card = asStub(result.element);
    const shown = [
      ...textsWithClass(card, "nk-card-title"),
      ...textsWithClass(card, "nk-field-value"),
    ];
    expect(shown.length).toBeGreaterThan(0);

    // (a) every shown value is one the codec reads back out of the degraded body, and
    // (b) every shown value is literally present in the degraded text the reader sees.
    const fenceValues = Object.values(parseFenceBody(body)).flatMap((v) =>
      Array.isArray(v) ? v : [v],
    );
    for (const value of shown) {
      expect(fenceValues).toContain(value);
      expect(body).toContain(value);
    }
  };

  test("the standard card", () => {
    assertSuperset(BODY);
  });

  test("a colon-bearing value (a URL) is not split by the codec", () => {
    assertSuperset("title: T\nstatus: ok\nurl: https://example.test/a:b?q=1#frag");
  });

  test("a list value — every element shows, every element is in the body", () => {
    assertSuperset("title: T\ntags: [alpha, beta, gamma]");
  });

  test("a present-but-empty value stays a present, empty node", () => {
    assertSuperset("title: T\nstatus: \ntags: [x]");
  });

  test("a value carrying HTML metacharacters is shown verbatim, not escaped away", () => {
    assertSuperset("title: T\nstatus: a < b && c > d\nurl: x\"y'z");
  });

  test("a rubric key absent from the body simply shows no row", () => {
    assertSuperset("title: T\nstatus: only this one");
  });

  test("the card never shows a field the fence body does not carry", () => {
    // The other direction of the same claim: superset, not equality — the body may carry more (a key
    // the rubric does not select), but the card may never carry more than the body.
    const body = "title: T\nstatus: live\nunselected: not in the rubric";
    const { container } = makeNote("language-nk-card", body);
    const result = postProcess({
      container: el(container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });
    expect(result.action).toBe("rendered");
    if (result.action !== "rendered") return;
    const shown = textsWithClass(asStub(result.element), "nk-field-value");
    expect(shown).toEqual(["live"]);
    expect(shown).not.toContain("not in the rubric");
  });
});

// ─────────────────────────────── adversarial: the input domain ───────────────────────────────

describe("postProcess — adversarial inputs", () => {
  test("an INHERITED `nk-type` is not an opt-in", () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto["nk-type"] = "card";
      const { container } = makeNote("language-nk-card");
      const before = snapshot(container);
      expect(
        postProcess({
          container: el(container),
          frontmatter: {},
          registry: REGISTRY,
          injected: INJECTED,
        }),
      ).toEqual({ action: "noop", reason: "no-opt-in" });
      expect(snapshot(container)).toEqual(before);
    } finally {
      delete proto["nk-type"];
    }
  });

  test("a non-string className (the SVGAnimatedString case) does not throw", () => {
    const container = makeEl("div");
    const pre = makeEl("pre");
    const code = makeEl("code");
    (code as unknown as Record<string, unknown>)["className"] = { baseVal: "language-nk-card" };
    pre.appendChild(code);
    container.appendChild(pre);
    expect(
      postProcess({
        container: el(container),
        frontmatter: OPT_IN,
        registry: REGISTRY,
        injected: INJECTED,
      }),
    ).toEqual({ action: "noop", reason: "no-fence" });
  });

  test("a non-string textContent on the code element reads as an empty body", () => {
    const { container } = makeNote("language-nk-card");
    const code = container.children[1]!.children[0]!;
    Object.defineProperty(code, "textContent", { value: 7, configurable: true });
    const result = postProcess({
      container: el(container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });
    // An empty body yields no title, so `validate` rejects it — a notice, never a throw.
    expect(result.action).toBe("notice");
  });

  test("a cyclic container terminates on the scan bound instead of hanging", () => {
    const container = makeEl("div");
    container.appendChild(container);
    expect(
      postProcess({
        container: el(container),
        frontmatter: OPT_IN,
        registry: REGISTRY,
        injected: INJECTED,
      }),
    ).toEqual({ action: "noop", reason: "no-fence" });
  });

  test("a fence buried deeper than the scan bound is a no-op, not a hang or a throw", () => {
    const container = makeEl("div");
    let cursor = container;
    for (let i = 0; i < 60; i++) {
      const next = makeEl("div");
      cursor.appendChild(next);
      cursor = next;
    }
    const { container: note } = makeNote("language-nk-card");
    for (const child of note.nodes) cursor.appendChild(child);
    expect(
      postProcess({
        container: el(container),
        frontmatter: OPT_IN,
        registry: REGISTRY,
        injected: INJECTED,
      }),
    ).toEqual({ action: "noop", reason: "no-fence" });
  });

  test("a `<pre>` whose parent cannot replace it still surfaces the card", () => {
    // A hand-built container missing `replaceChild`: the card is appended rather than dropped, and
    // nothing throws into the note.
    const { container, pre } = makeNote("language-nk-card");
    Object.defineProperty(container, "replaceChild", { value: undefined, configurable: true });
    const result = postProcess({
      container: el(container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });
    expect(result.action).toBe("rendered");
    expect(container.children.includes(pre)).toBe(true);
    expect(textsWithClass(container, "nk-card").length).toBe(1);
  });

  test("text nodes between elements are never mistaken for children or disturbed", () => {
    const container = makeEl("div");
    container.appendChild(makeText("loose prose"));
    const { container: note } = makeNote("language-nk-card");
    for (const child of note.nodes) container.appendChild(child);
    container.appendChild(makeText("trailing prose"));

    const result = postProcess({
      container: el(container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });
    expect(result.action).toBe("rendered");
    const texts = container.nodes.filter((n) => n.nodeType === 3).map((n) => n.data);
    expect(texts).toEqual(["loose prose", "trailing prose"]);
  });

  test("the rendered card carries no sibling edge's namespace", () => {
    const { container } = makeNote("language-nk-card");
    const result = postProcess({
      container: el(container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });
    expect(result.action).toBe("rendered");
    if (result.action !== "rendered") return;
    const names: string[] = [];
    const walk = (node: StubEl): void => {
      if (node.className.length > 0) names.push(node.className);
      for (const child of node.children) walk(child);
    };
    walk(asStub(result.element));
    for (const name of names) expect(name).toMatch(/^nk-/);
  });
});
