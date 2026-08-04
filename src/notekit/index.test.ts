// The `"./notekit"` barrel (Story 1.4 Task 1, AC #1/#2).
//
// The load-bearing test here is NOT "the names resolve" — it is ⚠️-1: this barrel's module graph must
// contain ZERO files under `edge/`. The ultimate proof is `bun run typecheck` staying green over the
// ROOT config with this file present (the root program has no DOM lib, so one edge import fails it with
// TS2304), and that is a CI gate, not something a `bun test` can observe. So the suite asserts the same
// property STRUCTURALLY — by walking the real import graph on disk — which is what turns "the root
// typecheck happened to be green" into "the graph cannot reach the DOM half".

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { specifiers, stripStringsAndComments } from "../../scripts/lib/specifiers";

import {
  NK_MAX_DEPTH,
  NK_TAGS,
  cardTree,
  nkTreeToHtml,
  noteToRenderSpec,
  parseFenceBody,
  renderCardHtml,
  resolveTemplate,
  serializeFenceBody,
  validate,
} from "./index";
import type {
  FenceFields,
  Injected,
  NkNode,
  NoteTypeRegistry,
  NoteTypeTemplate,
  NotekitConfig,
  RenderSpec,
  Rubric,
} from "./index";

const HERE = import.meta.dir;

/**
 * Resolve one `from "…"` specifier to a real file on disk, or null when it is not a relative
 * intra-repo import. Only relative specifiers can reach `edge/`; a bare specifier (`bun:test`) cannot.
 */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && candidate.endsWith(".ts")) return candidate;
  }
  return null;
}

/**
 * Blank out comments (and string/regex interiors) so a source scan sees code only.
 *
 * ⚠ LINE COMMENTS FIRST, AND THE ORDER IS THE WHOLE POINT. A masker that strips block comments first
 * is catastrophic on THESE files: the headers explain ⚠️-1 by quoting the forbidden path `edge/**`,
 * whose `/*` opens a block comment the stripper then closes at the next real `*\/` — the JSDoc far
 * below — swallowing every `export … from` statement in between. Measured: the specifier scan found
 * ZERO imports and the assertion passed for entirely the wrong reason.
 *
 * ⚠ AND THE FIX FOR THAT WAS ITSELF ERASIVE. Killing whole `//` LINES removes the prose, but it also
 * removes `import { x } from "./y"; // note` — a real edge, gone, with every assertion below still
 * green. Under-reporting the graph is the ONE failure mode this file cannot survive, because ⚠️-1 is a
 * ZERO-edge claim: a scan that sees nothing proves nothing and looks identical to a scan that sees
 * everything. So this now delegates to the estate's shared masker, which blanks comment/string/regex
 * INTERIORS to spaces and preserves every other byte — non-erasive by construction.
 */
function maskComments(src: string): string {
  return stripStringsAndComments(src);
}

/**
 * Every intra-repo `.ts` file reachable from `entry` through a module edge — `import … from`,
 * `export … from`, AND the bare side-effect `import "./x"`.
 *
 * ⚠ THE SIDE-EFFECT FORM IS NOT OPTIONAL HERE. `import "./edge/index"` binds no name, so a scan
 * written around `from` clauses cannot see it — and it is a perfectly good way to drag the DOM half
 * into this barrel's graph while the zero-edge assertion below stays green. One resolver, every form,
 * via `specifiers()`; the regression is at the bottom of this file.
 */
function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { spec } of specifiers(maskComments(readFileSync(file, "utf-8")))) {
      const next = resolveSpecifier(file, spec);
      if (next !== null) queue.push(next);
    }
  }
  return [...seen];
}

