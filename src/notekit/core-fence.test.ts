import { test, expect, describe } from "bun:test";
import {
  locateFence,
  parseFenceBody,
  serializeFenceBody,
  createFence,
  spliceFence,
  type FenceFields,
  type LocatedFence,
} from "./core-fence";

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

// ── locateFence — the container half of the grammar (Story 2.1) ──────────────────────────────────

/**
 * The four offsets have no consumer in this story (`render` reads `type` and `body`), so they are
 * asserted as ROUND-TRIP PROPERTIES rather than as pinned numbers that would drift. Every matching
 * case runs through here, including the ones where an off-by-one hides: CRLF and an empty body.
 */
function expectOffsetsFaithful(markdown: string, f: LocatedFence): void {
  expect(markdown.slice(f.bodyStart, f.bodyEnd)).toBe(f.body);
  expect(f.blockStart).toBeLessThanOrEqual(f.bodyStart);
  expect(f.bodyStart).toBeLessThanOrEqual(f.bodyEnd);
  expect(f.bodyEnd).toBeLessThanOrEqual(f.blockEnd);
  const block = markdown.slice(f.blockStart, f.blockEnd);
  expect(block.startsWith("```")).toBe(true);
  // Ends past the closing run's terminator: either at EOF, or with the terminator included.
  expect(/```[ \t]*(\r\n|\r|\n)?$/.test(block)).toBe(true);
}

test("locateFence finds an nk-fence and returns the CAPTURED type, not the info string", () => {
  const md = "# Note\n\n```nk-card\ntitle: Primer\n```\n";
  const f = locateFence(md)!;
  expect(f).not.toBeNull();
  expect(f.type).toBe("card"); // `card`, what resolveTemplate routes on — never `nk-card`
  expectOffsetsFaithful(md, f);
});

test("the body INCLUDES its trailing newline — the one fact Story 2.2's splice depends on", () => {
  expect(locateFence("```nk-card\na: 1\n```\n")!.body).toBe("a: 1\n");
});

test("locateFence returns null when there is no fence at all", () => {
  expect(locateFence("# Just prose\n\nnothing fenced here.\n")).toBeNull();
});

test("a js-engine fence is not an nk-fence", () => {
  expect(locateFence("```js-engine\nconst x = 1;\n```\n")).toBeNull();
});

test("the grammar is `[a-z]+` — an uppercase info string does not match", () => {
  expect(locateFence("```nk-Card\ntitle: x\n```\n")).toBeNull();
});

test("an empty body yields bodyStart === bodyEnd and an empty string", () => {
  const md = "```nk-card\n```\n";
  const f = locateFence(md)!;
  expect(f.body).toBe("");
  expect(f.bodyStart).toBe(f.bodyEnd);
  expectOffsetsFaithful(md, f);
});

test("CRLF line endings are located byte-faithfully — the body keeps its \\r\\n", () => {
  const md = "# Note\r\n\r\n```nk-card\r\ntitle: Primer\r\n```\r\n";
  const f = locateFence(md)!;
  expect(f.type).toBe("card");
  expect(f.body).toBe("title: Primer\r\n");
  expectOffsetsFaithful(md, f);
  // The codec normalizes what the locator preserves — the two halves stay separable.
  expect(parseFenceBody(f.body)).toEqual({ title: "Primer" });
});

test("an unterminated nk-fence is null, never a fence running to EOF", () => {
  expect(locateFence("```nk-card\ntitle: Primer\n")).toBeNull();
});

test("the FIRST nk-fence wins — Story 2.2 splices on that", () => {
  const md = "```nk-card\nfirst: 1\n```\n\ntext\n\n```nk-card\nsecond: 2\n```\n";
  const f = locateFence(md)!;
  expect(f.body).toBe("first: 1\n");
  expectOffsetsFaithful(md, f);
});

test("a non-nk fence is walked THROUGH, so a code sample cannot masquerade as a fence", () => {
  // Without block-skipping, the ```nk-card line inside the js block would match and a code sample
  // could rewrite the note.
  const md = "```js\n// ```nk-card\n// evil: yes\n```\n\n```nk-card\nreal: yes\n```\n";
  const f = locateFence(md)!;
  expect(f.body).toBe("real: yes\n");
  expectOffsetsFaithful(md, f);
});

