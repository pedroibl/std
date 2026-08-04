import { test, expect, describe } from "bun:test";

import { resolveTemplate } from "./core-registry";
import type { NoteTypeRegistry } from "./core-registry";
import type { Rubric } from "./core-renderspec";

const RUBRIC: Rubric = { kind: "card", titleField: "title", fields: [{ key: "status" }] };

const REGISTRY: NoteTypeRegistry = {
  noteTypes: { card: "plain-card", primer: "catalog-card", protocol: "catalog-card" },
  templates: {
    "plain-card": { renderer: "nk-card", rubric: RUBRIC },
    "catalog-card": { renderer: "nk-card", rubric: RUBRIC },
  },
};

/** Cast a hand-built shape into the registry position — every one of these is a real runtime input. */
const as = (value: unknown): NoteTypeRegistry => value as NoteTypeRegistry;

describe("resolveTemplate — the happy two-level route (NK-1.7)", () => {
  test("routes nk-type → template → renderer id", () => {
    expect(resolveTemplate("card", REGISTRY)).toEqual({ renderer: "nk-card", rubric: RUBRIC });
  });

  test("several note types may share one template — FR15's primer/protocol over one renderer", () => {
    expect(resolveTemplate("primer", REGISTRY)).toEqual(resolveTemplate("protocol", REGISTRY));
  });

  test("the returned template carries exactly the two declared keys", () => {
    const registry = as({
      noteTypes: { card: "t" },
      templates: { t: { renderer: "nk-card", rubric: RUBRIC, extra: "smuggled" } },
    });
    expect(Object.keys(resolveTemplate("card", registry) ?? {}).sort()).toEqual([
      "renderer",
      "rubric",
    ]);
  });
});

describe("resolveTemplate — unknown is null, never a throw", () => {
  test("an unregistered type", () => {
    expect(resolveTemplate("timeline", REGISTRY)).toBeNull();
  });

  test("a template id that names nothing", () => {
    expect(resolveTemplate("card", as({ noteTypes: { card: "missing" }, templates: {} }))).toBeNull();
  });

  test("an empty or non-string type", () => {
    expect(resolveTemplate("", REGISTRY)).toBeNull();
    expect(resolveTemplate(7 as unknown as string, REGISTRY)).toBeNull();
    expect(resolveTemplate(null as unknown as string, REGISTRY)).toBeNull();
  });

  test("a registry that is not a registry", () => {
    for (const junk of [null, undefined, 7, "registry", [], {}, { noteTypes: [] }]) {
      expect(resolveTemplate("card", as(junk))).toBeNull();
    }
  });

  test("a half-written template entry reads as unregistered, not as a partial template", () => {
    const cases: unknown[] = [
      { noteTypes: { card: "t" }, templates: { t: null } },
      { noteTypes: { card: "t" }, templates: { t: [] } },
      { noteTypes: { card: "t" }, templates: { t: { rubric: RUBRIC } } },
      { noteTypes: { card: "t" }, templates: { t: { renderer: "", rubric: RUBRIC } } },
      { noteTypes: { card: "t" }, templates: { t: { renderer: 7, rubric: RUBRIC } } },
      { noteTypes: { card: "t" }, templates: { t: { renderer: "nk-card" } } },
      { noteTypes: { card: "t" }, templates: { t: { renderer: "nk-card", rubric: "x" } } },
      { noteTypes: { card: "t" }, templates: { t: { renderer: "nk-card", rubric: [] } } },
      { noteTypes: { card: 7 }, templates: { "7": { renderer: "nk-card", rubric: RUBRIC } } },
      { noteTypes: { card: "" }, templates: {} },
    ];
    for (const junk of cases) expect(resolveTemplate("card", as(junk))).toBeNull();
  });
});

describe("resolveTemplate — the prototype chain", () => {
  test("an INHERITED note-type name resolves to nothing", () => {
    // The Story 1.1 bug, in the registry's shape: a bare `noteTypes[nkType]` walks the chain, so a
    // fence reading ```nk-constructor``` would resolve to `Object` and be handed back as a template.
    // Every one of these names exists on Object.prototype and none of them is a registered type.
    for (const inherited of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(resolveTemplate(inherited, REGISTRY)).toBeNull();
    }
  });

  test("an inherited note-type whose value IS a real template id still resolves to nothing", () => {
    // The case above passes even without the own-property guard, because every name Object.prototype
    // ships holds a FUNCTION and the string check rejects it anyway. This is the case that isolates
    // the guard itself: a poisoned key whose value is a genuinely registered template id, which a
    // bare `noteTypes[nkType]` would route straight through to a real renderer.
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto["timeline"] = "plain-card";
      expect(resolveTemplate("timeline", REGISTRY)).toBeNull();
    } finally {
      delete proto["timeline"];
    }
  });

  test("an inherited TEMPLATE entry that is well-formed still resolves to nothing", () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto["ghost-template"] = { renderer: "nk-card", rubric: RUBRIC };
      const registry = as({ noteTypes: { card: "ghost-template" }, templates: {} });
      expect(resolveTemplate("card", registry)).toBeNull();
    } finally {
      delete proto["ghost-template"];
    }
  });

  test("an inherited TEMPLATE id resolves to nothing", () => {
    const registry = as({ noteTypes: { card: "constructor" }, templates: {} });
    expect(resolveTemplate("card", registry)).toBeNull();
  });

  test("an inherited `noteTypes`/`templates` level is not read as the registry's own", () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto["noteTypes"] = { card: "t" };
      proto["templates"] = { t: { renderer: "nk-card", rubric: RUBRIC } };
      expect(resolveTemplate("card", as({}))).toBeNull();
    } finally {
      delete proto["noteTypes"];
      delete proto["templates"];
    }
  });

  test("an inherited `renderer`/`rubric` cannot complete a half-written template", () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto["renderer"] = "nk-card";
      proto["rubric"] = RUBRIC;
      const registry = as({ noteTypes: { card: "t" }, templates: { t: {} } });
      expect(resolveTemplate("card", registry)).toBeNull();
    } finally {
      delete proto["renderer"];
      delete proto["rubric"];
    }
  });

  test("a null-prototype registry — the shape parseFenceBody-adjacent code produces — still works", () => {
    const noteTypes = Object.create(null) as Record<string, string>;
    noteTypes["card"] = "t";
    const templates = Object.create(null) as Record<string, unknown>;
    templates["t"] = { renderer: "nk-card", rubric: RUBRIC };
    expect(resolveTemplate("card", as({ noteTypes, templates }))).toEqual({
      renderer: "nk-card",
      rubric: RUBRIC,
    });
  });
});

// NOTE — there is deliberately no "this file is DOM-free" assertion here. `core-registry.ts` carries
// TWO real barriers already: it sits under the root (no-DOM-lib) tsconfig, so a stray `document` is a
// COMPILE error, and its `core-` filename prefix puts it in `check:core-purity`'s PURE_GLOBS. A third,
// weaker grep in this file would only be able to read the source as text — where the header's own
// prose about not referencing `document` is itself a match. A test that has to be written around its
// own subject is the kind that passes while meaning nothing.