describe("⚠️-1 — the barrel's import graph never reaches the DOM half", () => {
  const graph = importGraph(join(HERE, "index.ts"));

  test("the walk is not vacuous — it really followed the re-export edges", () => {
    // A resolver that silently returned null for everything would make every assertion below pass on an
    // empty graph. Pin that it found the pure files the barrel re-exports from.
    const names = graph.map((f) => relative(HERE, f));
    expect(names).toContain("index.ts");
    for (const core of [
      "core-fence.ts",
      "core-renderspec.ts",
      "core-nknode.ts",
      "core-html.ts",
      "core-registry.ts",
    ]) {
      expect(names).toContain(core);
    }
    expect(graph.length).toBeGreaterThan(5); // …and `core-renderspec` pulled `../core` in too
  });

  test("ZERO files under src/notekit/edge/ are reachable", () => {
    const edgeFiles = graph.filter((f) => f.includes(`${join("notekit", "edge")}`));
    expect(edgeFiles).toEqual([]);
  });

  test("…and the files that ARE reachable use no DOM global in source", () => {
    // The graph check above is about REACHABILITY; this is about the payload. A pure file that grew a
    // `document` reference would fail the root typecheck too, but only after someone ran it — here the
    // claim is stated where the barrel's contract is stated.
    for (const file of graph) {
      const src = maskComments(readFileSync(file, "utf-8"));
      expect({ file: relative(HERE, file), hit: /\bdocument\s*\./.test(src) }).toEqual({
        file: relative(HERE, file),
        hit: false,
      });
      expect({ file: relative(HERE, file), hit: /\bHTMLElement\b/.test(src) }).toEqual({
        file: relative(HERE, file),
        hit: false,
      });
    }
  });

  test("the barrel's own source names `edge` only in prose, never in a specifier", () => {
    // Comments are masked first, exactly as every source scan in this repo does: the file's header
    // QUOTES the forbidden `export … from "./edge/…"` in order to forbid it, and a scan that could not
    // tell documentation from a dependency would fail on the sentence explaining the rule.
    const src = maskComments(readFileSync(join(HERE, "index.ts"), "utf-8"));
    const specs = [...src.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(specs.length).toBeGreaterThan(0); // the mask did not eat the real imports
    for (const spec of specs) expect(spec).not.toContain("edge");
  });
});

// ---------------------------------------------------------------------------------------------
// THE ZERO-EDGE PROOF, PROVEN NON-VACUOUS.
//
// "ZERO files under edge/ are reachable" is the strongest-sounding and weakest-failing kind of
// assertion: it passes on an empty graph, on a broken resolver, and on a scan blind to whichever
// import form the violation happens to use. The vacuity check above covers the first two. This covers
// the third — the scan is shown to CATCH a planted violation, in the exact form it used to miss.
//
// If this ever goes green with the walker's side-effect handling removed, the ⚠️-1 proof is back to
// being decorative.
// ---------------------------------------------------------------------------------------------
describe("⚠️-1's zero-edge proof would actually go red (planted-violation regression)", () => {
  /** The scan as it shipped in the first cut: `from` clauses only, side-effect imports invisible. */
  function legacyGraph(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [resolve(entry)];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = readFileSync(file, "utf-8")
        .replace(/^[^\n]*?\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of src.matchAll(/^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)) {
        const next = resolveSpecifier(file, m[1]!);
        if (next !== null) queue.push(next);
      }
    }
    return [...seen];
  }

  /** A miniature notekit: a barrel, a pure file, and an `edge/` the barrel must never reach. */
  function plantBarrel(body: string): { dir: string; barrel: string; edge: string } {
    const dir = mkdtempSync(join(tmpdir(), "std-nk-barrel-"));
    mkdirSync(join(dir, "edge"), { recursive: true });
    writeFileSync(join(dir, "core-pure.ts"), "export const pure = 1;\n");
    writeFileSync(join(dir, "edge", "index.ts"), "export const dom = () => document.body;\n");
    writeFileSync(join(dir, "index.ts"), body);
    return { dir, barrel: join(dir, "index.ts"), edge: join(dir, "edge", "index.ts") };
  }

  const planted: string[] = [];
  const plant = (body: string) => {
    const p = plantBarrel(body);
    planted.push(p.dir);
    return p;
  };
  afterAll(() => {
    for (const d of planted) rmSync(d, { recursive: true, force: true });
  });

  test("a SIDE-EFFECT import of the edge is caught — the form the first cut could not see", () => {
    const { barrel, edge } = plant('export { pure } from "./core-pure";\nimport "./edge/index";\n');
    expect(importGraph(barrel)).toContain(edge); // ⚠️-1's `edgeFiles).toEqual([])` would now FAIL
    expect(legacyGraph(barrel)).not.toContain(edge); // …and used to pass, with the violation present
  });

  test("an edge import hidden behind a trailing `//` comment is caught too", () => {
    const { barrel, edge } = plant(
      'export { dom } from "./edge/index"; // the DOM half, smuggled past a line-erasing masker\n',
    );
    expect(importGraph(barrel)).toContain(edge);
    expect(legacyGraph(barrel)).not.toContain(edge);
  });

  test("the control: a clean barrel still reports zero edge files under BOTH scans", () => {
    // Without this, the two cases above would also pass on a scan that flagged everything.
    const { barrel, edge } = plant('export { pure } from "./core-pure";\n');
    expect(importGraph(barrel)).not.toContain(edge);
    expect(legacyGraph(barrel)).not.toContain(edge);
  });
});

