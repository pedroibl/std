import { describe, expect, test } from "bun:test";

import { extractJson, parseFrontmatter, parseNdjson } from "./parse";

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
