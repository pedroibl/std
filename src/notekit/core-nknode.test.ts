import { test, expect } from "bun:test";
import { parseFenceBody } from "./core-fence";
import { cardTree } from "./core-nknode";
import type { NkNode } from "./core-nknode";
import { noteToRenderSpec } from "./core-renderspec";
import type { Injected, RenderSpec, Rubric } from "./core-renderspec";

const INJECTED: Injected = { id: "nk-0001", generatedAt: "2026-08-05T00:00:00.000Z" };

const RUBRIC: Rubric = {
  kind: "card",
  titleField: "title",
  fields: [
    { key: "title", label: "Title" },
    { key: "tags", label: "Tags" },
    { key: "source" },
  ],
};

const BODY = [
  "title: The nk-node tree",
  "tags: [primer, protocol]",
  "source: https://example.com/spec#nk-1",
].join("\n");

function spec(): RenderSpec {
  return noteToRenderSpec(parseFenceBody(BODY), RUBRIC, INJECTED);
}

/** Every node in the tree, root first — so a claim can be made about ALL of them, not a sample. */
function walk(node: NkNode): NkNode[] {
  return [node, ...(node.children ?? []).flatMap(walk)];
}

function classes(node: NkNode): string[] {
  return walk(node)
    .map((n) => n.class)
    .filter((c): c is string => c !== undefined);
}

/** Every string a serializer would emit as text, anywhere in the tree. */
function texts(node: NkNode): string[] {
  return walk(node)
    .map((n) => n.text)
    .filter((t): t is string => t !== undefined);
}

// ── AC #1 — the tree is the markup contract ─────────────────────────────────────────────────────

test("lowers a card spec into an nk-card root with title, fields, and meta in declared order", () => {
  const tree = cardTree(spec());
  expect(tree.tag).toBe("div");
  expect(tree.class).toBe("nk-card");
  expect((tree.children ?? []).map((c) => c.class)).toEqual([
    "nk-card-title",
    "nk-card-fields",
    "nk-card-meta",
  ]);
});

test("one nk-field row per rubric-selected field, label then value, in spec order", () => {
  const fields = cardTree(spec()).children?.[1];
  expect(fields?.children).toEqual([
    {
      tag: "div",
      class: "nk-field",
      children: [
        { tag: "span", class: "nk-field-label", text: "Title" },
        { tag: "span", class: "nk-field-value", text: "The nk-node tree" },
      ],
    },
    {
      tag: "div",
      class: "nk-field",
      children: [
        { tag: "span", class: "nk-field-label", text: "Tags" },
        {
          tag: "ul",
          class: "nk-field-values",
          children: [
            { tag: "li", class: "nk-field-value", text: "primer" },
            { tag: "li", class: "nk-field-value", text: "protocol" },
          ],
        },
      ],
    },
    {
      tag: "div",
      class: "nk-field",
      children: [
        { tag: "span", class: "nk-field-label", text: "source" },
        {
          tag: "span",
          class: "nk-field-value",
          text: "https://example.com/spec#nk-1",
        },
      ],
    },
  ]);
});

test("meta carries the injected id and timestamp — version, kind, id, generatedAt", () => {
  const meta = cardTree(spec()).children?.[2];
  expect(meta?.children).toEqual([
    { tag: "span", class: "nk-card-version", text: "nk-v1" },
    { tag: "span", class: "nk-card-kind", text: "card" },
    { tag: "span", class: "nk-card-id", text: "nk-0001" },
    { tag: "span", class: "nk-card-generated", text: "2026-08-05T00:00:00.000Z" },
  ]);
});

test("every class in the whole tree is nk-prefixed — never dk- or cn- (AD-8 / NK-2)", () => {
  const all = classes(cardTree(spec()));
  expect(all.length).toBeGreaterThan(0);
  for (const cls of all) {
    expect(cls).toMatch(/^nk-/);
    expect(cls).not.toMatch(/\b(dk|cn)-/);
  }
});

test("the tree is plain JSON — a round trip deep-equals it, over awkward values", () => {
  // The domain, not the happy path: empty strings, markup metacharacters, a list, a rubric key the
  // fence never supplied. Anything non-JSON in the tree (a function off the prototype chain, a hole
  // serializing to null) breaks this equality rather than passing silently.
  const awkward: RenderSpec = {
    version: "nk-v1",
    kind: "card",
    id: "nk-<0002>",
    generatedAt: "2026-08-05T00:00:00.000Z",
    title: 'Ampersands & "quotes" <in> it',
    fields: [
      { key: "summary", label: "Summary", value: "a <b>bold</b> claim & an ' apostrophe" },
      { key: "tags", label: "Tags", value: ["primer", "protocol & pattern"] },
      { key: "blank", label: "Blank", value: "" },
    ],
  };
  const tree = cardTree(awkward);
  expect(JSON.parse(JSON.stringify(tree))).toEqual(tree);
});

test("no node anywhere carries a function, a Date, or a class instance", () => {
  for (const node of walk(cardTree(spec()))) {
    expect(Object.getPrototypeOf(node)).toBe(Object.prototype);
    for (const value of Object.values(node)) {
      expect(["string", "object"]).toContain(typeof value);
    }
  }
});

