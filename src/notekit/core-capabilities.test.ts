import { test, expect } from "bun:test";
import { CATALOG_VERSION, capabilities, type CapabilitiesCatalog } from "./core-capabilities";
import { resolveTemplate, type NoteTypeRegistry } from "./core-registry";
import type { Rubric } from "./core-renderspec";

const CARD_RUBRIC: Rubric = {
  kind: "card",
  titleField: "title",
  fields: [{ key: "summary", label: "SUMMARY" }, { key: "status" }],
};

function registry(): NoteTypeRegistry {
  return {
    noteTypes: { card: "catalog-card" },
    templates: { "catalog-card": { renderer: "nk-card", rubric: CARD_RUBRIC } },
  };
}

test("the catalog is generated from the registry, pinned at nk-cap-v1", () => {
  expect(capabilities(registry())).toEqual({
    catalogVersion: "nk-cap-v1",
    noteTypes: [
      {
        nkType: "card",
        templateId: "catalog-card",
        renderer: "nk-card",
        titleField: "title",
        fields: [
          { key: "summary", label: "SUMMARY" },
          // `label` defaults to `key` — the exact default noteToRenderSpec applies, so the catalog
          // advertises the label the card actually renders. Left undefined, JSON would drop the key.
          { key: "status", label: "status" },
        ],
      },
    ],
  });
  expect(CATALOG_VERSION).toBe("nk-cap-v1");
});

// NFR5 — the single-source claim, proven by removal rather than asserted.
test("a note type absent from the registry is absent from the catalog", () => {
  const two = registry();
  const withPrimer: NoteTypeRegistry = {
    noteTypes: { ...two.noteTypes, primer: "catalog-primer" },
    templates: { ...two.templates, "catalog-primer": { renderer: "nk-card", rubric: CARD_RUBRIC } },
  };
  expect(capabilities(withPrimer).noteTypes.map((n) => n.nkType)).toEqual(["card", "primer"]);
  // remove it and re-run — the catalog follows the registry, it does not carry its own list
  expect(capabilities(two).noteTypes.map((n) => n.nkType)).toEqual(["card"]);
});

test("the catalog JSON round-trips — the same serializability promise NK-1 rule 1 makes", () => {
  const catalog = capabilities(registry());
  const revived = JSON.parse(JSON.stringify(catalog)) as CapabilitiesCatalog;
  expect(revived).toEqual(catalog);
});

// ── E1-A3 input class (a) — prototype-chain names ────────────────────────────────────────────────

// MEASURED, so nobody over-reads this test: the claim is carried by ROUTING THROUGH
// `resolveTemplate`, not by the `Object.keys` enumeration idiom. Switching this file to `for...in`
// plus a bare prototype-walking index read leaves it GREEN, because `resolveTemplate` does its own
// own-property reads and returns null for an inherited name. It goes RED the moment the generator
// abandons `resolveTemplate` and hand-walks the registry — which is precisely the second walk NK-1.7
// forbids, so the guard bites on the failure that matters and not on a style choice.
test("an INHERITED prototype-chain name contributes no entry — enumeration is own-key only", () => {
  const proto = Object.prototype as unknown as Record<string, unknown>;
  proto["primer"] = "catalog-card";
  try {
    expect(capabilities(registry()).noteTypes.map((n) => n.nkType)).toEqual(["card"]);
  } finally {
    delete proto["primer"];
  }
});

test("an OWN key named `constructor` IS a legitimate note type and IS emitted", () => {
  // The catalog and the dispatcher must agree BY CONSTRUCTION: a catalog that refused this key would
  // advertise a different set than resolveTemplate accepts, which is exactly the single-source break
  // this generator exists to prevent. Both halves asserted in one test, on the one input where a
  // careless implementation breaks the identity.
  const reg: NoteTypeRegistry = {
    noteTypes: { constructor: "catalog-card" },
    templates: { "catalog-card": { renderer: "nk-card", rubric: CARD_RUBRIC } },
  };
  expect(capabilities(reg).noteTypes.map((n) => n.nkType)).toEqual(["constructor"]);
  expect(resolveTemplate("constructor", reg)).not.toBeNull();
});

// ── E1-A3 input class (b) — sparse / holed arrays ────────────────────────────────────────────────