test("a non-nk fence with no nk-fence after it is null", () => {
  expect(locateFence("```\nplain code\n```\n")).toBeNull();
});

test("a longer closing run closes the block; a shorter one does not", () => {
  const md = "````nk-card\na: 1\n```\nstill body\n````\n";
  const f = locateFence(md)!;
  expect(f.body).toBe("a: 1\n```\nstill body\n");
  expectOffsetsFaithful(md, f);
});

test("an indented fence reports blockStart at the backtick run, not at the indent", () => {
  const md = "  ```nk-card\ntitle: x\n  ```\n";
  const f = locateFence(md)!;
  expect(f.blockStart).toBe(2);
  expectOffsetsFaithful(md, f);
});

test("locateFence is total on non-string input rather than throwing", () => {
  expect(locateFence(null as unknown as string)).toBeNull();
  expect(locateFence(7 as unknown as string)).toBeNull();
});

test("a fence at EOF with no trailing newline still closes, blockEnd at the string end", () => {
  const md = "```nk-card\na: 1\n```";
  const f = locateFence(md)!;
  expect(f.body).toBe("a: 1\n");
  expect(f.blockEnd).toBe(md.length);
  expectOffsetsFaithful(md, f);
});

// ── Story 2.2 — spliceFence, and the three oracles that can actually go red ──────────────────────

/**
 * ⚠ THE ORACLE THIS FILE DOES NOT USE, named so nobody adds it back believing it proves something.
 *
 * `spliceFence(md, f, f.body) === md` reduces to `s.slice(0,a) + s.slice(a,b) + s.slice(b) === s`,
 * which holds for ANY `a ≤ b` — and the stale-fence guard FORCES `f.body === md.slice(a,b)`, so a
 * self-consistent-but-wrong offset pair sails through. A prefix/suffix compare of the concat's output
 * against its own inputs is the same tautology restated. NEITHER CAN CATCH AN OFF-BY-ONE.
 *
 * The three below each read something the splice arithmetic never touches:
 *   (b) delimiter framing — reads the NOTE, so a boundary that swallows or clips a delimiter line
 *       goes red without the splice being involved at all;
 *   (c) round-trip through the LOCATOR — an off-by-one leaves a stray delimiter byte inside the
 *       re-located body, or loses one off its end, and the equality fails;
 *   (d) hand-written golden notes — bytes written by a human who was not looking at the offsets, so
 *       no self-consistent bug can satisfy them.
 */

/** Oracle (b): the prefix ends with the opening fence LINE and its newline; the suffix opens on the run. */
function expectDelimiterFraming(markdown: string, f: LocatedFence): void {
  const prefix = markdown.slice(0, f.bodyStart);
  // …its own newline, and NOT one byte less: an opening line whose terminator leaked into the body
  // would leave the prefix ending on the info string.
  expect(/(\r\n|\r|\n)$/.test(prefix)).toBe(true);
  const openLine = prefix.split(/\r\n|\r|\n/).at(-2)!;
  expect(/^[ \t]*`{3,}nk-[a-z]+[ \t]*$/.test(openLine)).toBe(true);

  const suffix = markdown.slice(f.bodyEnd);
  expect(/^[ \t]*`{3,}[ \t]*(\r\n|\r|\n|$)/.test(suffix)).toBe(true);
}

/** Oracle (c): a CHANGED body re-locates byte-for-byte out of the spliced note. */
function expectRoundTrip(markdown: string, f: LocatedFence, newBody: string): string {
  expect(newBody).not.toBe(f.body); // an identity splice would make this vacuous
  const after = spliceFence(markdown, f, newBody);
  const relocated = locateFence(after);
  expect(relocated).not.toBeNull();
  expect(relocated!.body).toBe(newBody);
  expect(relocated!.type).toBe(f.type);
  return after;
}

