import { test, expect, describe, beforeEach, afterEach } from "bun:test";

import type { NoteTypeRegistry } from "../core-registry";
import type { RenderSpec, Rubric } from "../core-renderspec";
import { asStub, installStubDoc, makeStubDoc } from "./dom-stub.support";
import type { StubDoc } from "./dom-stub.support";
import { dispatch, rendererFor } from "./dispatch";

let doc: StubDoc;
let restore: () => void;

beforeEach(() => {
  doc = makeStubDoc();
  restore = installStubDoc(doc);
});
afterEach(() => {
  restore();
});

const RUBRIC: Rubric = { kind: "card", titleField: "title", fields: [{ key: "status" }] };

const REGISTRY: NoteTypeRegistry = {
  noteTypes: { card: "plain-card", primer: "catalog-card" },
  templates: {
    "plain-card": { renderer: "nk-card", rubric: RUBRIC },
    "catalog-card": { renderer: "nk-card", rubric: RUBRIC },
  },
};

const SPEC: RenderSpec = {
  version: "nk-v1",
  kind: "card",
  id: "nk-1",
  generatedAt: "2026-08-05T00:00:00.000Z",
  title: "A card",
  fields: [{ key: "status", label: "Status", value: "live" }],
};

const as = (value: unknown): NoteTypeRegistry => value as NoteTypeRegistry;

describe("dispatch — routing (AC #1)", () => {
  test("a registered type resolves to a renderer that builds an nk-card element", () => {
    const renderer = dispatch("card", REGISTRY);
    expect(renderer).not.toBeNull();
    const el = asStub(renderer!(SPEC));
    expect(el.tagName).toBe("DIV");
    expect(el.className).toBe("nk-card");
  });

  test("two note types over one template resolve to the SAME renderer function", () => {
    // v1 ships exactly one renderer (D2 / SM-C1); the registry's middle level is what carries the
    // per-note-type difference, so this identity is the design, not an accident.
    expect(dispatch("card", REGISTRY)).toBe(dispatch("primer", REGISTRY));
  });
});

describe("dispatch — unknown is null, never a throw (AC #2)", () => {
  test("an unregistered note type", () => {
    expect(dispatch("timeline", REGISTRY)).toBeNull();
  });

  test("a template naming a renderer that does not exist", () => {
    const registry = as({
      noteTypes: { card: "t" },
      templates: { t: { renderer: "nk-timeline", rubric: RUBRIC } },
    });
    expect(dispatch("card", registry)).toBeNull();
  });

  test("a junk registry", () => {
    for (const junk of [null, undefined, 7, "registry", [], {}]) {
      expect(dispatch("card", as(junk))).toBeNull();
    }
  });
});

describe("rendererFor — the renderer table is read as DATA", () => {
  test("the shipped id resolves", () => {
    expect(typeof rendererFor("nk-card")).toBe("function");
  });

  test("an INHERITED name does not resolve to a callable", () => {
    // The Story 1.1 bug once more, at its last remaining site in this story: a bare `RENDERERS[id]`
    // returns `Object` for "constructor", which is callable — so `dispatch` would hand back a
    // "renderer", the post-processor would invoke it on the spec, and `Object(spec)` returns the spec
    // itself, which then gets appended to the note as if it were an element. Own-property only.
    for (const inherited of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(rendererFor(inherited)).toBeNull();
    }
  });

  test("an inherited name routed through a registry is also refused", () => {
    const registry = as({
      noteTypes: { card: "t" },
      templates: { t: { renderer: "constructor", rubric: RUBRIC } },
    });
    expect(dispatch("card", registry)).toBeNull();
  });

  test("an empty or non-string id", () => {
    expect(rendererFor("")).toBeNull();
    expect(rendererFor(7 as unknown as string)).toBeNull();
    expect(rendererFor(null as unknown as string)).toBeNull();
  });

  test("a poisoned Object.prototype cannot add an entry to the renderer table", () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto["nk-timeline"] = () => asStub(makeStubDoc().head);
      expect(rendererFor("nk-timeline")).toBeNull();
    } finally {
      delete proto["nk-timeline"];
    }
  });
});
