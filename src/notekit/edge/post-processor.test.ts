import { test, expect, describe, beforeEach, afterEach } from "bun:test";

import { parseFenceBody } from "../core-fence";
import type { NoteTypeRegistry } from "../core-registry";
import type { Injected, Rubric } from "../core-renderspec";
import { asStub, installStubDoc, makeEl, makeStubDoc, makeText } from "./dom-stub.support";
import type { StubDoc, StubEl } from "./dom-stub.support";
import { postProcess } from "./post-processor";
import type { PostProcessResult } from "./post-processor";

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

/**
 * Call `postProcess`, assert it RETURNED rather than threw, and hand back what it returned. The two
 * halves of AC #2 are "no error is thrown into the note" and "the outcome is one of the named ones",
 * and a test that only asserts `.not.toThrow()` proves the first while saying nothing about the
 * second — which is how a swallowed failure passes for a degrade.
 */
function runSafely(input: Parameters<typeof postProcess>[0]): PostProcessResult {
  const captured: { value?: PostProcessResult } = {};
  expect(() => {
    captured.value = postProcess(input);
  }).not.toThrow();
  expect(captured.value).toBeDefined();
  return captured.value as PostProcessResult;
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
      const { container, pre } = makeNote("language-nk-card");
      const result = runSafely({
        container: el(container),
        frontmatter: OPT_IN,
        registry: as(registry),
        injected: INJECTED,
      });
      // Not merely "did not throw": every one of these is the DESIGNED unknown-type degrade, reached
      // through the registry's own totality. If the outer net had been what caught it the action would
      // read `failed`, and the assertion below is what tells those two apart.
      expect(result.action).toBe("notice");
      if (result.action !== "notice") continue;
      expect(result.reason).toBe("unknown-type");
      expect(container.children.includes(pre)).toBe(true);
      expect(noticeCount(container)).toBe(1);
    }
  });
});

// ────────────── AC #2, per stage: force a failure at every step and watch it return ──────────────

