import { test, expect } from "bun:test";
import { parseFenceBody, serializeFenceBody, type FenceFields } from "./core-fence";

test("parses `key: value` lines", () => {
  expect(parseFenceBody("title: Primer\nstatus: draft")).toEqual({
    title: "Primer",
    status: "draft",
  });
});

test("splits on the FIRST colon only, so a URL value survives whole", () => {
  expect(parseFenceBody("source: https://example.com/a:b?q=1:2")).toEqual({
    source: "https://example.com/a:b?q=1:2",
  });
});

test("parses `[a, b]` as a multi-value list, `[]` as the empty list", () => {
  expect(parseFenceBody("tags: [primer, protocol, pattern]\nrefs: []")).toEqual({
    tags: ["primer", "protocol", "pattern"],
    refs: [],
  });
});

test("keeps values literal — surrounding quotes are NOT stripped (unlike parseFrontmatter)", () => {
  expect(parseFenceBody(`title: "Quoted"`)).toEqual({ title: `"Quoted"` });
});

test("drops blank lines, colon-less lines, and empty keys", () => {
  expect(parseFenceBody("\ntitle: A\njust prose\n\n   : orphan\nstatus: draft\n")).toEqual({
    title: "A",
    status: "draft",
  });
});

test("a repeated key keeps its last occurrence", () => {
  expect(parseFenceBody("status: draft\nstatus: live")).toEqual({ status: "live" });
});

test("tolerates CRLF and lone CR line endings", () => {
  expect(parseFenceBody("title: A\r\nstatus: draft\rkind: card")).toEqual({
    title: "A",
    status: "draft",
    kind: "card",
  });
});

test("an empty body parses to no fields, and no fields serialize to an empty body", () => {
  expect(parseFenceBody("")).toEqual({});
  expect(serializeFenceBody({})).toBe("");
});

test("serializeFenceBody is the sole writer of the grammar — scalars and lists", () => {
  expect(serializeFenceBody({ title: "A", tags: ["x", "y"], refs: [] })).toBe(
    "title: A\ntags: [x, y]\nrefs: []",
  );
});

// AC #3 — FR16 parity: serialize(parse(body)) === body for a canonical body.
test("round-trips a canonical body containing multi-value, URL, and quoted values", () => {
  const body = [
    "title: The RenderSpec seam",
    "kind: card",
    "tags: [primer, protocol]",
    "source: https://example.com/spec#nk-1",
    `note: "keep the quotes"`,
    "refs: []",
  ].join("\n");
  expect(serializeFenceBody(parseFenceBody(body))).toBe(body);
});

test("an empty value round-trips in its canonical `key: ` form", () => {
  expect(parseFenceBody("title: ")).toEqual({ title: "" });
  expect(serializeFenceBody(parseFenceBody("title: "))).toBe("title: ");
  // …and the non-canonical `key:` normalizes into it (declared normalization rule 3)
  expect(serializeFenceBody(parseFenceBody("title:"))).toBe("title: ");
});

test("a non-canonical body normalizes once, then is stable (idempotent from the canonical form)", () => {
  const messy = "  title :   A  \n\n\ntags:  [ x ,  , y ]  \nprose without a colon\ntitle: B\n";
  const once = serializeFenceBody(parseFenceBody(messy));
  const twice = serializeFenceBody(parseFenceBody(once));
  expect(once).toBe("title: B\ntags: [x, y]");
  expect(twice).toBe(once);
});

// Review follow-up (CodeRabbit #77) — the two key classes a plain `{}` record could not carry.

test("`__proto__` is stored as a FIELD, not routed to the prototype setter", () => {
  const fields = parseFenceBody("title: A\n__proto__: [x, y]\nstatus: draft");
  expect(Object.keys(fields)).toEqual(["title", "__proto__", "status"]);
  expect(fields["__proto__"]).toEqual(["x", "y"]);
  // it is data, so it round-trips and serializes like any other key
  expect(serializeFenceBody(fields)).toBe("title: A\n__proto__: [x, y]\nstatus: draft");
  // NB: the expectation cannot be written as an object LITERAL — `{ __proto__: [...] }` is exactly
  // the prototype-setter form this test exists to rule out, and would build an Array, not a record.
  expect(JSON.stringify(fields)).toBe('{"title":"A","__proto__":["x","y"],"status":"draft"}');
  const revived = JSON.parse(JSON.stringify(fields)) as FenceFields;
  expect(Object.keys(revived)).toEqual(["title", "__proto__", "status"]);
  expect(revived["__proto__"]).toEqual(["x", "y"]);
});