describe("the re-exported surface resolves AND works", () => {
  test("every value export is the live function, not an undefined name", () => {
    for (const [name, value] of Object.entries({
      parseFenceBody,
      serializeFenceBody,
      noteToRenderSpec,
      validate,
      cardTree,
      nkTreeToHtml,
      renderCardHtml,
      resolveTemplate,
    })) {
      expect({ name, type: typeof value }).toEqual({ name, type: "function" });
    }
    expect(NK_TAGS.size).toBeGreaterThan(0);
    expect(NK_MAX_DEPTH).toBeGreaterThan(0);
  });

  // A name-only check would pass on a barrel that re-exported the wrong symbols. Drive the whole pure
  // pipeline the way a consumer would — fence text in, HTML out.
  test("fence text → RenderSpec → HTML, end to end through the barrel alone", () => {
    const rubric: Rubric = {
      kind: "card",
      titleField: "title",
      fields: [{ key: "summary" }, { key: "tags", label: "Tags" }],
    };
    const injected: Injected = { id: "nk-test", generatedAt: "1970-01-01T00:00:00.000Z" };
    const fields: FenceFields = parseFenceBody("title: A card\nsummary: one line\ntags: a, b\n");
    const result = validate(noteToRenderSpec(fields, rubric, injected));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    const spec: RenderSpec = result.value;
    expect(spec.title).toBe("A card");
    const html = renderCardHtml(spec);
    expect(html).toContain("nk-card");
    expect(html).toContain("one line");

    const tree: NkNode = cardTree(spec);
    expect(nkTreeToHtml(tree)).toBe(html); // the two projections agree — one tree, one owner

    // …and the codec round-trips, so `serializeFenceBody` is the real inverse, not a stub.
    expect(parseFenceBody(serializeFenceBody(fields))).toEqual(fields);
  });

  test("resolveTemplate walks the registry the config type describes", () => {
    const registry: NoteTypeRegistry = {
      noteTypes: { card: "catalog-card" },
      templates: {
        "catalog-card": {
          renderer: "nk-card",
          rubric: { kind: "card", titleField: "title", fields: [{ key: "summary" }] },
        },
      },
    };
    const template: NoteTypeTemplate | null = resolveTemplate("card", registry);
    expect(template?.renderer).toBe("nk-card");
    expect(resolveTemplate("nope", registry)).toBeNull();
    // The own-property contract Story 1.3 shipped survives the re-export (a bare index read would
    // resolve `constructor` through the prototype chain).
    expect(resolveTemplate("constructor", registry)).toBeNull();
  });
});

describe("NotekitConfig is an ALIAS of NoteTypeRegistry, never a parallel type (NK-1.2)", () => {
  // Assignability in BOTH directions is what makes this an alias assertion rather than a structural
  // one: a hand-restated `type NotekitConfig = { noteTypes: …; templates: … }` would satisfy one
  // direction while quietly diverging the day either side gained a field. `tsc` is the real oracle
  // here — these lines are compile-time claims that happen to also run.
  test("the two names denote one type", () => {
    const registry: NoteTypeRegistry = {
      noteTypes: { card: "catalog-card" },
      templates: {
        "catalog-card": {
          renderer: "nk-card",
          rubric: { kind: "card", titleField: "title", fields: [] },
        },
      },
    };
    const asConfig: NotekitConfig = registry;
    const backAgain: NoteTypeRegistry = asConfig;
    expect(backAgain).toBe(registry);
  });

  // The shape a vault's hand-authored `notekit.config.ts` actually writes — `satisfies`, so an unknown
  // key or a wrong renderer type is a compile error at the config, which is the whole point of FR14.
  test("a caller-local config compiles under `satisfies NotekitConfig`", () => {
    const config = {
      noteTypes: { card: "catalog-card" },
      templates: {
        "catalog-card": {
          renderer: "nk-card",
          rubric: {
            kind: "card",
            titleField: "title",
            fields: [{ key: "summary", label: "Summary" }],
          },
        },
      },
    } satisfies NotekitConfig;

    expect(resolveTemplate("card", config)?.rubric.titleField).toBe("title");
  });
});
