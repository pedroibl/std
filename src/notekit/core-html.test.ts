import { test, expect } from "bun:test";
import { escapeHtml } from "../core";
import { parseFenceBody } from "./core-fence";
import { nkTreeToHtml, renderCardHtml } from "./core-html";
import { cardTree } from "./core-nknode";
import type { NkNode } from "./core-nknode";
import { noteToRenderSpec } from "./core-renderspec";
import type { Injected, RenderSpec, Rubric } from "./core-renderspec";

const INJECTED: Injected = { id: "nk-0001", generatedAt: "2026-08-05T00:00:00.000Z" };

/**
 * The canonical fixture, deliberately awkward: markup metacharacters in the title and in a value, a
 * list, and an apostrophe. A serializer that skipped `escapeHtml` would produce structurally
 * different — and injectable — markup here, so the byte-equality below doubles as the escaping proof.
 */
const CANONICAL: RenderSpec = {
  version: "nk-v1",
  kind: "card",
  id: "nk-0001",
  generatedAt: "2026-08-05T00:00:00.000Z",
  title: 'Ampersands & "quotes" <in> the title',
  fields: [
    { key: "summary", label: "Summary", value: "a <b>bold</b> claim & an ' apostrophe" },
    { key: "tags", label: "Tags", value: ["primer", "protocol & pattern"] },
  ],
};

/**
 * The determinism proof (AC #3): a fixed literal, NOT `toMatchSnapshot`. The repo ships no snapshot
 * infra, and a snapshot call would write its file and pass unconditionally on the first run — which
 * proves nothing. Written as joined parts only so it stays readable; every part is a literal.
 */
const CANONICAL_HTML = [
  '<div class="nk-card">',
  '<h3 class="nk-card-title">Ampersands &amp; &quot;quotes&quot; &lt;in&gt; the title</h3>',
  '<div class="nk-card-fields">',
  '<div class="nk-field">',
  '<span class="nk-field-label">Summary</span>',
  '<span class="nk-field-value">a &lt;b&gt;bold&lt;/b&gt; claim &amp; an &#39; apostrophe</span>',
  "</div>",
  '<div class="nk-field">',
  '<span class="nk-field-label">Tags</span>',
  '<ul class="nk-field-values">',
  '<li class="nk-field-value">primer</li>',
  '<li class="nk-field-value">protocol &amp; pattern</li>',
  "</ul>",
  "</div>",
  "</div>",
  '<div class="nk-card-meta">',
  '<span class="nk-card-version">nk-v1</span>',
  '<span class="nk-card-kind">card</span>',
  '<span class="nk-card-id">nk-0001</span>',
  '<span class="nk-card-generated">2026-08-05T00:00:00.000Z</span>',
  "</div>",
  "</div>",
].join("");

// ── AC #3 — deterministic, byte-identical ───────────────────────────────────────────────────────

test("byte-equals a fixed expected literal for the canonical fixture", () => {
  expect(renderCardHtml(CANONICAL)).toBe(CANONICAL_HTML);
});

test("two runs over the same spec are byte-identical", () => {
  expect(renderCardHtml(CANONICAL)).toBe(renderCardHtml(CANONICAL));
});

test("two runs over the same tree are byte-identical", () => {
  const tree = cardTree(CANONICAL);
  expect(nkTreeToHtml(tree)).toBe(nkTreeToHtml(tree));
});

test("the output carries no clock or counter — a spec built minutes apart renders the same", () => {
  // Nothing in the string may vary run to run: the id and the timestamp are DATA in the spec,
  // injected upstream at `noteToRenderSpec` (Story 1.1), never read here.
  const a = renderCardHtml({ ...CANONICAL });
  const b = renderCardHtml(JSON.parse(JSON.stringify(CANONICAL)) as RenderSpec);
  expect(a).toBe(b);
  expect(a).toContain("nk-0001");
  expect(a).toContain("2026-08-05T00:00:00.000Z");
});

// ── AC #2 — every field the spec carries reaches the HTML, escaped ──────────────────────────────

test("every scalar the spec carries appears, HTML-escaped", () => {
  const html = renderCardHtml(CANONICAL);
  for (const value of [
    CANONICAL.version,
    CANONICAL.kind,
    CANONICAL.id,
    CANONICAL.generatedAt,
    CANONICAL.title,
    "Summary",
    "a <b>bold</b> claim & an ' apostrophe",
    "Tags",
    "primer",
    "protocol & pattern",
  ]) {
    expect(html).toContain(escapeHtml(value));
  }
});

test("escapeHtml is genuinely on the path — no raw metacharacter survives from a value", () => {
  const html = renderCardHtml(CANONICAL);
  // The only `<`/`>` left are tag delimiters, and the only `"` are attribute quotes. If the escaper
  // were bypassed, the title's `<in>` would appear verbatim and this would fail.
  expect(html).not.toContain("<b>bold</b>");
  expect(html).not.toContain("<in>");
  expect(html).not.toContain('"quotes"');
  expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  expect(html).toContain("&#39;");
});

test("a value that closes the card cannot break out of it", () => {
  const attack = renderCardHtml({
    ...CANONICAL,
    fields: [{ key: "x", label: "X", value: '</div><script>alert(1)</script>' }],
  });
  expect(attack).not.toContain("<script>");
  expect(attack).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  // Still exactly one card element: the closing `</div>` in the value did not terminate it early.
  expect(attack.startsWith('<div class="nk-card">')).toBe(true);
  expect(attack.endsWith("</div>")).toBe(true);
});