// ── graceful omission — never the string "undefined" ────────────────────────────────────────────

test("a spec with no title omits the title node instead of rendering blank", () => {
  const untitled = noteToRenderSpec(parseFenceBody("tags: [x]"), RUBRIC, INJECTED);
  expect(untitled.title).toBe("");
  const kids = cardTree(untitled).children ?? [];
  expect(kids.map((c) => c.class)).toEqual(["nk-card-fields", "nk-card-meta"]);
});

test("a spec with no rubric-selected fields omits the fields container", () => {
  const empty = noteToRenderSpec(parseFenceBody("title: Just a title"), {
    ...RUBRIC,
    fields: [],
  }, INJECTED);
  expect(cardTree(empty).children?.map((c) => c.class)).toEqual(["nk-card-title", "nk-card-meta"]);
});

test("no text anywhere reads 'undefined', even when every optional value is missing", () => {
  // A spec stripped to the bone — the shape a JSON blob or a half-built caller can produce.
  const bare = { version: "nk-v1", kind: "card" } as unknown as RenderSpec;
  const tree = cardTree(bare);
  expect(texts(tree)).toEqual(["nk-v1", "card"]);
  expect(JSON.stringify(tree)).not.toContain("undefined");
});

test("a field row missing its label falls back to the key, never to blank", () => {
  const noLabel = {
    ...spec(),
    fields: [{ key: "source", label: "", value: "x" }],
  } as RenderSpec;
  const row = cardTree(noLabel).children?.[1]?.children?.[0];
  expect(row?.children?.[0]).toEqual({ tag: "span", class: "nk-field-label", text: "source" });
});

// ── the JS type domain, not the TS type ─────────────────────────────────────────────────────────

test("a sparse fields array is skipped, not lowered into a null-serializing hole", () => {
  const sparse: RenderSpec["fields"] = [];
  sparse[2] = { key: "k", label: "K", value: "v" };
  const tree = cardTree({ ...spec(), fields: sparse });
  const rows = tree.children?.[1]?.children ?? [];
  expect(rows).toHaveLength(1);
  expect(JSON.parse(JSON.stringify(tree))).toEqual(tree);
});

test("a sparse list value drops its holes rather than emitting undefined text", () => {
  const values: string[] = [];
  values[0] = "first";
  values[2] = "third";
  const tree = cardTree({
    ...spec(),
    fields: [{ key: "tags", label: "Tags", value: values }],
  });
  const list = tree.children?.[1]?.children?.[0]?.children?.[1];
  expect(list?.children?.map((li) => li.text)).toEqual(["first", "third"]);
  expect(JSON.parse(JSON.stringify(tree))).toEqual(tree);
});

test("inherited property names are not read as spec data", () => {
  // `own()` guards this: a bare `spec["constructor"]` is `Object` — a function, which would be
  // copied into a node and break JSON-serializability.
  const tree = cardTree({ version: "nk-v1", kind: "card" } as unknown as RenderSpec);
  for (const node of walk(tree)) {
    expect(typeof node.text).not.toBe("function");
  }
  expect(JSON.parse(JSON.stringify(tree))).toEqual(tree);
});

test("a non-object field row is dropped whole, not rendered as a labelless value", () => {
  const junk = {
    ...spec(),
    fields: [null, "a string", 7, { key: "ok", label: "Ok", value: "kept" }],
  } as unknown as RenderSpec;
  const rows = cardTree(junk).children?.[1]?.children ?? [];
  expect(rows).toHaveLength(1);
  expect(rows[0]?.children?.[1]?.text).toBe("kept");
});

// ── present-but-empty is not absent (the third review's High finding) ───────────────────────────

test("a field the spec carries with an empty value keeps its row — present is not absent", () => {
  // The real author path: `bio: ` is the fence codec's canonical empty-value form (rule 3), so the
  // spec carries `{key:"bio", label:"Bio", value:""}` and `validate` blesses it. Dropping the row
  // there made the tree disagree with the spec — the AC #2 break.
  const rubric: Rubric = {
    kind: "card",
    titleField: "name",
    fields: [{ key: "name", label: "Name" }, { key: "bio", label: "Bio" }],
  };
  const withEmpty = noteToRenderSpec(parseFenceBody("name: Ada\nbio: "), rubric, INJECTED);
  expect(withEmpty.fields).toEqual([
    { key: "name", label: "Name", value: "Ada" },
    { key: "bio", label: "Bio", value: "" },
  ]);
  const rows = cardTree(withEmpty).children?.[1]?.children ?? [];
  expect(rows).toHaveLength(2);
  expect(rows[1]).toEqual({
    tag: "div",
    class: "nk-field",
    children: [
      { tag: "span", class: "nk-field-label", text: "Bio" },
      { tag: "span", class: "nk-field-value", text: "" },
    ],
  });
});

