// Story 9.3 — the markdown kit: locate/extract/splice a `## Section`, chunk a document on H2/H3, and
// pull `[[wikilinks]]` + frontmatter `related:` out of Obsidian notes. The structural helpers that
// were re-rolled across PAI/Tools — four section-edit fns in WisdomFrameUpdater, the same `### `-block
// splice in OpinionTracker, chunkContent in MigrateScan, link/related scans in KnowledgeGraph and
// friends. Pure (D1): zero node:*/fs/DOM/network, no process/document, no clock.
//
// These are pure structural shapers / nullable lookups, NOT the Result union and NOT throwing. A
// missing section yields null (findSection/extractSection) or unchanged content (insertInSection); a
// doc with no links/related yields []. "Not found" is an absence signal, not an error — do not
// "harden" any of these into a throw.
//
// Identity stays in the caller (D4): the `getDateStr()` stamp on Wisdom entries, the `basename(file):`
// label MigrateScan prefixes onto chunks, and the anchor names a caller uses to graft a *missing*
// section (`## Cross-Frame`, `## Predictive`, …) are all the caller's job. These helpers take the
// heading as an argument and never invent one.

import { parseFrontmatter } from "./parse";
import { escapeRegExp } from "./text";

/** Byte offsets of a located section: the heading itself, its body, and the boundary. */
export interface SectionBounds {
  /** Index of the heading's first `#`. */
  start: number;
  /** Index just past the heading line — the first char of the section body. */
  bodyStart: number;
  /** Index of the boundary: the next heading at the same-or-shallower level, or `content.length`. */
  bodyEnd: number;
}

/**
 * Locate a section by its literal heading (`"## Evolution Log"`, `"### " + statement`, …). The heading
 * is matched at the start of a line (so a mention in prose never false-matches) as a PREFIX, mirroring
 * the `indexOf("## X")` the origins use against headings like `"## Anti-Patterns (from observations)"`.
 * The section ends at the next heading whose `#`-depth is the same or shallower than this one — depth
 * is inferred from the passed heading's leading `#`-run — so a nested `### ` inside a `## ` section is
 * NOT treated as the boundary. Returns `null` when the heading is absent.
 */
