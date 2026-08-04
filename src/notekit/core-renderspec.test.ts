import { test, expect } from "bun:test";
import { parseFenceBody } from "./core-fence";
import {
  makeValidate,
  noteToRenderSpec,
  validate,
  NK_BRANCHES,
  type Injected,
  type RenderSpec,
  type Rubric,
} from "./core-renderspec";

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
  "title: The RenderSpec seam",
  "tags: [primer, protocol]",
  "source: https://example.com/spec#nk-1",
  "scratch: not in the rubric",
].join("\n");

function spec(): RenderSpec {
  return noteToRenderSpec(parseFenceBody(BODY), RUBRIC, INJECTED);
}

// ── AC #1 — produce a RenderSpec ────────────────────────────────────────────────────────────────

test("stamps version nk-v1 and the rubric's kind", () => {
  expect(spec().version).toBe("nk-v1");
  expect(spec().kind).toBe("card");
});

test("field-selects by the injected rubric — rubric order, rubric labels, nothing else", () => {
  expect(spec().fields).toEqual([
    { key: "title", label: "Title", value: "The RenderSpec seam" },
    { key: "tags", label: "Tags", value: ["primer", "protocol"] },
    { key: "source", label: "source", value: "https://example.com/spec#nk-1" },
  ]);
});

test("a rubric key absent from the fence yields no row", () => {
  const sparse = noteToRenderSpec(parseFenceBody("title: Only a title"), RUBRIC, INJECTED);
  expect(sparse.fields.map((f) => f.key)).toEqual(["title"]);
});

test("title comes from the rubric's titleField; a list title joins", () => {
  expect(spec().title).toBe("The RenderSpec seam");
  const listTitle = noteToRenderSpec(parseFenceBody("title: [a, b]"), RUBRIC, INJECTED);
  expect(listTitle.title).toBe("a, b");
  const noTitle = noteToRenderSpec(parseFenceBody("tags: [x]"), RUBRIC, INJECTED);
  expect(noTitle.title).toBe("");
});

test("ids and timestamps are the injected ones — core computes neither (D4)", () => {
  expect(spec().id).toBe("nk-0001");
  expect(spec().generatedAt).toBe("2026-08-05T00:00:00.000Z");
});

test("the spec is JSON-serializable — no functions, class instances, or dates", () => {
  const x = spec();
  expect(JSON.parse(JSON.stringify(x))).toEqual(x);
});

test("list values are copied, never aliased into the spec", () => {
  const fields = parseFenceBody(BODY);
  const built = noteToRenderSpec(fields, RUBRIC, INJECTED);
  (fields.tags as string[]).push("mutated");
  expect(built.fields[1]!.value).toEqual(["primer", "protocol"]);
});

// ── AC #2 — validate + fail loud ────────────────────────────────────────────────────────────────

test("a well-formed spec validates to {ok:true}", () => {
  const result = validate(spec());
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toEqual(spec());
});

test("a missing required field returns {ok:false} naming that field", () => {
  const { title, ...missingTitle } = spec();
  const result = validate(missingTitle);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("nk-missing-field");
    expect(result.error.field).toBe("title");
    expect(result.error.message).toContain("title");
  }
});

test("a malformed field row names its path", () => {
  const broken = { ...spec(), fields: [{ key: "title", label: "Title", value: 42 }] };
  const result = validate(broken);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.field).toBe("fields[0].value");
});

test("an unrecognized version returns {ok:false} naming the mismatch", () => {
  const result = validate({ ...spec(), version: "nk-v9" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("nk-unknown-version");
    expect(result.error.message).toContain("nk-v9");
    expect(result.error.message).toContain("nk-v1");
  }
});

test("a non-object candidate is rejected, not coerced", () => {
  for (const junk of [null, "nk-v1", 7, ["nk-v1"]]) {
    expect(validate(junk).ok).toBe(false);
  }
});

test("an unexpected error is RE-THROWN, never swallowed into a Result", () => {
  const exploding = {
    get version(): string {
      throw new Error("boom — not a classified malformed-input error");
    },
  };
  expect(() => validate(exploding)).toThrow("boom");
});

// Review follow-up (CodeRabbit #77): every candidate below is otherwise COMPLETE, so the assertion
// lands on the property under test and not on an earlier check.
function candidate(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    version: "nk-v1",
    kind: "card",
    id: "nk-0001",
    generatedAt: "2026-08-05T00:00:00.000Z",
    title: "t",
    fields: [],
    ...overrides,
  };
}