test("a class value is escaped too, not just text", () => {
  const node: NkNode = { tag: "div", class: 'nk-card" onload="x' };
  expect(nkTreeToHtml(node)).toBe('<div class="nk-card&quot; onload=&quot;x"></div>');
});

test("no Obsidian or DOM dependency — a poisoned `document` is never touched", () => {
  // Asserting `"document" in globalThis` would be a claim about the ENVIRONMENT, and it is not even
  // stable: another suite in a full `bun test` run installs a DOM shim on the shared global, so that
  // form passed alone and failed in the full run. This asserts the CALL PATH instead — any read of
  // any property of `document` throws, and the projection still renders byte-identically.
  const global = globalThis as unknown as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(global, "document");
  const prior = global.document;
  global.document = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`the headless projection touched document.${String(prop)}`);
      },
    },
  );
  try {
    expect(renderCardHtml(CANONICAL)).toBe(CANONICAL_HTML);
  } finally {
    if (had) global.document = prior;
    else delete global.document;
  }
});

test("renders end to end from a fence body — the real caller path", () => {
  const rubric: Rubric = {
    kind: "card",
    titleField: "title",
    fields: [{ key: "title", label: "Title" }, { key: "tags", label: "Tags" }],
  };
  const spec = noteToRenderSpec(
    parseFenceBody("title: A real note\ntags: [primer, protocol]"),
    rubric,
    INJECTED,
  );
  expect(renderCardHtml(spec)).toBe(
    [
      '<div class="nk-card">',
      '<h3 class="nk-card-title">A real note</h3>',
      '<div class="nk-card-fields">',
      '<div class="nk-field">',
      '<span class="nk-field-label">Title</span>',
      '<span class="nk-field-value">A real note</span>',
      "</div>",
      '<div class="nk-field">',
      '<span class="nk-field-label">Tags</span>',
      '<ul class="nk-field-values">',
      '<li class="nk-field-value">primer</li>',
      '<li class="nk-field-value">protocol</li>',
      "</ul>",
      "</div>",
      "</div>",
      '<div class="nk-card-meta">',
      '<span class="nk-card-version">nk-v1</span>',
      '<span class="nk-card-kind">card</span>',
      '<span class="nk-card-id">nk-0001</span>',
      '<span class="nk-card-generated">2026-08-05T00:00:00.000Z</span>',
      "</div>",
      "</div>",
    ].join(""),
  );
});

// ── serializer mechanics over the real type domain ──────────────────────────────────────────────

test("an omitted class emits no attribute; an empty class is treated the same", () => {
  expect(nkTreeToHtml({ tag: "div" })).toBe("<div></div>");
  expect(nkTreeToHtml({ tag: "div", class: "" })).toBe("<div></div>");
});

test("text is emitted before children, in the tree's order", () => {
  const node: NkNode = {
    tag: "div",
    text: "lead",
    children: [{ tag: "span", text: "a" }, { tag: "span", text: "b" }],
  };
  expect(nkTreeToHtml(node)).toBe("<div>lead<span>a</span><span>b</span></div>");
});

test("an empty children array renders an empty element, never a self-closing tag", () => {
  expect(nkTreeToHtml({ tag: "ul", class: "nk-field-values", children: [] })).toBe(
    '<ul class="nk-field-values"></ul>',
  );
});

test("a malformed tag throws instead of emitting broken markup", () => {
  // The one value escaping cannot save: an escaped tag name is not a tag at all.
  expect(() => nkTreeToHtml({ tag: "div><script" })).toThrow(/"tag" must match/);
  expect(() => nkTreeToHtml({ tag: "" })).toThrow(/"tag" must match/);
  expect(() => nkTreeToHtml({ tag: 7 } as unknown as NkNode)).toThrow(/"tag" must match/);
});

test("a hole in children throws, naming its path — it is never silently skipped", () => {
  const children: NkNode[] = [];
  children[1] = { tag: "span", text: "second" };
  expect(() => nkTreeToHtml({ tag: "div", children })).toThrow(
    /root\.children\[0\].*children must be dense/,
  );
});

test("a non-string text or class throws rather than stringifying to garbage", () => {
  expect(() => nkTreeToHtml({ tag: "div", text: 7 } as unknown as NkNode)).toThrow(
    /"text" must be a string/,
  );
  expect(() => nkTreeToHtml({ tag: "div", class: {} } as unknown as NkNode)).toThrow(
    /"class" must be a string/,
  );
});

test("a non-object node throws, naming where it sits in the tree", () => {
  expect(() => nkTreeToHtml({ tag: "div", children: ["oops"] } as unknown as NkNode)).toThrow(
    /root\.children\[0\].*expected an object, got string/,
  );
  expect(() => nkTreeToHtml(null as unknown as NkNode)).toThrow(/expected an object, got null/);
});

test("a non-array children throws", () => {
  expect(() => nkTreeToHtml({ tag: "div", children: "no" } as unknown as NkNode)).toThrow(
    /"children" must be an array/,
  );
});

test("inherited property names are not read off a node", () => {
  // `text` reached only as an OWN property: a polluted prototype must not inject content into the
  // markup. Restored immediately so no other test inherits the pollution.
  const proto = Object.prototype as unknown as Record<string, unknown>;
  proto.text = "INJECTED";
  try {
    expect(nkTreeToHtml({ tag: "div" } as NkNode)).toBe("<div></div>");
  } finally {
    delete proto.text;
  }
});

test("a tree round-tripped through JSON serializes identically — the 1.3 hand-off is data", () => {
  const tree = cardTree(CANONICAL);
  const revived = JSON.parse(JSON.stringify(tree)) as NkNode;
  expect(nkTreeToHtml(revived)).toBe(nkTreeToHtml(tree));
});
