import { describe, expect, test } from "bun:test";

import {
  chunkContent,
  extractRelated,
  extractSection,
  extractWikilinks,
  findSection,
  insertInSection,
  sectionRootAt,
  sectionRoots,
} from "./markdown";

describe("findSection", () => {
  const doc = "# Title\n\n## A\nalpha body\n\n## B\nbeta body\n";

  test("locates a section and bounds it at the next same-level heading", () => {
    const bounds = findSection(doc, "## A");
    expect(bounds).not.toBeNull();
    expect(doc.slice(bounds!.start, bounds!.bodyStart)).toBe("## A\n");
    expect(doc.slice(bounds!.bodyStart, bounds!.bodyEnd).trim()).toBe("alpha body");
  });

  test("returns null when the heading is absent", () => {
    expect(findSection(doc, "## Nope")).toBeNull();
  });

  test("section at EOF runs to the end", () => {
    const bounds = findSection(doc, "## B");
    expect(bounds!.bodyEnd).toBe(doc.length);
    expect(doc.slice(bounds!.bodyStart, bounds!.bodyEnd).trim()).toBe("beta body");
  });

  test("a nested ### is NOT the boundary of a ## section", () => {
    const nested = "## A\n### sub\ninner\n## B\nlast\n";
    const bounds = findSection(nested, "## A");
    expect(nested.slice(bounds!.bodyStart, bounds!.bodyEnd).trim()).toBe("### sub\ninner");
  });

  test("a ### block ends at the next ### (same level)", () => {
    const blocks = "### one\nbody one\n### two\nbody two\n";
    expect(extractSection(blocks, "### one")).toBe("body one");
  });

  test("matches the heading at a line start only, not a prose mention", () => {
    const prose = "See ## A below.\n\n## A\nreal body\n";
    const bounds = findSection(prose, "## A");
    // The real heading is on line 3, not the inline mention on line 1.
    expect(prose.slice(bounds!.start).startsWith("## A\nreal body")).toBe(true);
  });

  test("matches a heading as a prefix (mirrors origin indexOf)", () => {
    const doc2 = "## Anti-Patterns (from observations)\nx\n## Next\n";
    expect(extractSection(doc2, "## Anti-Patterns")).toBe("x");
  });

  test("immediately-following heading yields an empty body", () => {
    const empty = "## A\n## B\nbeta\n";
    expect(extractSection(empty, "## A")).toBe("");
  });
});

describe("extractSection", () => {
  test("returns null when absent", () => {
    expect(extractSection("## A\nx\n", "## Z")).toBeNull();
  });

  test("returns the trimmed body", () => {
    expect(extractSection("## A\n\n  padded  \n\n## B\n", "## A")).toBe("padded");
  });
});

describe("insertInSection", () => {
  const doc = "## A\nalpha\n\n## B\nbeta\n";

  test("splices text at the end of the section, before the next heading", () => {
    expect(insertInSection(doc, "## A", "\n- added")).toBe("## A\nalpha\n\n- added\n## B\nbeta\n");
  });

  test("appends into a section at EOF", () => {
    const out = insertInSection("## A\nalpha\n", "## A", "\n- added");
    expect(out).toBe("## A\nalpha\n- added\n");
  });

  test("returns content unchanged when the section is absent", () => {
    expect(insertInSection(doc, "## Z", "\n- added")).toBe(doc);
  });

  test("inserted entry lands on its own line, not glued to the next heading", () => {
    const out = insertInSection(doc, "## A", "\n- added");
    expect(out).not.toContain("added## B");
    expect(out).toContain("- added\n## B");
  });

  test("does not split a CRLF sequence when inserting", () => {
    const crlf = "## A\r\nalpha\r\n## B\r\nbeta\r\n";
    const out = insertInSection(crlf, "## A", "\r\n- added");
    expect(out).toBe("## A\r\nalpha\r\n- added\r\n## B\r\nbeta\r\n");
    expect(out).not.toContain("\r\r");
    expect(out).not.toContain("added\r## B");
  });
});

