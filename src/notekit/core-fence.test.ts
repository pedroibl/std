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