export function findSection(content: string, heading: string): SectionBounds | null {
  const at = new RegExp(`^${escapeRegExp(heading)}`, "m").exec(content);
  if (!at) return null;
  const start = at.index;
  // Boundary depth = the heading's leading '#'-run (no '#' → level 6, i.e. any heading ends it).
  const hashes = heading.match(/^#+/);
  const level = hashes ? hashes[0].length : 6;
  // Body starts after the heading line.
  const nl = content.indexOf("\n", start);
  const bodyStart = nl === -1 ? content.length : nl + 1;
  // First same-or-shallower heading at a line start within the body, else EOF. `^` (m flag) matches
  // body position 0 too, so `## A` immediately followed by `## B` yields an empty body.
  const after = content.slice(bodyStart);
  const boundary = new RegExp(`^#{1,${level}}\\s`, "m").exec(after);
  const bodyEnd = boundary ? bodyStart + boundary.index : content.length;
  return { start, bodyStart, bodyEnd };
}

/** Return the trimmed body of a section (heading-exclusive), or `null` when the heading is absent. */
export function extractSection(content: string, heading: string): string | null {
  const bounds = findSection(content, heading);
  if (!bounds) return null;
  return content.slice(bounds.bodyStart, bounds.bodyEnd).trim();
}

/**
 * Splice `text` in at the end of a section (just before the boundary heading), returning the new
 * document. `text` is inserted verbatim — the caller pre-formats it (leading `\n`, list marker, table
 * row, …); this never invents the entry shape. When the section is absent the content is returned
 * UNCHANGED — where to graft a missing section is caller policy (its anchor names are identity, D4).
 * The insertion backs up over the boundary heading's preceding newline so a `\n`-led entry lands on
 * its own line rather than gluing to the next heading.
 */
export function insertInSection(content: string, heading: string, text: string): string {
  const bounds = findSection(content, heading);
  if (!bounds) return content;
  // Back up over the boundary heading's preceding newline so a `\n`-led entry lands on its own line
  // rather than gluing to the next heading — and over a CRLF `\r\n` as a unit, never splitting it.
  let at = bounds.bodyEnd;
  if (at > 0 && content[at - 1] === "\n") {
    at = at > 1 && content[at - 2] === "\r" ? at - 2 : at - 1;
  }
  return content.slice(0, at) + text + content.slice(at);
}

/** A chunk of a document: a heading label and its trimmed body. */
export interface Chunk {
  heading: string;
  body: string;
}

/**
 * Split a document into `{ heading, body }` chunks. With H2/H3 headings present, a non-empty preamble
 * before the first heading becomes a `"preamble"` chunk and each heading + non-empty body becomes a
 * chunk (the heading text is stripped of its `#`-marker). With no H2/H3, it falls back to
 * double-blank-line paragraph groups longer than 30 chars, labelled `"p1"`, `"p2"`, … The
 * `basename(file):` prefix the MigrateScan origin builds is NOT baked in here — the caller composes it
 * (D4).
 */
export function chunkContent(content: string): Chunk[] {
  const chunks: Chunk[] = [];
  if (/^#{2,3}\s+/m.test(content)) {
    // parts alternates: [preamble, heading1, body1, heading2, body2, …]
    const parts = content.split(/^(#{2,3}\s+.+)$/m);
    if (parts[0].trim()) chunks.push({ heading: "preamble", body: parts[0].trim() });
    for (let i = 1; i < parts.length; i += 2) {
      const heading = parts[i].replace(/^#{2,3}\s+/, "").trim();
      const body = (parts[i + 1] ?? "").trim();
      if (body) chunks.push({ heading, body });
    }
  } else {
    const paragraphs = content.split(/\n\s*\n/).filter((p) => p.trim().length > 30);
    paragraphs.forEach((p, i) => chunks.push({ heading: `p${i + 1}`, body: p.trim() }));
  }
  return chunks;
}

/** Strip a leading `---` … `---` frontmatter block (LF or CRLF) from `content`. */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "");
}

/**
 * Extract `[[wikilink]]` slugs from a note body (frontmatter stripped first). An alias (`[[slug|text]]`)
 * is dropped, a domain-path prefix is reduced to its last segment (`ideas/foo` → `foo`), and `_`-prefixed
 * slugs are skipped. Returns the slugs in document order; `[]` when there are none.
 */
export function extractWikilinks(content: string): string[] {
  const body = stripFrontmatter(content);
  const links: string[] = [];
  // Newlines are excluded from both classes so an unclosed `[[` can't greedily swallow following
  // lines; spaces stay allowed (multi-word slugs like `[[My Great Idea]]` are valid Obsidian links).
  const re = /\[\[([^\r\n\]|]+)(?:\|[^\r\n\]]+)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const raw = match[1].trim();
    const slug = raw.includes("/") ? raw.split("/").pop()! : raw;
    if (slug && !slug.startsWith("_")) links.push(slug);
  }
  return links;
}

/** A related-note reference parsed from frontmatter. */
export interface Related {
  slug: string;
  type: string;
}

/**
 * Parse the frontmatter `related:` field into `{ slug, type }` entries. Handles both real shapes: the
 * nested object-list
 *
 *     related:
 *       - slug: foo
 *         type: depends-on
 *       - slug: bar
 *
 * and the flat scalar/array `related: foo` / `related: [foo, bar]`. A bare slug (no `type`) defaults to
 * `type: "related"`. Returns `[]` when there is no frontmatter or no `related:` field.
 */
export function extractRelated(content: string): Related[] {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return [];

  // Flat shape (`related: foo` / `related: [a, b]`) — reuse 9.1's parseFrontmatter, the single source
  // of the frontmatter flat-parse, rather than re-rolling it. A nested object-list leaves `related`
  // empty/absent here, so it falls through to the block-walk below.
  const flat = parseFrontmatter(content).related;
  if (typeof flat === "string" && flat) {
    return [{ slug: flat.replace(/['"]/g, ""), type: "related" }];
  }
  if (Array.isArray(flat) && flat.length > 0) {
    return flat.map((v) => ({ slug: v.replace(/['"]/g, ""), type: "related" }));
  }

  // Nested object-list shape: walk the `related:` block, accumulating slug + type per list item. Both
  // are tracked independently and flushed at each item boundary, so either key order works and a slug
  // with no type defaults to "related".
  const related: Related[] = [];
  let inRelated = false;
  let currentSlug: string | null = null;
  let currentType: string | null = null;
  const flush = () => {
    if (currentSlug) related.push({ slug: currentSlug, type: currentType ?? "related" });
    currentSlug = null;
    currentType = null;
  };
  for (const line of fm[1].split(/\r?\n/)) {
    if (/^related\s*:/.test(line)) {
      inRelated = true;
      continue;
    }
    if (!inRelated) continue;
    // End of block: a non-indented, non-list, non-empty line (the next top-level key).
    if (
      !line.startsWith(" ") &&
      !line.startsWith("\t") &&
      !line.startsWith("-") &&
      line.trim().length > 0
    ) {
      flush();
      inRelated = false;
      continue;
    }
    if (line.trim().startsWith("-")) flush(); // new list item → flush the previous one
    const slugMatch = line.match(/^[\s-]*slug\s*:\s*(.+)/);
    if (slugMatch) {
      currentSlug = slugMatch[1].trim().replace(/['"]/g, "");
      continue;
    }
    const typeMatch = line.match(/^[\s-]*type\s*:\s*(.+)/);
    if (typeMatch) {
      currentType = typeMatch[1].trim().replace(/['"]/g, "");
      continue;
    }
  }
  flush(); // trailing item
  return related;
}