// Every AC #1 fixture, run through (b) and (c).
//
// ⚠ `newBody` IS REQUIRED, not optional. It was optional while oracle (c) force-unwrapped it for every
// fixture, so a future fixture that omitted the field would have sent `undefined` into `spliceFence`,
// which writes the literal text "undefined" into the note body — and the failure would have surfaced as
// a body MISMATCH, pointing at the codec instead of at the missing fixture field. Every fixture already
// supplies one, so requiring it costs nothing and makes the comment above true of the loop below.
const SPLICE_FIXTURES: Array<{ name: string; md: string; newBody: string }> = [
  { name: "a plain nk-fence", md: "# Note\n\n```nk-card\ntitle: Primer\n```\n\nprose after\n", newBody: "title: Primer\nstatus: live\n" },
  {
    name: "TWO nk-fences — the first is the one spliced",
    md: "```nk-card\nfirst: 1\n```\n\ntext between\n\n```nk-card\nsecond: 2\n```\n",
    newBody: "first: 1\nextra: yes\n",
  },
  { name: "a fence at EOF with no trailing newline", md: "```nk-card\na: 1\n```", newBody: "a: 2\n" },
  {
    name: "a CRLF note throughout",
    md: "---\r\nnk-type: card\r\n---\r\n\r\n```nk-card\r\ntitle: Primer\r\n```\r\n\r\nprose\r\n",
    // The declared consequence: prose keeps CRLF, the codec's body is LF-only.
    newBody: "title: Primer\n",
  },
  {
    name: "a body line that itself reads ```",
    md: "````nk-card\na: 1\n```\nstill body\n````\n",
    newBody: "a: 2\n```\nstill body\n",
  },
  { name: "a body line that reads ~~~ (never a delimiter here)", md: "```nk-card\na: 1\n~~~\n```\n", newBody: "b: 2\n~~~\n" },
  {
    name: "a non-matching js-engine fence ADJACENT to the nk-fence",
    md: "```js-engine\nconst x = 1;\n```\n\n```nk-card\na: 1\n```\n",
    newBody: "a: 1\nb: 2\n",
  },
  { name: "an EMPTY fence body", md: "```nk-card\n```\n", newBody: "a: 1\n" },
  { name: "an indented fence", md: "  ```nk-card\ntitle: x\n  ```\n", newBody: "title: y\n" },
];

describe("spliceFence — oracle (b): delimiter framing, read off the note", () => {
  for (const fx of SPLICE_FIXTURES) {
    test(fx.name, () => {
      // ⚠ CHECK BEFORE UNWRAP. With `locateFence(fx.md)!` on the line above the assertion, the `!` made
      // the assertion run on a value already assumed non-null — if a fixture stopped locating a fence,
      // `expectDelimiterFraming` threw on `f.bodyStart` and this message never printed.
      const f = locateFence(fx.md);
      expect(f).not.toBeNull();
      expectDelimiterFraming(fx.md, f!);
    });
  }

  test("the fixtures with NO locatable fence stay null — no splice is possible", () => {
    expect(locateFence("# just prose\n")).toBeNull(); // no fence
    expect(locateFence("```nk-card\na: 1\n")).toBeNull(); // unterminated
    expect(locateFence("```nk-Card\na: 1\n```\n")).toBeNull(); // uppercase — the grammar is [a-z]+
  });
});

describe("spliceFence — oracle (c): the changed body re-locates byte-for-byte", () => {
  for (const fx of SPLICE_FIXTURES) {
    test(fx.name, () => {
      // Same check-before-unwrap as oracle (b), and for the same reason.
      const f = locateFence(fx.md);
      expect(f).not.toBeNull();
      const after = expectRoundTrip(fx.md, f!, fx.newBody);
      // …and oracle (b) again on the RESULT: both delimiter lines survived the write.
      const relocated = locateFence(after);
      expect(relocated).not.toBeNull();
      expectDelimiterFraming(after, relocated!);
    });
  }

  test("an empty new body splices back to bodyStart === bodyEnd and still re-locates", () => {
    const md = "```nk-card\na: 1\nb: 2\n```\n";
    const after = spliceFence(md, locateFence(md)!, "");
    const f = locateFence(after)!;
    expect(f).not.toBeNull();
    expect(f.body).toBe("");
    expect(f.bodyStart).toBe(f.bodyEnd);
    expect(after).toBe("```nk-card\n```\n"); // both delimiter lines survived
  });

  test("the CRLF consequence is DECLARED, not discovered: prose keeps CRLF, the body is LF", () => {
    const md = "---\r\nnk-type: card\r\n---\r\n\r\n```nk-card\r\ntitle: Old\r\n```\r\n\r\nprose\r\n";
    const after = spliceFence(md, locateFence(md)!, serializeFenceBody({ title: "New" }) + "\n");
    expect(after).toBe("---\r\nnk-type: card\r\n---\r\n\r\n```nk-card\r\ntitle: New\n```\r\n\r\nprose\r\n");
    expect(locateFence(after)!.body).toBe("title: New\n");
  });
});

