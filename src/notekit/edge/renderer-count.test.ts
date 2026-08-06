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
    const found = new Set<string>();
    for (const file of sliceSources()) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/function ([A-Za-z0-9_]+)\([^)]*\)\s*:\s*HTMLElement/g)) {
        found.add(m[1]!);
      }
    }
    expect([...found].sort()).toEqual(["build", "nkTreeToDom", "noticeElement", "renderCardDom"]);
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
