import { test, expect } from "bun:test";
import { escapeHtml } from "../core";
import { parseFenceBody } from "./core-fence";
import { NK_TAGS, nkTreeToHtml, renderCardHtml } from "./core-html";
import { cardTree } from "./core-nknode";
import type { NkNode } from "./core-nknode";
import { noteToRenderSpec, validate } from "./core-renderspec";
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

test("a field carried with an empty value reaches the HTML — AC #2 over the real fence path", () => {
  // The exact path the third review broke: `bio: ` in the fence → a `{key,label,value:""}` row →
  // `validate` ok → the row must be IN the string. Asserted as bytes, so a partial fix cannot pass.
  const rubric: Rubric = {
    kind: "card",
    titleField: "name",
    fields: [
      { key: "name", label: "Name" },
      { key: "bio", label: "Bio" },
      { key: "tags", label: "Tags" },
    ],
  };
  const spec = noteToRenderSpec(parseFenceBody("name: Ada\nbio: \ntags: [x, y]"), rubric, INJECTED);
  expect(validate(spec).ok).toBe(true);
  expect(renderCardHtml(spec)).toBe(
    [
      '<div class="nk-card">',
      '<h3 class="nk-card-title">Ada</h3>',
      '<div class="nk-card-fields">',
      '<div class="nk-field">',
      '<span class="nk-field-label">Name</span>',
      '<span class="nk-field-value">Ada</span>',
      "</div>",
      '<div class="nk-field">',
      '<span class="nk-field-label">Bio</span>',
      '<span class="nk-field-value"></span>',
      "</div>",
      '<div class="nk-field">',
      '<span class="nk-field-label">Tags</span>',
      '<ul class="nk-field-values">',
      '<li class="nk-field-value">x</li>',
      '<li class="nk-field-value">y</li>',
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

test("an empty scalar and an empty list render the same way — an empty value node either way", () => {
  const html = renderCardHtml({
    ...CANONICAL,
    title: "Consistency",
    fields: [
      { key: "s", label: "S", value: "" },
      { key: "l", label: "L", value: [] },
    ],
  });
  expect(html).toContain('<span class="nk-field-label">S</span><span class="nk-field-value"></span>');
  expect(html).toContain('<span class="nk-field-label">L</span><ul class="nk-field-values"></ul>');
  expect((html.match(/class="nk-field"/g) ?? []).length).toBe(2);
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

test("a well-formed but dangerous tag is rejected — escaping cannot save a script body", () => {
  // `escapeHtml` protects TEXT context; inside `<script>` the payload needs no metacharacters at all.
  // So the tag is checked against `NK_TAGS`, not just against a shape.
  for (const tag of ["script", "style", "iframe", "object", "embed", "link", "meta", "form"]) {
    expect(() => nkTreeToHtml({ tag, text: "alert(1)" })).toThrow(
      /is not in the nk-node tag allowlist/,
    );
  }
  // A custom element passes `TAG_NAME` and is still refused: well-formed is not the same as allowed.
  expect(() => nkTreeToHtml({ tag: "my-widget" })).toThrow(/is not in the nk-node tag allowlist/);
});

test("every tag cardTree can emit is on the allowlist — the card path is not blocked", () => {
  // The allowlist is proven against the real producer rather than a hand-listed set, so a later
  // renderer that reaches for a new tag fails HERE, in the review that must also cover 1.3's DOM
  // serializer — not silently at a caller.
  function tags(node: NkNode): string[] {
    return [node.tag, ...(node.children ?? []).flatMap(tags)];
  }
  const used = new Set(tags(cardTree(CANONICAL)));
  expect([...used].sort()).toEqual(["div", "h3", "li", "span", "ul"]);
  for (const tag of used) expect(NK_TAGS.has(tag)).toBe(true);
});

test("a tree deeper than the bound fails with a path-named error, not a RangeError", () => {
  function nest(levels: number): NkNode {
    let node: NkNode = { tag: "span", text: "leaf" };
    for (let i = 0; i < levels; i++) node = { tag: "div", children: [node] };
    return node;
  }
  // 64 levels serialize; 65 is refused — and the refusal names its path like every other malformed
  // node, instead of dying inside the engine with `Maximum call stack size exceeded`.
  expect(nkTreeToHtml(nest(63))).toContain("leaf");
  let thrown: unknown;
  try {
    nkTreeToHtml(nest(64));
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).name).toBe("Error");
  expect((thrown as Error).message).toMatch(/^nk-node at root\.children\[0\]/);
  expect((thrown as Error).message).toMatch(/nesting exceeds the 64-level limit/);
});

test("a cycle is caught by the same depth bound — no stack overflow", () => {
  const cyclic: NkNode = { tag: "div", children: [] };
  cyclic.children?.push(cyclic);
  let thrown: unknown;
  try {
    nkTreeToHtml(cyclic);
  } catch (e) {
    thrown = e;
  }
  expect((thrown as Error).message).toMatch(/nesting exceeds the 64-level limit/);
  expect((thrown as Error).message).not.toMatch(/call stack/);
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

// ── review round 3 — an inherited index is not a child ───────────────────────────────────────────

function withPoisonedArrayPrototype<T>(value: unknown, body: () => T): T {
  const proto = Array.prototype as unknown as Record<number, unknown>;
  proto[0] = value;
  try {
    return body();
  } finally {
    delete proto[0];
  }
}

test("a hole in `children` is a sparse-array error even when the inherited index is NODE-shaped", () => {
  // `i in children` reported the hole present, and a node-shaped `Array.prototype[0]` was then
  // SERIALIZED — markup emitted from a value the tree never carried. A string pollutant happened to
  // throw ("expected an object"), which hid the leak behind the right error for the wrong reason.
  const poison = { tag: "div", class: "nk-x", text: "POISONED" };
  expect(() =>
    withPoisonedArrayPrototype(poison, () =>
      nkTreeToHtml({ tag: "div", class: "nk-card", children: new Array(1) } as unknown as NkNode),
    ),
  ).toThrow(/root\.children\[0\]: missing — children must be dense/);
});

test("a dense tree serializes identically under a poisoned prototype", () => {
  const tree = cardTree(CANONICAL);
  const poisoned = withPoisonedArrayPrototype({ tag: "div", text: "POISONED" }, () =>
    nkTreeToHtml(tree),
  );
  expect(poisoned).toBe(nkTreeToHtml(tree));
  expect(poisoned).not.toContain("POISONED");
});