describe("spliceFence — oracle (d): hand-written golden notes, byte for byte", () => {
  test("a plain fence grows", () => {
    const md = "---\nnk-type: card\n---\n\n# Primer\n\n```nk-card\ntitle: Primer\n```\n\ntrailing prose\n";
    expect(spliceFence(md, locateFence(md)!, "title: Primer\nstatus: live\n")).toBe(
      "---\nnk-type: card\n---\n\n# Primer\n\n```nk-card\ntitle: Primer\nstatus: live\n```\n\ntrailing prose\n",
    );
  });

  test("a fence at EOF with no trailing newline", () => {
    const md = "prose\n\n```nk-card\na: 1\n```";
    expect(spliceFence(md, locateFence(md)!, "a: 2\nb: 3\n")).toBe("prose\n\n```nk-card\na: 2\nb: 3\n```");
  });

  test("an empty body is filled", () => {
    const md = "```nk-card\n```\n\nafter\n";
    expect(spliceFence(md, locateFence(md)!, "a: 1\n")).toBe("```nk-card\na: 1\n```\n\nafter\n");
  });
});

describe("spliceFence — a later fence is never false-flagged (NK-4 rule 2)", () => {
  const TWO = "```nk-card\nfirst: 1\n```\n\ntext between\n\n```nk-card\nsecond: 2\nmore: 3\n```\n\ntail\n";

  /** The SECOND fence's text, found by CONTENT rather than by an offset that the splice just moved. */
  function secondFenceText(markdown: string): string {
    const first = locateFence(markdown)!;
    const rest = markdown.slice(first.blockEnd);
    const second = locateFence(rest)!;
    return rest.slice(second.blockStart, second.blockEnd);
  }

  const ORIGINAL_SECOND = "```nk-card\nsecond: 2\nmore: 3\n```\n";

  test("the second fence is byte-identical when the first GROWS", () => {
    const after = spliceFence(TWO, locateFence(TWO)!, "first: 1\nadded: yes\nand: more\n");
    expect(secondFenceText(TWO)).toBe(ORIGINAL_SECOND);
    expect(secondFenceText(after)).toBe(ORIGINAL_SECOND);
    expect(after.endsWith("\n\ntail\n")).toBe(true);
  });

  test("…and when the first SHRINKS", () => {
    const after = spliceFence(TWO, locateFence(TWO)!, "");
    expect(secondFenceText(after)).toBe(ORIGINAL_SECOND);
    expect(after).toBe("```nk-card\n```\n\ntext between\n\n```nk-card\nsecond: 2\nmore: 3\n```\n\ntail\n");
  });
});