describe("chunkContent", () => {
  test("splits on H2/H3 with a preamble chunk", () => {
    const md = "intro text\n\n## One\nbody one\n\n### Two\nbody two\n";
    const chunks = chunkContent(md);
    expect(chunks).toEqual([
      { heading: "preamble", body: "intro text" },
      { heading: "One", body: "body one" },
      { heading: "Two", body: "body two" },
    ]);
  });

  test("no preamble chunk when content starts with a heading", () => {
    const chunks = chunkContent("## One\nbody\n");
    expect(chunks).toEqual([{ heading: "One", body: "body" }]);
  });

  test("drops a heading with an empty body", () => {
    const chunks = chunkContent("## One\n\n## Two\nbody two\n");
    expect(chunks).toEqual([{ heading: "Two", body: "body two" }]);
  });

  test("falls back to paragraph groups when there are no H2/H3 headings", () => {
    const md =
      "This first paragraph is comfortably longer than thirty characters.\n\n" +
      "And here is a second paragraph, also well past the thirty-char floor.";
    const chunks = chunkContent(md);
    expect(chunks.map((c) => c.heading)).toEqual(["p1", "p2"]);
    expect(chunks[0].body.startsWith("This first")).toBe(true);
  });

  test("paragraph fallback drops fragments of 30 chars or fewer", () => {
    const md = "too short\n\nThis paragraph clears the thirty-character threshold easily.";
    const chunks = chunkContent(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe("p1");
  });

  test("preamble-only document with a single paragraph yields one p1 chunk", () => {
    const md = "Just one paragraph of prose, no headings at all, comfortably over thirty chars.";
    expect(chunkContent(md)).toEqual([{ heading: "p1", body: md }]);
  });

  test("empty content yields no chunks", () => {
    expect(chunkContent("")).toEqual([]);
  });
});

describe("extractWikilinks", () => {
  test("extracts slugs in order", () => {
    expect(extractWikilinks("see [[alpha]] and [[beta]]")).toEqual(["alpha", "beta"]);
  });

  test("drops the alias and keeps the slug", () => {
    expect(extractWikilinks("[[real-slug|Display Text]]")).toEqual(["real-slug"]);
  });

  test("reduces a domain-path prefix to its last segment", () => {
    expect(extractWikilinks("[[ideas/big-idea]] [[people/jane]]")).toEqual(["big-idea", "jane"]);
  });

  test("skips _-prefixed slugs", () => {
    expect(extractWikilinks("[[_private]] [[public]]")).toEqual(["public"]);
  });

  test("ignores wikilinks inside frontmatter", () => {
    const note = "---\ntitle: [[not-a-body-link]]\n---\nbody [[real-link]]\n";
    expect(extractWikilinks(note)).toEqual(["real-link"]);
  });

  test("keeps spaces in multi-word slugs", () => {
    expect(extractWikilinks("[[My Great Idea]]")).toEqual(["My Great Idea"]);
  });

  test("an unclosed wikilink does not swallow the next line", () => {
    expect(extractWikilinks("[[unclosed\n[[real]]")).toEqual(["real"]);
  });

  test("returns [] when there are no links", () => {
    expect(extractWikilinks("plain prose, no links")).toEqual([]);
  });
});

describe("extractRelated", () => {
  test("parses the nested object-list shape", () => {
    const note = "---\nrelated:\n  - slug: foo\n    type: depends-on\n  - slug: bar\n---\nbody\n";
    expect(extractRelated(note)).toEqual([
      { slug: "foo", type: "depends-on" },
      { slug: "bar", type: "related" },
    ]);
  });

  test("parses the flat array shape", () => {
    const note = "---\nrelated: [foo, bar]\n---\nbody\n";
    expect(extractRelated(note)).toEqual([
      { slug: "foo", type: "related" },
      { slug: "bar", type: "related" },
    ]);
  });

  test("parses the flat scalar shape", () => {
    const note = "---\nrelated: solo\n---\nbody\n";
    expect(extractRelated(note)).toEqual([{ slug: "solo", type: "related" }]);
  });

  test("strips quotes from slug and type", () => {
    const note = '---\nrelated:\n  - slug: "quoted"\n    type: \'kind\'\n---\n';
    expect(extractRelated(note)).toEqual([{ slug: "quoted", type: "kind" }]);
  });

  test("stops the block at the next top-level key", () => {
    const note = "---\nrelated:\n  - slug: foo\ntags: [x]\n---\n";
    expect(extractRelated(note)).toEqual([{ slug: "foo", type: "related" }]);
  });

  test("handles type-before-slug key order within an item", () => {
    const note = "---\nrelated:\n  - type: depends-on\n    slug: foo\n---\n";
    expect(extractRelated(note)).toEqual([{ slug: "foo", type: "depends-on" }]);
  });

  test("returns [] when there is no frontmatter", () => {
    expect(extractRelated("just a body\n")).toEqual([]);
  });

  test("returns [] when frontmatter has no related field", () => {
    expect(extractRelated("---\ntitle: x\n---\nbody\n")).toEqual([]);
  });
});

// Story 12.3 — section-root matcher promoted from DocCheck.ts:61-90 / ReferenceCheck.ts:297-326
// (byte-identical across both). Parity oracle: the output must reproduce the originals char-for-char.
describe("sectionRoots — `## … (paths under \\`X\\`)` heading-hint parser", () => {
  test("seeds a default empty root at pos 0 before any heading", () => {
    expect(sectionRoots("plain body, no headings\n")).toEqual([{ pos: 0, root: "" }]);
  });

  test("a `(paths under \\`X/\\`)` heading pushes its root at the heading's char offset", () => {
    const doc = "# Title\n\n## Routing (paths under `PAI/USER/`)\nbody\n";
    const at = doc.indexOf("## Routing");
    expect(sectionRoots(doc)).toEqual([
      { pos: 0, root: "" },
      { pos: at, root: "PAI/USER/" },
    ]);
  });

  test("appends a trailing slash when the hinted root lacks one", () => {
    const doc = "## Section (paths under `PAI/DOCUMENTATION`)\n";
    expect(sectionRoots(doc)[1]).toEqual({ pos: 0, root: "PAI/DOCUMENTATION/" });
  });

  test("a heading with no `paths under` hint pushes an empty root (resets to default)", () => {
    const doc = "## Alpha (paths under `PAI/`)\nx\n## Beta\ny\n";
    const beta = doc.indexOf("## Beta");
    const roots = sectionRoots(doc);
    expect(roots).toEqual([
      { pos: 0, root: "" },
      { pos: doc.indexOf("## Alpha"), root: "PAI/" },
      { pos: beta, root: "" },
    ]);
  });

  test("accumulates char offsets as line.length + 1 (LF)", () => {
    // Two headings; the second's pos must equal the byte offset of its line start.
    const doc = "## One (paths under `a/`)\n## Two (paths under `b/`)\n";
    const roots = sectionRoots(doc);
    expect(roots[1].pos).toBe(0);
    expect(roots[2].pos).toBe("## One (paths under `a/`)\n".length);
  });
});

describe("sectionRootAt — active root at a char position", () => {
  const doc = "# Title\n\n## R (paths under `PAI/USER/`)\nrel/path.md\n## Plain\nx\n";
  const roots = sectionRoots(doc);

  test("returns the default empty root before the first hinted heading", () => {
    expect(sectionRootAt(roots, 0)).toBe("");
  });

  test("returns the section root for a position inside the routing section", () => {
    expect(sectionRootAt(roots, doc.indexOf("rel/path.md"))).toBe("PAI/USER/");
  });

  test("returns to empty once a non-hinting heading resets the root", () => {
    expect(sectionRootAt(roots, doc.indexOf("x\n"))).toBe("");
  });

  test("a position exactly on the heading offset activates that root (pos <= charPos)", () => {
    const at = doc.indexOf("## R");
    expect(sectionRootAt(roots, at)).toBe("PAI/USER/");
  });
});