test("an inherited Object.prototype name is NOT a version branch", () => {
  // `branches[version]` walked the prototype chain: "constructor" returned `Object`, was called with
  // the candidate, and handed it back UNVALIDATED as {ok:true} — a partial render (AC #2). "toString"
  // returned the string "[object Undefined]" AS a RenderSpec. "__proto__"/"valueOf" crashed outright.
  for (const version of ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"]) {
    const result = validate(candidate({ version }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("nk-unknown-version");
      expect(result.error.field).toBe("version");
      expect(result.error.message).toContain(version);
    }
  }
});

test("a branch table entry that is not a function is not dispatched either", () => {
  const notAFunction = makeValidate({ "nk-v1": 42 as unknown as typeof NK_BRANCHES["nk-v1"] });
  const result = notAFunction(candidate({}));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("nk-unknown-version");
});

test("the known-versions list names only own, dispatchable branches", () => {
  const result = validate(candidate({ version: "nk-v9" }));
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.message).toContain("known: nk-v1");
    expect(result.error.message).not.toContain("constructor");
  }
});

test("a sparse `fields` array is rejected — a hole would stringify to null", () => {
  const result = validate(candidate({ fields: new Array(1) }));
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("nk-missing-field");
    expect(result.error.field).toBe("fields[0]");
  }
});

