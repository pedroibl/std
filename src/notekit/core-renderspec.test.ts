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