describe("spliceFence — the stale-fence throw", () => {
  test("offsets from ANOTHER string are a caller bug and throw, not a silent corruption", () => {
    const a = "```nk-card\na: 1\n```\n";
    const b = "# different note\n\n```nk-card\nb: 2\n```\n";
    expect(() => spliceFence(b, locateFence(a)!, "c: 3\n")).toThrow(/stale offsets/);
  });

  test("a hand-mutated offset pair throws even though it is self-consistent about nothing", () => {
    const md = "```nk-card\na: 1\n```\n";
    const f = locateFence(md)!;
    expect(() => spliceFence(md, { ...f, bodyEnd: f.bodyEnd - 1 }, "x: 1\n")).toThrow(/stale offsets/);
    expect(() => spliceFence(md, { ...f, bodyStart: f.bodyStart - 1 }, "x: 1\n")).toThrow(/stale offsets/);
  });

  test("it is unreachable from the write path — the splice runs on the located string", () => {
    const md = "```nk-card\na: 1\n```\n";
    expect(() => spliceFence(md, locateFence(md)!, "a: 2\n")).not.toThrow();
  });

  // ── the DEGENERATE offset pairs the byte compare alone could not catch (CodeRabbit, PR #83) ────────
  //
  // The four shapes below all pass `markdown.slice(bodyStart, bodyEnd) === fence.body`, because `slice`
  // clamps and reorders its arguments in silence. Each is asserted as a THROW *and* paired with the
  // exact corruption the un-guarded splice produced, so the fixture records what the guard is buying
  // rather than only that it fires. `spliceFence` is exported from `src/notekit/index.ts`, so a fence
  // LITERAL from a later story is a reachable caller — `locateFence` emits none of these.
  describe("degenerate offsets pass the byte compare and MUST still throw", () => {
    const MD = "abcdef"; // not a note: these are offset shapes, and a fence would only obscure them

    // [name, bodyStart, bodyEnd, body, what the un-guarded three-slice concat returned]
    const DEGENERATE: Array<[string, number, number, string, string]> = [
      ["inverted pair, empty body", 4, 2, "", "abcdXcdef"],
      ["negative start, empty body", -1, 2, "", "abcdeXcdef"],
      ["bodyEnd past the end of the string", 4, 99, "ef", "abcdX"],
      ["non-integer offsets", 4.7, 6, "ef", "abcdX"],
    ];

    for (const [name, bodyStart, bodyEnd, body, wasCorruptedTo] of DEGENERATE) {
      test(name, () => {
        const fence = { type: "card", body, bodyStart, bodyEnd } as LocatedFence;

        // the premise: the OLD guard's sole condition is satisfied, so it would not have thrown
        expect(MD.slice(bodyStart, bodyEnd)).toBe(body);

        // …and this is what it let through — the concat, spelled out rather than described
        expect(MD.slice(0, bodyStart) + "X" + MD.slice(bodyEnd)).toBe(wasCorruptedTo);

        // the guard now refuses it
        expect(() => spliceFence(MD, fence, "X")).toThrow(/stale offsets/);
      });
    }

    test("the two corrupting shapes really did lose or duplicate bytes — not a cosmetic difference", () => {
      expect("abcdXcdef".replace("X", "")).not.toBe(MD); // "cd" duplicated
      expect("abcdeXcdef".replace("X", "")).not.toBe(MD); // ditto
      expect("abcdX".replace("X", "")).not.toBe(MD); // the "ef" tail dropped
    });

    test("the LEGAL boundary shapes still splice — the guard is not merely stricter", () => {
      // bodyStart === bodyEnd (an empty fence body) and bodyEnd === markdown.length are both produced
      // by `locateFence` and must survive every new clause.
      const empty = "```nk-card\n```\n";
      const f = locateFence(empty)!;
      expect(f.bodyStart).toBe(f.bodyEnd);
      expect(() => spliceFence(empty, f, "a: 1\n")).not.toThrow();

      const atEof = "```nk-card\na: 1\n```"; // no trailing newline
      const g = locateFence(atEof)!;
      expect(() => spliceFence(atEof, g, "a: 2\n")).not.toThrow();
      expect(spliceFence(MD, { type: "card", body: MD, bodyStart: 0, bodyEnd: MD.length } as LocatedFence, "X")).toBe("X");
    });
  });
});

describe("the newline contract — 2.1 owns it, the codec does not", () => {
  test("a located body carries its trailing newline; serializeFenceBody emits none", () => {
    expect(locateFence("```nk-card\na: 1\n```\n")!.body).toBe("a: 1\n");
    expect(locateFence("```nk-card\n```\n")!.body).toBe(""); // empty ⇒ bodyStart === bodyEnd
    expect(serializeFenceBody({ a: "1" })).toBe("a: 1");
    expect(serializeFenceBody({})).toBe("");
  });

  test("THE NEGATIVE CASE: splicing raw codec output DESTROYS the fence", () => {
    // This is why `composeBody` exists (Story 2.2 AC #2) and why deleting it as a "simplification"
    // must fail a test rather than a review.
    const md = "```nk-card\na: 1\n```\n";
    const broken = spliceFence(md, locateFence(md)!, serializeFenceBody({ a: "2" }));
    expect(broken).toBe("```nk-card\na: 2```\n"); // the closing delimiter glued onto the last field
    expect(locateFence(broken)).toBeNull(); // …and it is no longer a fence at all
  });

  test("…while the composed form survives the same round trip", () => {
    const md = "```nk-card\na: 1\n```\n";
    const fixed = spliceFence(md, locateFence(md)!, serializeFenceBody({ a: "2" }) + "\n");
    expect(fixed).toBe("```nk-card\na: 2\n```\n");
    expect(locateFence(fixed)!.body).toBe("a: 2\n");
  });
});

