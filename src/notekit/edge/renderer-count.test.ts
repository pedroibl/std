// Story 2.6 — the SM-C1 renderer scan. Three configurations of ONE renderer, asserted mechanically.
//
// WHAT A RENDERER IS, because "exactly one renderer" is unfalsifiable until the word is defined:
// A RENDERER IS A VALUE BOUND TO AN OWN KEY OF `RENDERERS` IN `./dispatch.ts` — the file's own header
// calls that table "the one place a renderer ID becomes a function", and `rendererFor` is its sole
// reader. Nothing else is a renderer, however it is named.
//
// The definition matters because a dev who greps for "render" counts FOUR and writes a gate that is
// permanently red. Both decoy populations are exactly four and both resolve the same way:
//
//   /render/i-NAMED function defs, src/notekit/** non-test = 4
//     noteToRenderSpec  core-renderspec.ts   NO — pure fields → RenderSpec; returns data, no DOM
//     renderCardHtml    core-html.ts         NO — the headless HTML serializer; returns string
//     renderCardDom     edge/nkcard.ts       YES — the sole value in RENDERERS
//     rendererFor       edge/dispatch.ts     NO — the resolver; returns Renderer | null
//
//   HTMLElement-RETURNING function defs, src/notekit/** non-test = 4
//     build             edge/nkcard.ts          NO — module-private NkNode walker
//     nkTreeToDom       edge/nkcard.ts          NO — NkNode → DOM serializer
//     renderCardDom     edge/nkcard.ts          YES
//     noticeElement     edge/post-processor.ts  NO — builds the FR-4 degrade notice
//
// A ∩ B = {renderCardDom}. One renderer, arrived at two independent ways.
//
// ⚠ THIS FILE NECESSARILY CONTAINS EVERY ONE OF THOSE NAMES AS ITS OWN EXPECTED SET, so it scans the
// OTHER files and never itself. A self-scan would be permanently red; hiding the list behind an
// indirection to dodge that would make it permanently green. Both vacuous — the exclusion is stated
// rather than engineered around, the same call 2.1, 2.3 and 2.4 each made.
//
// ⚠ NOT NAMED `core-*`: `check-core-purity.ts` globs `src/notekit/core-*.ts`, and assertion (b) reads
// the filesystem. ⚠ NOT RENAMED OFF `.test.ts`: 2.2's sole-writer scan globs `src/notekit/**/*.ts`
// minus `*.test.ts`. ⚠ NOT a seventh `check:*` script: the estate's gate template is for repo-wide
// invariants, and "this table has one key" is file-scoped. `bun test` is already the merge bar.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { stripStringsAndComments } from "../../../scripts/lib/specifiers";

import { RENDERERS } from "./dispatch";

// This file sits in `src/notekit/edge/`, so the slice root is one level up and the repo root three.
// Resolved from `import.meta.dir` and never from cwd — `bun test` inherits whatever directory launched
// it. The `package.json` probe turns a wrong depth into a clear message instead of an empty scan.
const HERE = import.meta.dir;
const SLICE = join(HERE, "..");
const REPO = join(HERE, "..", "..", "..");

/** Every non-test `.ts` under the notekit slice EXCEPT this file — see the header on self-scanning. */
function sliceSources(): string[] {
  return readdirSync(SLICE, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(SLICE, f));
}

