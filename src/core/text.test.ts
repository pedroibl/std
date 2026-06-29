import { describe, expect, test } from "bun:test";

import {
  collapse,
  contentHash,
  escapeHtml,
  escapeRegExp,
  normalizeTags,
  slugify,
  truncate,
} from "./text";

describe("slugify", () => {
  test("lowercases, replaces spaces, strips punctuation", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });

  test("collapses runs of separators and trims ends", () => {
    expect(slugify("  Foo   --  Bar  ")).toBe("foo-bar");
  });

  test("caps to maxLen", () => {
    expect(slugify("abcdefghij", 5)).toBe("abcde");
  });

  test("re-trims a trailing hyphen exposed by the length cap", () => {
    // "foo bar baz" → "foo-bar-baz"; slice(0,7) → "foo-bar"; no dangling dash
    expect(slugify("foo bar baz", 7)).toBe("foo-bar");
    // slice landing on a separator must not leave it
    expect(slugify("foo bar baz", 8)).toBe("foo-bar");
  });

  test("empty / all-junk input yields empty string", () => {
    expect(slugify("")).toBe("");
    expect(slugify("!!!@@@")).toBe("");
  });

  test("non-ASCII letters are dropped (documented ASCII-only behavior, not transliterated)", () => {
    expect(slugify("São Paulo")).toBe("so-paulo");
    expect(slugify("Tomé")).toBe("tom");
  });
});

describe("truncate", () => {
  test("returns text unchanged when within limit", () => {
    expect(truncate("hello", 5)).toBe("hello");
    expect(truncate("hi", 10)).toBe("hi");
  });

  test("clamps with ellipsis counted toward the limit", () => {
    expect(truncate("hello world", 8)).toBe("hello...");
    expect(truncate("hello world", 8).length).toBe(8);
  });

  test("tiny limit (< 3) leaves only the clamped ellipsis", () => {
    expect(truncate("hello", 2)).toBe("...");
  });

  test("empty string is returned as-is", () => {
    expect(truncate("", 5)).toBe("");
  });
});

describe("collapse", () => {
  test("collapses internal whitespace runs to one space", () => {
    expect(collapse("a   b\t\tc\n\nd")).toBe("a b c d");
  });

  test("trims leading and trailing whitespace", () => {
    expect(collapse("   padded   ")).toBe("padded");
  });

  test("all-whitespace input yields empty string", () => {
    expect(collapse("  \t\n ")).toBe("");
  });
});

describe("escapeRegExp", () => {
  test("escapes regex metacharacters", () => {
    expect(escapeRegExp("a.b*c+d?")).toBe("a\\.b\\*c\\+d\\?");
    expect(escapeRegExp("(x)[y]{z}")).toBe("\\(x\\)\\[y\\]\\{z\\}");
    expect(escapeRegExp("^$|\\")).toBe("\\^\\$\\|\\\\");
  });

  test("the escaped string matches the literal inside a RegExp", () => {
    const id = "1.2.3+a(b)";
    expect(new RegExp(escapeRegExp(id)).test(id)).toBe(true);
  });

  test("plain text passes through unchanged", () => {
    expect(escapeRegExp("plain text 123")).toBe("plain text 123");
  });
});

describe("escapeHtml", () => {
  test("escapes the five entities", () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;",
    );
  });

  test("ampersand is escaped once, not double-escaped", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  test("text with no special characters is unchanged", () => {
    expect(escapeHtml("clean text")).toBe("clean text");
  });
});

describe("normalizeTags", () => {
  test("array input is trimmed, lowercased, empties dropped", () => {
    expect(normalizeTags([" A ", "B", "", "c"])).toEqual(["a", "b", "c"]);
  });

  test("comma string is split", () => {
    expect(normalizeTags("Foo, Bar ,Baz")).toEqual(["foo", "bar", "baz"]);
  });

  test("bracketed string is unwrapped then split", () => {
    expect(normalizeTags("[a, b, c]")).toEqual(["a", "b", "c"]);
    expect(normalizeTags(`["a", "b"]`)).toEqual(["a", "b"]);
  });

  test("empty and trailing-comma inputs drop empties", () => {
    expect(normalizeTags("")).toEqual([]);
    expect(normalizeTags("a,,b,")).toEqual(["a", "b"]);
    expect(normalizeTags("[]")).toEqual([]);
  });

  test("nullish or missing input returns empty array", () => {
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags(undefined)).toEqual([]);
  });
});

describe("contentHash", () => {
  test("is deterministic for the same input", () => {
    expect(contentHash("hello world")).toBe(contentHash("hello world"));
  });

  test("is insensitive to whitespace and case (normalized before hashing)", () => {
    expect(contentHash("Hello   World")).toBe(contentHash("  hello world  "));
  });

  test("differs for different content", () => {
    expect(contentHash("alpha")).not.toBe(contentHash("beta"));
  });

  test("sliceLen bounds what is hashed", () => {
    // Two strings sharing the first 5 chars hash equal when only 5 chars are considered.
    expect(contentHash("abcdeXXXX", 5)).toBe(contentHash("abcdeYYYY", 5));
    expect(contentHash("abcdeXXXX", 9)).not.toBe(contentHash("abcdeYYYY", 9));
  });

  test("returns lowercase hex", () => {
    expect(contentHash("anything")).toMatch(/^[0-9a-f]+$/);
  });

  test("empty string hashes to the djb2 seed", () => {
    expect(contentHash("")).toBe((5381 >>> 0).toString(16));
  });
});
