import { describe, expect, test } from "bun:test";

import { extractJson, parseFrontmatter, parseFrontmatterBlock, parseNdjson } from "./parse";

describe("parseNdjson", () => {
  test("parses one object per non-blank line", () => {
    const text = '{"a":1}\n{"b":2}\n{"c":3}';
    expect(parseNdjson(text)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  test("skips malformed lines without throwing", () => {
    const text = '{"a":1}\nnot json\n{"b":2}\n}{garbage';
    expect(parseNdjson(text)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("skips blank and whitespace-only lines", () => {
    const text = '\n  \n{"a":1}\n\t\n{"b":2}\n';
    expect(parseNdjson(text)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("empty string yields an empty array", () => {
    expect(parseNdjson("")).toEqual([]);
  });

  test("all-garbage input yields an empty array (never throws)", () => {
    expect(parseNdjson("nope\n???\n}{")).toEqual([]);
  });

  test("carries the caller's element type", () => {
    const rows = parseNdjson<{ n: number }>('{"n":7}');
    expect(rows[0]?.n).toBe(7);
  });
});

describe("parseFrontmatter", () => {
  test("returns {} when there is no leading --- block", () => {
    expect(parseFrontmatter("# just a heading\n\nbody")).toEqual({});
  });

  test("parses scalar key/value pairs", () => {
    const text = "---\nname: leo-tan\ntype: person\n---\nbody";
    expect(parseFrontmatter(text)).toEqual({ name: "leo-tan", type: "person" });
  });

  test("parses an [a, b] value into a string[]", () => {
    const text = "---\ntags: [ai, edge, cloudflare]\n---";
    expect(parseFrontmatter(text)).toEqual({ tags: ["ai", "edge", "cloudflare"] });
  });

  test("strips surrounding quotes from scalars and array elements", () => {
    const text = `---\ntitle: "Hello World"\naliases: ['a', "b"]\n---`;
    expect(parseFrontmatter(text)).toEqual({ title: "Hello World", aliases: ["a", "b"] });
  });

  test("splits on the first colon only, keeping a value that contains ':'", () => {
    const text = "---\nurl: https://pedroivo.com.au\n---";
    expect(parseFrontmatter(text)).toEqual({ url: "https://pedroivo.com.au" });
  });

  test("skips lines without a key (no leading colon)", () => {
    const text = "---\njust-a-line-no-colon\nkey: val\n---";
    expect(parseFrontmatter(text)).toEqual({ key: "val" });
  });

  test("tolerates CRLF (\\r\\n) line endings", () => {
    const text = "---\r\nname: leo-tan\r\ntags: [ai, edge]\r\n---\r\nbody";
    expect(parseFrontmatter(text)).toEqual({ name: "leo-tan", tags: ["ai", "edge"] });
  });
});

describe("extractJson", () => {
  test("pulls a balanced object out of surrounding prose", () => {
    expect(extractJson<{ ok: boolean }>('here you go: {"ok":true} — done')).toEqual({ ok: true });
  });

  test("pulls a balanced array when there is no object", () => {
    expect(extractJson<number[]>("result: [1, 2, 3] (that's all)")).toEqual([1, 2, 3]);
  });

  test("handles a fenced JSON object", () => {
    expect(extractJson<{ x: number; y: number }>('```json\n{"x":1,"y":2}\n```')).toEqual({
      x: 1,
      y: 2,
    });
  });

  test("resolves an array-of-objects to the array, not the inner object", () => {
    expect(extractJson<Array<{ a: number }>>('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  test("still resolves a bare object when it leads the text", () => {
    expect(extractJson<{ a: number }>('noise {"a":1} more [x]')).toEqual({ a: 1 });
  });

  test("resolves an array-of-objects embedded in prose", () => {
    expect(extractJson<Array<{ id: number }>>('rows: [{"id":1},{"id":2}] done')).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });

  test("returns null when nothing balanced parses", () => {
    expect(extractJson("no json here at all")).toBeNull();
  });

  test("returns null on an unparseable brace fragment (never throws)", () => {
    expect(extractJson("almost {not, valid json}")).toBeNull();
  });

  test("carries the caller's type", () => {
    const v = extractJson<{ n: number }>('{"n":42}');
    expect(v?.n).toBe(42);
  });
});

// ── parseFrontmatterBlock — the block's END, from the same match as its fields (Story 2.5) ────────

describe("parseFrontmatterBlock — one match, one answer", () => {
  test("`parseFrontmatter` is exactly the fields half — no behaviour change for existing callers", () => {
    for (const text of [
      "---\na: 1\nb: [x, y]\n---\nprose\n",
      "---\r\na: 1\r\n---\r\nprose\r\n",
      "no frontmatter at all\n",
      "",
      "---\n---\n",
      "---\ntitle: \"Some: Thing\"\n---\n",
    ]) {
      expect(parseFrontmatter(text)).toEqual(parseFrontmatterBlock(text).fields);
    }
  });

  test("`end` lands just past the closing delimiter's line, for LF, CRLF and EOF", () => {
    const cases: Array<[string, string]> = [
      ["---\na: 1\n---\nprose\n", "prose\n"],
      ["---\na: 1\n---\n\nprose\n", "\nprose\n"],
      ["---\r\na: 1\r\n---\r\nprose\r\n", "prose\r\n"],
      ["---\na: 1\n---", ""],                    // EOF with no terminator
      ["---\na: 1\n---   \nprose\n", "prose\n"], // trailing whitespace on the closing line
    ];
    for (const [text, rest] of cases) {
      expect(text.slice(parseFrontmatterBlock(text).end)).toBe(rest);
    }
  });

  test("⚠ A LONE-CR note has NO block at all, and `end` agrees with that rather than guessing", () => {
    // The opening pattern requires `---\n` (`/^---\r?\n/`), so a lone-CR document is not frontmatter to
    // this parser — it never was, and that is inherited behaviour, not something the `end` half
    // introduced. What matters is that BOTH halves say so: no fields, and offset 0. An `end` that
    // pointed past a "block" the fields half did not see is exactly the disagreement this type exists
    // to make impossible.
    const loneCr = "---\ra: 1\r---\rprose\r";
    expect(parseFrontmatterBlock(loneCr)).toEqual({ fields: {}, end: 0 });
  });

  test("no block ⇒ `end` is 0, so a caller inserts at the very start", () => {
    expect(parseFrontmatterBlock("just prose\n").end).toBe(0);
    expect(parseFrontmatterBlock("").end).toBe(0);
    // An UNTERMINATED block is not a block: there is no closing `---` to end after.
    expect(parseFrontmatterBlock("---\na: 1\nprose with no close\n").end).toBe(0);
  });

  test("🔴 REGRESSION — a GLUED closing delimiter: fields and `end` cannot disagree", () => {
    // This is the case that made a caller-side "where does frontmatter stop" pattern corrupt a note.
    // `parseFrontmatter` treats `---EXTRA prose` as the closing delimiter and returns real fields; a
    // separate `/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r\n|\r|\n|$)/` found NO match and reported offset 0,
    // so the caller inserted BEFORE the opening `---`, the note stopped being frontmatter-led, and the
    // `nk-type:` opt-in it carried silently vanished. Measured 2026-08-06; found in cross-vendor review.
    const glued = "---\ntitle: Hello\nnk-type: card\n---EXTRA prose\n";
    const block = parseFrontmatterBlock(glued);

    expect(block.fields).toEqual({ title: "Hello", "nk-type": "card" }); // a block, with an opt-in
    expect(block.end).toBeGreaterThan(0);                                 // …and it is NOT offset 0

    // The end runs past the WHOLE closing line, glue included — inserting there splits no line the
    // author wrote, and leaves the frontmatter intact and still leading. On this fixture the glued
    // line is the last one, so `end` is the whole document.
    expect(block.end).toBe(glued.length);
    expect(glued.slice(block.end)).toBe("");

    // …and with prose after it, `end` stops at the line boundary rather than swallowing the note.
    const withProse = "---\ntitle: Hello\nnk-type: card\n---EXTRA\nreal prose\n";
    expect(withProse.slice(parseFrontmatterBlock(withProse).end)).toBe("real prose\n");

    // The property that matters: inserting at `end` keeps the note frontmatter-led and the opt-in alive.
    const inserted = glued.slice(0, block.end) + "INSERTED\n" + glued.slice(block.end);
    expect(inserted.startsWith("---\n")).toBe(true);
    expect(parseFrontmatter(inserted)).toEqual({ title: "Hello", "nk-type": "card" });

    // COUNTERFACTUAL — the pattern that shipped first, at offset 0, and what it did to this note.
    const OLD = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r\n|\r|\n|$)/;
    const oldEnd = OLD.exec(glued) === null ? 0 : OLD.exec(glued)![0].length;
    expect(oldEnd).toBe(0);
    const wrecked = "INSERTED\n" + glued;
    expect(wrecked.startsWith("---")).toBe(false);
    expect(parseFrontmatter(wrecked)).toEqual({}); // the opt-in is GONE, silently
  });
});