describe("SM-C1 — src/notekit ships exactly one renderer", () => {
  test("the depth is right before anything is scanned", () => {
    expect(existsSync(join(REPO, "package.json"))).toBe(true);
    expect(existsSync(join(SLICE, "core-renderspec.ts"))).toBe(true);
  });

  test("(a) the RENDERERS table has exactly one own key, and it is `nk-card`", () => {
    // The direct SM-C1 breach: a second key here is a second renderer, whatever it is called.
    expect(Object.keys(RENDERERS).sort()).toEqual(["nk-card"]);
  });

  test("(b) no HTMLElement-returning function exists outside the four known symbols", () => {
    // WHY THIS EXISTS ALONGSIDE (a): (a) is green for any renderer nobody bothered to register. This
    // one sees a renderer smuggled into the edge WITHOUT a table entry — which is exactly how a second
    // renderer actually arrives.
    //
    // ⚠ A SET, NOT A COUNT. A count stays green if someone deletes `noticeElement` and adds a renderer.
    // When a legitimate fifth DOM helper is added later, the story that adds it extends this set with a
    // reason — that friction is the feature, not an obstacle to route around.
    //
    // 🔴 THIS ASSERTION HAS BEEN WRONG TWICE, AND BOTH TIMES BY BEING BLIND TO A SPELLING RATHER
    // THAN TO AN IDEA. It began matching only `function name(…): HTMLElement`; an arrow const walked
    // straight past it. Widened to two forms, `: HTMLDivElement` — a subtype, perfectly registrable —
    // walked past that. A cross-vendor review then planted five more and FOUR STAYED GREEN, the worst
    // being `export const x: Renderer = (spec) => …`, which is the most idiomatic way to write a
    // renderer in this codebase and never spells an element type at the return site at all.
    //
    // The lesson is not "add another pattern". It is that a scan keyed on ONE syntactic signal is
    // green for every spelling its author failed to imagine. So this asserts THREE INDEPENDENT
    // SIGNALS, and a smuggled renderer has to defeat all three:
    //
    //   1. NAMED — the symbol names behind element-returning and `Renderer`-typed declarations.
    //   2. RECONCILED — every element/`Renderer` type signal in the slice is accounted for by a name
    //      this scan could resolve, so an unanticipated form fails LOUDLY as an unreconciled signal
    //      rather than passing silently.
    //   3. DOM BUDGET — the `document.createElement` call sites, pinned. This one reads no types at
    //      all: a DOM factory has to MAKE an element whatever its annotation claims, so an inferred
    //      return, a type alias and a `Renderer`-typed binding all redden here. A type can be spelled
    //      a dozen ways; creating an element cannot be faked.
    //
    // ⚠ SCANNED OVER MASKED SOURCE. `stripStringsAndComments` is the estate's own masker, already
    // imported this way by `index.test.ts`. Without it a comment or doc string containing
    // `): HTMLElement` reddens the reconciliation with no new function in existence — a FALSE RED,
    // which is how a gate earns a reputation for noise and gets deleted.
    const EL = String.raw`HTML\w*Element`;
    const NAMED_FORMS = [
      // `function name(…): HTMLElement` / `: Promise<HTMLElement>`, generics and methods included.
      new RegExp(
        String.raw`function ([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*:\s*(?:Promise<\s*)?${EL}`,
        "g",
      ),
      // `const name = (…): HTMLElement => …`
      new RegExp(
        String.raw`(?:const|let|var)\s+([A-Za-z0-9_]+)[^=\n]*=\s*(?:async\s*)?\([^)]*\)\s*:\s*(?:Promise<\s*)?${EL}`,
        "g",
      ),
      // `const name: Renderer = …` and `const name = (…) as Renderer` — typed at the BINDING, where
      // a second renderer would most naturally be written in this codebase.
      /(?:const|let|var)\s+([A-Za-z0-9_]+)\s*:\s*Renderer\b/g,
      /(?:const|let|var)\s+([A-Za-z0-9_]+)[^=\n]*=[\s\S]{0,200}?\bas\s+Renderer\b/g,
    ];

    const found = new Set<string>();
    let signals = 0;
    let domSites = 0;
    for (const file of sliceSources()) {
      const src = stripStringsAndComments(readFileSync(file, "utf8"));
      // Return position only: `): HTML*Element`. A parameter or field typed with an element
      // (`container: HTMLElement`) is not a function returning one. Plus the two binding-position
      // `Renderer` spellings, which carry no element token at all.
      signals += (src.match(new RegExp(String.raw`\)\s*:\s*(?:Promise<\s*)?${EL}`, "g")) ?? []).length;
      signals += (src.match(/:\s*Renderer\b|\bas\s+Renderer\b/g) ?? []).length;
      domSites += (src.match(/document\s*\.\s*createElement\s*\(/g) ?? []).length;
      for (const re of NAMED_FORMS) for (const m of src.matchAll(re)) found.add(m[1]!);
    }

    expect([...found].sort()).toEqual(["build", "nkTreeToDom", "noticeElement", "renderCardDom"]);

    // ⚠ `RENDERERS`' own table annotation and `rendererFor`'s `Renderer | null` return are two
    // legitimate `Renderer` mentions naming no new factory, so they are carried as a NAMED constant
    // rather than fudging the arithmetic. A third mention is a finding, not a rounding error.
    const SANCTIONED_RENDERER_MENTIONS = 2; // dispatch.ts: the table's type + rendererFor's return
    expect(signals).toBe(found.size + SANCTIONED_RENDERER_MENTIONS);

    // 🔴 THE TYPE-FREE SIGNAL, and the one that closes the forms types cannot. Three
    // `document.createElement` sites ship today: `nkcard.ts`'s element builder and its `<style>`
    // injector, and `post-processor.ts`'s degrade notice. A new DOM factory must add a fourth, and
    // no annotation trick avoids it. A legitimate fourth site is a story that raises this with a reason.
    expect(domSites).toBe(3);
  });

  test("(c) `Rubric.kind` and `RenderSpec.kind` are both the unwidened literal `\"card\"`", () => {
    // ⚠ ANCHORED, NEVER COUNTED. `kind: "card"` appears THREE times in core-renderspec.ts — the two
    // type declarations below plus a value literal in `validate`'s rebuilt spec. A gate asserting
    // "exactly one such line" is red on correct code; one asserting "at least one" is green after a
    // widening. Both vacuous. So each declaration is located by its own header and read.
    //
    // BOTH halves are asserted because a second `kind` must break both: `noteToRenderSpec` returns
    // `kind: rubric.kind` into a `RenderSpec`, so widening `Rubric` alone is itself a compile error.
    // Locating by header rather than by line number, because line numbers shift with any edit above.
    const src = readFileSync(join(SLICE, "core-renderspec.ts"), "utf8");

    for (const decl of ["export type Rubric = {", "export type RenderSpec = {"]) {
      const start = src.indexOf(decl);
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf("\n};", start));
      const kindLine = body.split("\n").find((l) => l.trim().startsWith("kind:"));
      expect(kindLine?.trim()).toBe('kind: "card";');
      expect(kindLine).not.toContain("|");
    }
  });
});