test("a parsed record inherits nothing — an unwritten key is undefined, not Object.prototype", () => {
  const fields = parseFenceBody("title: A");
  expect(Object.getPrototypeOf(fields)).toBe(null);
  expect(fields["constructor"]).toBeUndefined();
  expect(fields["toString"]).toBeUndefined();
});

// Declared normalization rule 8. JavaScript orders array-index keys numerically ahead of every
// string key, so a `Record` cannot round-trip them — the codec drops them instead of claiming a
// parity it cannot deliver.
test("array-index keys are DROPPED rather than silently reordered", () => {
  expect(parseFenceBody("2: two\n1: one")).toEqual({});
  expect(serializeFenceBody(parseFenceBody("2: two\n1: one"))).toBe("");
  expect(parseFenceBody("0: zero\ntitle: A\n4294967294: big")).toEqual({ title: "A" });
  // …and the writer never emits one either, so parse and serialize agree on the domain
  expect(serializeFenceBody({ "2": "two", title: "A", "1": "one" })).toBe("title: A");
});

test("keys that only LOOK numeric keep their insertion order and are kept", () => {
  // none of these is a canonical array index, so the engine preserves insertion order for them
  const body = "01: a\n1.5: b\n-1: c\n4294967295: d\n1e3: e";
  expect(Object.keys(parseFenceBody(body))).toEqual(["01", "1.5", "-1", "4294967295", "1e3"]);
  expect(serializeFenceBody(parseFenceBody(body))).toBe(body);
});

// Deterministic pseudo-fuzz (no Math.random — a failing case must be reproducible). Bodies are built
// in canonical form from a pool that exercises the pinned grammar: colon-bearing values, quoted
// scalars, multi-value lists, and the empty list.
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

test("property: serialize(parse(body)) === body over generated canonical bodies", () => {
  const keys = ["title", "kind", "tags", "source", "note", "refs", "owner"];
  const values: Array<string | string[]> = [
    "Primer",
    "card",
    `"quoted value"`,
    "https://example.com/a:b?q=1:2",
    "a value: with a colon",
    "[not a list",
    ["x"],
    ["primer", "protocol", "pattern"],
    [],
  ];
  const next = lcg(20260805);

  for (let round = 0; round < 400; round++) {
    const fields: FenceFields = {};
    const lineCount = Math.floor(next() * keys.length) + 1;
    for (let i = 0; i < lineCount; i++) {
      const key = keys[Math.floor(next() * keys.length)]!;
      fields[key] = values[Math.floor(next() * values.length)]!;
    }
    const body = serializeFenceBody(fields);
    expect(serializeFenceBody(parseFenceBody(body))).toBe(body);
    expect(parseFenceBody(body)).toEqual(fields);
  }
});

// ── review round 3 — an inherited index is not a list element ────────────────────────────────────

test("serializeFenceBody writes OWN elements only — a hole is empty, not the inherited value", () => {
  // `join` resolves each index through the prototype chain, so a hand-built sparse value wrote
  // `tags: [POISONED]` — a value the record never carried.
  const proto = Array.prototype as unknown as Record<number, unknown>;
  proto[0] = "POISONED";
  proto[1] = "POISONED";
  try {
    expect(serializeFenceBody({ tags: new Array(1) as unknown as string[] })).toBe("tags: []");
    // The hole at index 1 is the interesting one: index 0 is shadowed by an own element either way.
    expect(serializeFenceBody({ tags: ["a", , "c"] as unknown as string[] })).toBe("tags: [a, , c]");
    // A dense list is written byte-identically, poisoned prototype or not.
    expect(serializeFenceBody({ tags: ["a", "b"] })).toBe("tags: [a, b]");
  } finally {
    delete proto[0];
    delete proto[1];
  }
});
