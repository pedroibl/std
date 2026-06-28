import { test, expect } from "bun:test";
import { specifiers, stripStringsAndComments, stripComments, lineOf } from "./specifiers";

const specs = (src: string) => specifiers(stripStringsAndComments(src)).map((s) => s.spec);

test("specifiers() captures the static import forms", () => {
  expect(specs(`import { x } from "./a";`)).toEqual(["./a"]);
  expect(specs(`import "./side-effect";`)).toContain("./side-effect");
  expect(specs(`const fs = require("node:fs");`)).toEqual(["node:fs"]);
});

test("specifiers() captures dynamic import and export-from edges", () => {
  expect(specs(`const m = await import("./lazy");`)).toEqual(["./lazy"]);
  expect(specs(`export { y } from "./b";`)).toEqual(["./b"]);
  expect(specs(`export * from "./c";`)).toEqual(["./c"]);
  expect(specs(`export type { T } from "./t";`)).toEqual(["./t"]);
});

test("stripStringsAndComments blanks comment-borne specifiers", () => {
  expect(specs(`// import x from "node:fs"\nexport const a = 1;`)).toEqual([]);
  expect(specs(`/* import y from "loom" */\nexport const b = 2;`)).toEqual([]);
});

test("string-aware: a `from '…'` inside a string literal is NOT a specifier (closes the false positive)", () => {
  // The tracked limitation: `"select x from 'loom'"` used to false-flag as an edge to loom.
  expect(specs(`const q = "select x from 'loom'";`)).toEqual([]);
  expect(specs(`const sql = \`SELECT * FROM 'orders' import 'x'\`;`)).toEqual([]);
  // …while a genuine import on the same shape is still captured.
  expect(specs(`import x from "loom";`)).toEqual(["loom"]);
});

test("stripStringsAndComments preserves the module-specifier string but masks other strings", () => {
  const clean = stripStringsAndComments(`const label = "from here"; import x from "./real";`);
  // The non-specifier string content is gone…
  expect(clean).not.toContain("from here");
  // …but the specifier survives for the regexes.
  expect(specifiers(clean).map((s) => s.spec)).toEqual(["./real"]);
});

test("stripStringsAndComments is not fooled by a regex literal containing quotes", () => {
  // A regex like /['"]/ must not flip the scanner into string state and swallow the next import.
  const src = `const RE = /['"]/;\nimport x from "loom";`;
  expect(specs(src)).toEqual(["loom"]);
});

test("stripStringsAndComments preserves newlines so lineOf stays accurate", () => {
  const src = `/*\n long\n banner\n*/\nimport x from "loom";`;
  const clean = stripStringsAndComments(src);
  const hit = specifiers(clean).find((s) => s.spec === "loom")!;
  expect(lineOf(clean, hit.index)).toBe(5);
});

test("stripComments still strips comments while leaving strings intact (back-compat export)", () => {
  expect(stripComments(`// gone\nconst s = "kept";`)).toContain('"kept"');
  expect(stripComments(`// gone\nconst s = "kept";`)).not.toContain("gone");
});