test("a sparse field `value` array is rejected — `every` skips holes", () => {
  const result = validate(candidate({ fields: [{ key: "k", label: "L", value: new Array(1) }] }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.field).toBe("fields[0].value");
});

test("a hole later in an otherwise valid array is caught too", () => {
  const holed: unknown[] = ["a"];
  holed.length = 3;
  holed[2] = "c";
  const result = validate(candidate({ fields: [{ key: "k", label: "L", value: holed }] }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.field).toBe("fields[0].value");
});

test("every validated spec survives the JSON round trip (AC #1)", () => {
  const result = validate(spec());
  expect(result.ok).toBe(true);
  if (result.ok) expect(JSON.parse(JSON.stringify(result.value))).toEqual(result.value);
});

test("a malformed row names its FULL path, not the bare property", () => {
  const badKey = validate(candidate({ fields: [{ key: 42, label: "L", value: "v" }] }));
  expect(badKey.ok).toBe(false);
  if (!badKey.ok) {
    expect(badKey.error.field).toBe("fields[0].key");
    expect(badKey.error.message).toContain("fields[0].key");
  }

  const badLabel = validate(candidate({ fields: [{ key: "k", label: 42, value: "v" }] }));
  expect(badLabel.ok).toBe(false);
  if (!badLabel.ok) {
    expect(badLabel.error.field).toBe("fields[0].label");
    expect(badLabel.error.message).toContain("fields[0].label");
  }

  // …and the index is the row's own, not always 0
  const second = validate(
    candidate({
      fields: [
        { key: "k", label: "L", value: "v" },
        { key: "k2", label: "", value: "v" },
      ],
    }),
  );
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.error.field).toBe("fields[1].label");
});

test("a top-level missing field still reports the bare key, not a row path", () => {
  const result = validate(candidate({ id: "" }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.field).toBe("id");
});

test("an inherited fence key is never read as a field value", () => {
  // A hand-built (plain-object) FenceFields: `fields["constructor"]` would resolve to `Object`, and
  // a function in the spec is not JSON. Own properties only.
  const inheriting: Rubric = {
    kind: "card",
    titleField: "title",
    fields: [{ key: "constructor" }, { key: "toString" }],
  };
  const built = noteToRenderSpec({ title: "A" }, inheriting, INJECTED);
  expect(built.fields).toEqual([]);
  expect(JSON.parse(JSON.stringify(built))).toEqual(built);

  const inheritedTitle = noteToRenderSpec(
    {},
    { kind: "card", titleField: "constructor", fields: [] },
    INJECTED,
  );
  expect(inheritedTitle.title).toBe("");
});

// ── AC #4 — additive version branching ──────────────────────────────────────────────────────────

test("validate dispatches on the version field", () => {
  const branchedElsewhere = makeValidate({
    "nk-v1": () => {
      throw new Error("the nk-v1 arm must not run for an nk-v2 candidate");
    },
    "nk-v2": (candidate) => candidate as unknown as RenderSpec,
  });
  const result = branchedElsewhere({ version: "nk-v2", anything: true });
  expect(result.ok).toBe(true);
});

test("adding a stub nk-v2 branch leaves the nk-v1 result byte-identical", () => {
  const fixture = spec();
  const before = JSON.stringify(validate(fixture));

  const withV2 = makeValidate({
    ...NK_BRANCHES,
    "nk-v2": (candidate) => candidate as unknown as RenderSpec,
  });
  const after = JSON.stringify(withV2(fixture));

  expect(after).toBe(before);
  // …and the failure path is unchanged too
  const { title, ...missingTitle } = fixture;
  expect(JSON.stringify(withV2(missingTitle))).toBe(JSON.stringify(validate(missingTitle)));
});

// ── review round 3 — an inherited index never reaches a validated spec ───────────────────────────

function withPoisonedArrayPrototype<T>(value: unknown, body: () => T, index = 0): T {
  const proto = Array.prototype as unknown as Record<number, unknown>;
  proto[index] = value;
  try {
    return body();
  } finally {
    delete proto[index];
  }
}

const POISON_BASE = {
  version: "nk-v1",
  kind: "card",
  id: "nk-0001",
  generatedAt: "2026-08-05T00:00:00.000Z",
  title: "t",
};

test("validate REJECTS a sparse field value whose hole is covered by Array.prototype", () => {
  // `i in value` inside `isStringArray` read the inherited index as an element, so a sparse value
  // validated — and then stringified to `[null]`, breaking the JSON round-trip (NK-1 rule 1) that
  // this very check exists to protect.
  const result = withPoisonedArrayPrototype("POISONED", () =>
    validate({ ...POISON_BASE, fields: [{ key: "k", label: "L", value: new Array(1) }] }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.field).toBe("fields[0].value");
});

test("validate REJECTS a sparse `fields` whose hole is covered by a row-shaped Array.prototype", () => {
  const result = withPoisonedArrayPrototype({ key: "k", label: "L", value: "POISONED" }, () =>
    validate({ ...POISON_BASE, fields: new Array(1) }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.field).toBe("fields[0]");
});

test("noteToRenderSpec copies list values by OWN index — a spread would inherit the hole", () => {
  // `[...value]` copies through the iterator, which resolves each index through the prototype chain.
  const fields = Object.create(null) as Record<string, string | string[]>;
  fields.title = "T";
  fields.tags = new Array(1) as unknown as string[];
  const spec = withPoisonedArrayPrototype("POISONED", () =>
    noteToRenderSpec(
      fields,
      { kind: "card", titleField: "title", fields: [{ key: "tags" }] },
      { id: "i", generatedAt: "g" },
    ),
  );
  expect(JSON.stringify(spec)).not.toContain("POISONED");
  // The copy is DENSE with an explicit `undefined` — spread's clean-prototype behaviour, minus the
  // prototype walk. Asserted as an own property rather than via `JSON.stringify`, because stringify
  // resolves a HOLE through the chain as well: leaving the hole in place would have shown `null`
  // here and `"POISONED"` under pollution, moving the leak one step downstream instead of closing it.
  const copied = spec.fields[0]?.value as string[];
  expect(Object.prototype.hasOwnProperty.call(copied, 0)).toBe(true);
  expect(copied[0]).toBeUndefined();
  expect(JSON.stringify(copied)).toBe("[null]");
  // …and `validate` rejects it in the ordinary way.
  const result = validate({ ...spec, version: "nk-v1", kind: "card" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.field).toBe("fields[0].value");
});

test("a list title joins OWN elements — an inherited index is not part of the heading", () => {
  // The poison must land on the HOLE (index 1), not on an own element — poisoning index 0 here proves
  // nothing, since `"a"` shadows it either way. `join` resolves the hole through the prototype chain,
  // so the heading read "a, POISONED, c".
  const fields = Object.create(null) as Record<string, string | string[]>;
  fields.title = ["a", , "c"] as unknown as string[];
  const spec = withPoisonedArrayPrototype(
    "POISONED",
    () =>
      noteToRenderSpec(
        fields,
        { kind: "card", titleField: "title", fields: [] },
        { id: "i", generatedAt: "g" },
      ),
    1,
  );
  expect(spec.title).toBe("a, , c");
});

test("a dense spec is built identically under a poisoned prototype", () => {
  const fields = Object.create(null) as Record<string, string | string[]>;
  fields.title = "T";
  fields.tags = ["a", "b"];
  const rubric = { kind: "card", titleField: "title", fields: [{ key: "tags" }] } as const;
  const build = () => noteToRenderSpec(fields, rubric, { id: "i", generatedAt: "g" });
  expect(withPoisonedArrayPrototype("POISONED", build)).toEqual(build());
});