test("an empty scalar and an empty list behave the same — both keep the row", () => {
  // These two diverged before: the list kept its row and rendered an empty `<ul>`, the scalar vanished.
  const tree = cardTree({
    ...spec(),
    fields: [
      { key: "s", label: "S", value: "" },
      { key: "l", label: "L", value: [] },
    ],
  });
  const rows = tree.children?.[1]?.children ?? [];
  expect(rows.map((r) => r.children?.[0]?.text)).toEqual(["S", "L"]);
  expect(rows.map((r) => r.children?.[1]?.class)).toEqual(["nk-field-value", "nk-field-values"]);
});

test("an empty element inside a list keeps its <li> — the same policy as the scalar", () => {
  const tree = cardTree({
    ...spec(),
    fields: [{ key: "tags", label: "Tags", value: ["a", "", "c"] }],
  });
  const list = tree.children?.[1]?.children?.[0]?.children?.[1];
  expect(list?.children?.map((li) => li.text)).toEqual(["a", "", "c"]);
});

test("an empty value node still never carries the string 'undefined'", () => {
  // The omit rule is intact where it applies: an ABSENT field emits nothing, a present-but-empty one
  // emits its own empty text. Neither ever stringifies a placeholder.
  const tree = cardTree({
    ...spec(),
    fields: [{ key: "k", label: "K", value: "" }],
  });
  expect(JSON.stringify(tree)).not.toContain("undefined");
  expect(texts(tree)).toContain("");
});

test("a field whose value is neither string nor array is omitted rather than half-rendered", () => {
  const junk = {
    ...spec(),
    fields: [{ key: "n", label: "N", value: 42 }],
  } as unknown as RenderSpec;
  expect(cardTree(junk).children?.map((c) => c.class)).toEqual(["nk-card-title", "nk-card-meta"]);
});

test("cardTree is deterministic — the same spec builds a deep-equal tree every call", () => {
  expect(cardTree(spec())).toEqual(cardTree(spec()));
});

// ── review round 3 — an inherited index is not an element, and a non-spec is not a card ──────────

/**
 * Run `body` with `Array.prototype[0]` poisoned, restoring it whichever way `body` ends. Every test
 * below goes through this: a leaked poison would otherwise be inherited by every array in every
 * suite that runs after, and the failure would surface somewhere unrelated.
 */
function withPoisonedArrayPrototype<T>(value: unknown, body: () => T): T {
  const proto = Array.prototype as unknown as Record<number, unknown>;
  proto[0] = value;
  try {
    return body();
  } finally {
    delete proto[0];
  }
}

test("a hole in a list value stays a hole — an inherited Array.prototype index is not an element", () => {
  // `i in values` answered TRUE for the inherited index and lowered "POISONED" into an <li>. The
  // list has one hole and no own elements, so the correct tree is an EMPTY <ul>.
  const tree = withPoisonedArrayPrototype("POISONED", () =>
    cardTree({
      ...spec(),
      fields: [{ key: "tags", label: "Tags", value: new Array(1) as unknown as string[] }],
    }),
  );
  expect(JSON.stringify(tree)).not.toContain("POISONED");
  const list = tree.children?.[1]?.children?.[0]?.children?.[1];
  expect(list?.class).toBe("nk-field-values");
  expect(list?.children).toEqual([]);
});

test("a hole in `fields` stays a hole even when the inherited index is ROW-SHAPED", () => {
  // The string pollutant above was caught here by accident — `fieldNode` rejects a non-object row, so
  // the leak was invisible until the pollutant looked like a row. Same defect, one type away.
  const row = { key: "k", label: "Poisoned Label", value: "POISONED" };
  const tree = withPoisonedArrayPrototype(row, () =>
    cardTree({ ...spec(), fields: new Array(1) as unknown as RenderSpec["fields"] }),
  );
  const json = JSON.stringify(tree);
  expect(json).not.toContain("POISONED");
  expect(json).not.toContain("Poisoned Label");
  // No row survived, so the fields wrapper is omitted entirely.
  expect(tree.children?.map((c) => c.class)).toEqual(["nk-card-title", "nk-card-meta"]);
});

test("a dense list is unaffected by a poisoned prototype — the fix costs nothing on real input", () => {
  const build = () =>
    cardTree({ ...spec(), fields: [{ key: "tags", label: "Tags", value: ["a", "", "c"] }] });
  const poisoned = withPoisonedArrayPrototype("POISONED", build);
  expect(poisoned).toEqual(build());
});

test("a non-object spec is rejected by name, never rendered as an empty card", () => {
  // `null`/`undefined` used to die on a raw TypeError from inside a helper; `"str"`/`7` were worse —
  // they returned a well-formed card built from garbage. All four now fail the same way, matching
  // `validate`'s dispatch and `nkTreeToHtml`'s serialize.
  for (const [input, described] of [
    [null, "null"],
    [undefined, "undefined"],
    ["str", "string"],
    [7, "number"],
    [[], "an array"],
    [true, "boolean"],
  ] as const) {
    expect(() => cardTree(input as unknown as RenderSpec)).toThrow(
      `RenderSpec at spec: expected an object, got ${described}`,
    );
  }
});