describe("postProcess — the non-corrupting promise holds at every stage", () => {
  /** Assert the shape every degrade must have: prose intact, fence kept, at most one notice. */
  const assertNoteIntact = (
    container: StubEl,
    pre: StubEl,
    snaps: { before: unknown; after: unknown; pre: unknown },
  ): void => {
    const [before, , after] = container.children;
    expect(snapshot(before!)).toEqual(snaps.before);
    expect(snapshot(after!)).toEqual(snaps.after);
    expect(snapshot(pre)).toEqual(snaps.pre);
    expect(container.children.includes(pre)).toBe(true);
    expect(noticeCount(container)).toBeLessThanOrEqual(1);
  };

  const snapsOf = (parts: { pre: StubEl; before: StubEl; after: StubEl }) => ({
    before: snapshot(parts.before),
    after: snapshot(parts.after),
    pre: snapshot(parts.pre),
  });

  test("stage 1 — an unparseable fence body: no field survives, and validate names the gap", () => {
    // `parseFenceBody` is total by design, so garbage does not throw — it yields no fields, and the
    // failure surfaces one layer up as a named validation error rather than as an exception.
    const parts = makeNote("language-nk-card", "%%% not a fence body %%%\n\n\t\n:::");
    const snaps = snapsOf(parts);
    const result = postProcess({
      container: el(parts.container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });
    expect(result.action).toBe("notice");
    if (result.action !== "notice") return;
    expect(result.reason).toBe("invalid-spec");
    expect(noticeCount(parts.container)).toBe(1);
    assertNoteIntact(parts.container, parts.pre, snaps);
  });

  test("stage 2 — dispatch returns null (unknown type)", () => {
    const parts = makeNote("language-nk-timeline");
    const snaps = snapsOf(parts);
    const result = postProcess({
      container: el(parts.container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });
    expect(result.action).toBe("notice");
    expect(noticeCount(parts.container)).toBe(1);
    assertNoteIntact(parts.container, parts.pre, snaps);
  });

  test("stage 3 — THE RENDERER ITSELF throws part-way through building the card", () => {
    // Not the spec builder (covered above) — the DOM walk. `nkTreeToDom` is fail-loud by design, so a
    // document that refuses one of the card's tags makes it throw mid-build, leaving a half-built
    // detached element behind. The note must not see it.
    const parts = makeNote("language-nk-card");
    const snaps = snapsOf(parts);
    const build = doc.createElement;
    doc.createElement = (tag: string): StubEl => {
      if (tag === "h3") throw new Error("InvalidCharacterError: refused by the host");
      return build(tag);
    };

    const result = postProcess({
      container: el(parts.container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });
    expect(result.action).toBe("notice");
    if (result.action !== "notice") return;
    expect(result.reason).toBe("render-error");
    expect(result.detail).toMatch(/refused by the host/);
    expect(noticeCount(parts.container)).toBe(1);
    assertNoteIntact(parts.container, parts.pre, snaps);
    expect(textsWithClass(parts.container, "nk-card").length).toBe(0);
  });

  test("stage 4 — THE DOM MUTATION IS REJECTED because a renderer moved the fence", () => {
    // The regression for the one mutation that used to sit outside the guarded region. `findFence`
    // CAPTURES the parent, then the renderer runs; a renderer that re-arranges the container makes
    // `fence.pre` a stranger to that parent, and real DOM answers `replaceChild` with NotFoundError.
    // Reproduced through the renderer, not by planting a thrower: the stub's own `replaceChild` is
    // what rejects, exactly as the vault's would.
    const { container, pre, before, after } = makeNote("language-nk-card");
    const beforeSnap = snapshot(before);
    const afterSnap = snapshot(after);
    const build = doc.createElement;
    let moved = false;
    doc.createElement = (tag: string): StubEl => {
      if (!moved) {
        moved = true;
        container.nodes.splice(container.nodes.indexOf(pre), 1); // the renderer detached the fence
      }
      return build(tag);
    };

    const result = runSafely({
      container: el(container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });

    // The card is still delivered — appended rather than dropped, the same fallback an unreplaceable
    // `<pre>` already took — and the note's prose is byte-equal on both sides.
    expect(result.action).toBe("rendered");
    expect(textsWithClass(container, "nk-card").length).toBe(1);
    expect(container.children.at(-1)!.className).toBe("nk-card");
    expect(snapshot(before)).toEqual(beforeSnap);
    expect(snapshot(after)).toEqual(afterSnap);
    expect(noticeCount(container)).toBe(0);
  });

  test("stage 4 — a parent whose replaceChild throws something else takes the same fallback", () => {
    const { container, pre } = makeNote("language-nk-card");
    Object.defineProperty(container, "replaceChild", {
      value: () => {
        throw new Error("host refused the replacement");
      },
      configurable: true,
    });
    const result = postProcess({
      container: el(container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });
    expect(result.action).toBe("rendered");
    expect(container.children.includes(pre)).toBe(true);
    expect(textsWithClass(container, "nk-card").length).toBe(1);
    expect(noticeCount(container)).toBe(0);
  });

  test("stage 5 — a host that cannot even build the notice still RETURNS", () => {
    // The outer net, and the only case that reaches it: `document.createElement` refuses everything,
    // so the render throws AND the degrade's own notice cannot be built. Nothing is thrown into the
    // note and nothing is added to it — the reader keeps the plain fence body, which is FR6's floor.
    const { container, pre } = makeNote("language-nk-card");
    const containerSnap = snapshot(container);
    doc.createElement = (): StubEl => {
      throw new Error("no document");
    };

    const result = runSafely({
      container: el(container),
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });

    expect(result.action).toBe("failed");
    if (result.action !== "failed") return;
    expect(result.reason).toBe("host-dom-unusable");
    expect(result.detail).toMatch(/no document/);
    expect(snapshot(container)).toEqual(containerSnap);
    expect(container.children.includes(pre)).toBe(true);
    expect(noticeCount(container)).toBe(0);
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
    // Built by hand rather than with `appendChild`: real DOM answers an append that would create a
    // cycle with `HierarchyRequestError`, so a cyclic container can only arrive from a hand-built or
    // proxied object — which is exactly the input the scan bound exists for.
    const container = makeEl("div");
    container.nodes.push(container);
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

  test("a LIVE children collection — the one real-DOM semantic the stub cannot model", () => {
    // `HTMLCollection` is live: it reflects mutations as the walk reads it, which is why `childrenOf`
    // reads `length` once and indexes rather than trusting the collection to hold still. The stub's
    // `children` is a fresh array, so that claim is pinned here instead, with a collection that empties
    // itself the moment it is first indexed — the worst case of liveness during a scan.
    const kids: unknown[] = [makeEl("p"), makeEl("pre"), makeEl("p")];
    const live: Record<string, unknown> = {
      get length(): number {
        return kids.length;
      },
    };
    for (let i = 0; i < 3; i++) {
      Object.defineProperty(live, i, {
        get(): unknown {
          const at = kids[i];
          kids.length = 0; // the host re-rendered mid-scan
          return at;
        },
      });
    }
    const hostile = { tagName: "DIV", className: "", children: live };

    const result = runSafely({
      container: hostile as unknown as HTMLElement,
      frontmatter: OPT_IN,
      registry: REGISTRY,
      injected: INJECTED,
    });
    expect(result).toEqual({ action: "noop", reason: "no-fence" });
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