// ── createFence (Story 2.5) ─────────────────────────────────────────────────────────────────────

describe("createFence — the one allowed structural add (NK-4 rule 2)", () => {
  // Every fixture is run through `locateFence`, never through a prefix/suffix compare of
  // `createFence`'s output against its own inputs. That compare is the tautology 2.2's AC #1 bans; it
  // is named here so nobody adds it back believing it proves something. The LOCATOR is the oracle:
  // an off-by-one in the delimiter framing goes red because the locator cannot find the body back.

  /** The offset just past the frontmatter block's closing `---` line — the pinned insertion point. */
  function afterFrontmatter(md: string): number {
    if (!md.startsWith("---")) return 0;
    const close = md.indexOf("\n---", 3);
    if (close === -1) return 0;
    const nl = md.indexOf("\n", close + 1);
    return nl === -1 ? md.length : nl + 1;
  }

  const CANONICAL = "---\ntitle: T\nnk-type: card\n---\n\nProse here.\n";

  test("THE ORACLE — locateFence(createFence(...)) reads the body back EXACTLY, for every fixture", () => {
    const fixtures: Array<{ md: string; type: string; body: string }> = [
      { md: CANONICAL, type: "card", body: "title: T\n" },
      { md: CANONICAL, type: "card", body: "title: T\nrole: r\ntags: [a, b]\n" },
      { md: "---\nnk-type: card\n---\n", type: "card", body: "title: X\n" },
      { md: "---\na: 1\n---\nno blank line before prose\n", type: "card", body: "title: Y\n" },
      { md: CANONICAL, type: "primer", body: "title: T\n" },
      // A colon-bearing value: only the FIRST colon splits (rule 7), so it survives whole.
      { md: CANONICAL, type: "card", body: "url: https://x.y/z:1\n" },
    ];
    for (const { md, type, body } of fixtures) {
      const out = createFence(md, type, body, afterFrontmatter(md));
      const found = locateFence(out);
      expect(found).not.toBeNull();
      expect(found!.body).toBe(body);
      expect(found!.type).toBe(type);
    }
  });

  test("the created fence is the ONLY nk-fence in the note", () => {
    const out = createFence(CANONICAL, "card", "title: T\n", afterFrontmatter(CANONICAL));
    const f = locateFence(out)!;
    expect(locateFence(out.slice(f.blockEnd))).toBeNull();
    expect(out.match(/^```nk-[a-z]+$/gm)!.length).toBe(1);
  });

  test("the block lands immediately after the frontmatter, with exactly one \\n each side", () => {
    const at = afterFrontmatter(CANONICAL);
    const out = createFence(CANONICAL, "card", "title: T\n", at);
    expect(out).toBe(
      CANONICAL.slice(0, at) + "\n```nk-card\ntitle: T\n```\n" + "\n" + CANONICAL.slice(at),
    );
    // ⚠ THE INVARIANT IS INSERTED NEWLINES, NOT RENDERED BLANK LINES. On this fixture the result
    // reads ONE blank line above the fence and TWO below, because the note already carried the blank
    // line separating its frontmatter from its prose. That is correct and must not be "fixed" with a
    // look-behind: the subtraction assertion below is written against the insertion form, so it holds
    // whatever the surrounding prose contributes.
    expect(out.startsWith("---\ntitle: T\nnk-type: card\n---\n\n```nk-card\n")).toBe(true);
  });

  test("AC #5 SUBTRACTION — deleting [blockStart, blockEnd) leaves the pre-note plus the two \\n", () => {
    // ⚠ CONTENT, not offsets. An "differs only between bodyStart and bodyEnd" assertion is FALSE BY
    // CONSTRUCTION here: creation inserts a whole block, so EVERY offset after the insertion point
    // shifts. NK-4 rule 2 says the invariant lives on the fence AST, not on byte offsets.
    for (const md of [CANONICAL, "---\nnk-type: card\n---\nprose\n", "---\na: 1\n---\n"]) {
      const at = afterFrontmatter(md);
      const out = createFence(md, "card", "title: T\n", at);
      const f = locateFence(out)!;
      const remainder = out.slice(0, f.blockStart) + out.slice(f.blockEnd);
      expect(remainder).toBe(md.slice(0, at) + "\n" + "\n" + md.slice(at));
    }
  });

  test("an EMPTY body composes to adjacent delimiters — bodyStart === bodyEnd", () => {
    const out = createFence(CANONICAL, "card", "", afterFrontmatter(CANONICAL));
    expect(out).toContain("```nk-card\n```\n");
    const f = locateFence(out)!;
    expect(f.body).toBe("");
    expect(f.bodyStart).toBe(f.bodyEnd);
  });

  test("at === 0 (the no-frontmatter branch) — total, and the leading blank line is DECLARED", () => {
    // Unreachable from the CLI: a note with no `---` block has no `nk-type:` opt-in, so 2.2's row 3
    // (`nk-no-opt-in`) fires first and creation is never reached. Tested directly for the same reason
    // 2.2 unit-tests `spliceFence`'s unreachable throw — an untested arm rots.
    const out = createFence("prose only\n", "card", "title: T\n", 0);
    expect(out).toBe("\n```nk-card\ntitle: T\n```\n\nprose only\n");
    expect(locateFence(out)!.body).toBe("title: T\n");
  });

  test("a CRLF note keeps its prose bytes; the created block is LF-only (normalization rule 1)", () => {
    const crlf = "---\r\ntitle: T\r\nnk-type: card\r\n---\r\nProse\r\n";
    const at = crlf.length; // append after the whole note — the container is what is under test
    const out = createFence(crlf, "card", "title: T\n", at);
    expect(out.startsWith(crlf)).toBe(true); // prose bytes byte-for-byte, CRLF intact
    expect(out.slice(crlf.length)).toBe("\n```nk-card\ntitle: T\n```\n\n");
    expect(locateFence(out)!.body).toBe("title: T\n");
  });

  describe("PURE BUT NOT TOTAL — a caller bug throws, the same call cardTree makes", () => {
    test("an info-string type outside /^[a-z]+$/ throws", () => {
      for (const bad of ["nk-card", "Card", "card1", "", "ca rd", "card-x", "CARD"]) {
        expect(() => createFence(CANONICAL, bad, "title: T\n", 0)).toThrow(
          /info-string type must match/,
        );
      }
      expect(() => createFence(CANONICAL, "card", "title: T\n", 0)).not.toThrow();
    });

    test("🔴 THE `at` GUARD — an unguarded offset destroys the note SILENTLY", () => {
      // `String.prototype.slice` coerces and clamps rather than failing, so the two-slice form has no
      // natural bottom. Each of these returned a plausible-looking string with the guard removed
      // (counterfactual run + recorded in the Debug Log): NaN put the block BEFORE the opening `---`
      // (no opt-in, unrenderable); 1.5 split `---` mid-delimiter; -1 duplicated the last byte on both
      // sides of the block. None threw. `at` is computed from a frontmatter scan that can return -1,
      // so this is a REACHABLE caller bug, not a hypothetical one.
      for (const bad of [NaN, 1.5, -1, Infinity, CANONICAL.length + 1]) {
        expect(() => createFence(CANONICAL, "card", "title: T\n", bad)).toThrow(
          /insertion offset must be an integer/,
        );
      }
      expect(() => createFence(CANONICAL, "card", "title: T\n", 0)).not.toThrow();
      expect(() => createFence(CANONICAL, "card", "title: T\n", CANONICAL.length)).not.toThrow();
    });
  });

  test("FR-16 parity holds on a fence this story just created", () => {
    // A second `\n` after `body` would put a blank line inside the fence, which `parseFenceBody` then
    // drops (rule 2) — making `serialize(parse(body)) !== body` on a fence 2.5 authored, and failing
    // Story 3.1's gate.
    const body = "title: T\nrole: r\ntags: [a, b]\n";
    const out = createFence(CANONICAL, "card", body, afterFrontmatter(CANONICAL));
    const found = locateFence(out)!;
    expect(`${serializeFenceBody(parseFenceBody(found.body))}\n`).toBe(found.body);
  });
});