test("a hole in rubric.fields contributes no phantom row, even with the prototype poisoned", () => {
  const holed: Rubric = {
    kind: "card",
    titleField: "title",
    fields: [{ key: "summary" }, , { key: "status" }] as unknown as Rubric["fields"],
  };
  const reg: NoteTypeRegistry = {
    noteTypes: { card: "catalog-card" },
    templates: { "catalog-card": { renderer: "nk-card", rubric: holed } },
  };
  const proto = Array.prototype as unknown as Record<number, unknown>;
  proto[1] = { key: "POISONED" };
  try {
    expect(capabilities(reg).noteTypes[0]!.fields).toEqual([
      { key: "summary", label: "summary" },
      { key: "status", label: "status" },
    ]);
  } finally {
    delete proto[1];
  }
});

test("a non-array rubric.fields yields no rows rather than a throw", () => {
  const reg: NoteTypeRegistry = {
    noteTypes: { card: "catalog-card" },
    templates: {
      "catalog-card": {
        renderer: "nk-card",
        rubric: { kind: "card", titleField: "title", fields: "nope" } as unknown as Rubric,
      },
    },
  };
  expect(capabilities(reg).noteTypes[0]!.fields).toEqual([]);
});

// ── E1-A3 input class (c) — empty strings ────────────────────────────────────────────────────────

test("an empty-string template id makes the entry unresolvable, and it is OMITTED", () => {
  const reg: NoteTypeRegistry = {
    noteTypes: { card: "catalog-card", ghost: "" },
    templates: { "catalog-card": { renderer: "nk-card", rubric: CARD_RUBRIC } },
  };
  expect(capabilities(reg).noteTypes.map((n) => n.nkType)).toEqual(["card"]);
});

test("an empty-string renderer id makes the entry unresolvable, and it is OMITTED", () => {
  const reg: NoteTypeRegistry = {
    noteTypes: { card: "catalog-card", ghost: "catalog-ghost" },
    templates: {
      "catalog-card": { renderer: "nk-card", rubric: CARD_RUBRIC },
      "catalog-ghost": { renderer: "", rubric: CARD_RUBRIC },
    },
  };
  expect(capabilities(reg).noteTypes.map((n) => n.nkType)).toEqual(["card"]);
  // and the dispatcher agrees — the identity holds on the omission too
  expect(resolveTemplate("ghost", reg)).toBeNull();
});

test("a note type pointing at an absent template is OMITTED, never a half-built row", () => {
  const reg: NoteTypeRegistry = {
    noteTypes: { card: "catalog-card", ghost: "catalog-missing" },
    templates: { "catalog-card": { renderer: "nk-card", rubric: CARD_RUBRIC } },
  };
  expect(capabilities(reg).noteTypes.map((n) => n.nkType)).toEqual(["card"]);
});

// ── E1-A3 input class (d) — non-objects ──────────────────────────────────────────────────────────

test("a non-object registry yields an EMPTY catalog, never a throw", () => {
  for (const bad of [null, undefined, 7, "str", [], true]) {
    const catalog = capabilities(bad as unknown as NoteTypeRegistry);
    expect(catalog).toEqual({ catalogVersion: "nk-cap-v1", noteTypes: [] });
  }
});

test("a non-object noteTypes or templates yields an EMPTY catalog", () => {
  expect(
    capabilities({ noteTypes: 7, templates: {} } as unknown as NoteTypeRegistry).noteTypes,
  ).toEqual([]);
  expect(
    capabilities({ noteTypes: { card: "catalog-card" }, templates: 7 } as unknown as NoteTypeRegistry)
      .noteTypes,
  ).toEqual([]);
  // an ARRAY is an object but not a record — the registry's own ownRecord rules it out
  expect(
    capabilities({ noteTypes: [], templates: {} } as unknown as NoteTypeRegistry).noteTypes,
  ).toEqual([]);
});

test("a non-string titleField still advertises the type, with an empty title slot", () => {
  const reg: NoteTypeRegistry = {
    noteTypes: { card: "catalog-card" },
    templates: {
      "catalog-card": {
        renderer: "nk-card",
        rubric: { kind: "card", titleField: 7, fields: [] } as unknown as Rubric,
      },
    },
  };
  // resolveTemplate accepts it, so the catalog must too — the sets stay identical.
  expect(resolveTemplate("card", reg)).not.toBeNull();
  expect(capabilities(reg).noteTypes[0]!.titleField).toBe("");
});
