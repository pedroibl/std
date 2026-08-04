import { test, expect } from "bun:test";
import { coversFile, emptyGlobs, PURE_GLOBS, scanScope, scanSource } from "./check-core-purity";

test("flags node: imports", () => {
  const v = scanSource(`import { readFile } from "node:fs";`);
  expect(v.some((x) => x.kind === "node-import" && x.detail === "node:fs")).toBe(true);
});

test("flags bare node-builtin imports", () => {
  const v = scanSource(`import { join } from "path";`);
  expect(v.some((x) => x.kind === "node-builtin-import" && x.detail === "path")).toBe(true);
});

test("flags a forbidden DOM library import", () => {
  const v = scanSource(`import { JSDOM } from "jsdom";`);
  expect(v.some((x) => x.kind === "forbidden-import" && x.detail === "jsdom")).toBe(true);
});

test("flags process and document references", () => {
  const v = scanSource(`export const c = process.env.X;\nconst d = document.body;`);
  expect(v.some((x) => x.detail === "process")).toBe(true);
  expect(v.some((x) => x.detail === "document")).toBe(true);
});

test("flags require() of a builtin", () => {
  const v = scanSource(`const fs = require("fs");`);
  expect(v.some((x) => x.detail === "fs")).toBe(true);
});

test("flags a dynamic import of a node: module", () => {
  const v = scanSource(`const fs = await import("node:fs");`);
  expect(v.some((x) => x.kind === "node-import" && x.detail === "node:fs")).toBe(true);
});

test("flags a builtin subpath import (fs/promises)", () => {
  const v = scanSource(`import { readFile } from "fs/promises";`);
  expect(v.some((x) => x.kind === "node-builtin-import" && x.detail === "fs/promises")).toBe(true);
});

test("flags the fetch network global", () => {
  const v = scanSource(`export const get = (u: string) => fetch(u);`);
  expect(v.some((x) => x.kind === "global-ref" && x.detail === "fetch")).toBe(true);
});

test("flags XMLHttpRequest and WebSocket network globals", () => {
  expect(scanSource(`const x = new XMLHttpRequest();`).some((v) => v.detail === "XMLHttpRequest")).toBe(true);
  expect(scanSource(`const s = new WebSocket("wss://x");`).some((v) => v.detail === "WebSocket")).toBe(true);
});

test("reports the original line after a multi-line block comment", () => {
  const src = `/*\n long\n banner\n*/\nexport const c = process.env.X;`;
  const v = scanSource(src);
  expect(v.some((x) => x.detail === "process" && x.line === 5)).toBe(true);
});

test("does NOT false-positive on member access or property keys named like a global", () => {
  // `client.fetch()` is a method call, `{ fetch: … }` a property key — neither reads the global.
  expect(scanSource(`export const r = client.fetch(u);`).some((v) => v.detail === "fetch")).toBe(false);
  expect(scanSource(`export const o = { fetch: handler };`).some((v) => v.detail === "fetch")).toBe(false);
  expect(scanSource(`export const a = obj.process;`).some((v) => v.detail === "process")).toBe(false);
});

test("passes pure code", () => {
  const src = [
    `export const cite = (p: string) => "\`" + p + "\`";`,
    `export type Severity = "ok" | "error" | "warn" | "info";`,
    `import { other } from "./other";`,
  ].join("\n");
  expect(scanSource(src)).toEqual([]);
});

test("ignores commented-out violations", () => {
  const src = `// import x from "node:fs"\n/* process.env.HOME */\nexport const x = 1;`;
  expect(scanSource(src)).toEqual([]);
});

// SCOPE (Story 1.1): the gate must actually see notekit's pure half. A glob that matched no notekit
// file would let this gate pass vacuously — green for a slice it never read.
test("the scan scope covers src/core and notekit's core-* files", () => {
  expect(coversFile("src/core/parse.ts")).toBe(true);
  expect(coversFile("src/core/nested/deep.ts")).toBe(true);
  expect(coversFile("src/notekit/core-fence.ts")).toBe(true);
  expect(coversFile("src/notekit/core-renderspec.ts")).toBe(true);
});

test("the scan scope excludes the notekit edge, non-core notekit files, and tests", () => {
  // the edge builds DOM with `document` — covering it would be a false failure (AD-6)
  expect(coversFile("src/notekit/edge/card.ts")).toBe(false);
  expect(coversFile("src/notekit/edge/core-dispatch.ts")).toBe(false);
  // the `core-` filename prefix is the fence: a non-prefixed notekit file is not pure surface
  expect(coversFile("src/notekit/config.ts")).toBe(false);
  // tests are not shipped; they may import bun:test
  expect(coversFile("src/core/parse.test.ts")).toBe(false);
  expect(coversFile("src/notekit/core-fence.test.ts")).toBe(false);
  // other slices are Bun/Obsidian edges — never in scope
  expect(coversFile("src/fsx/index.ts")).toBe(false);
  expect(coversFile("src/dashkit/index.ts")).toBe(false);
});

test("PURE_GLOBS names both pure trees", () => {
  expect([...PURE_GLOBS]).toEqual(["src/core/**/*.ts", "src/notekit/core-*.ts"]);
});

// NON-VACUITY (review follow-up, CodeRabbit #77). The assertions above pass hard-coded strings to
// `coversFile`, and `Glob.match` only evaluates the string it is handed — it never establishes that
// the pattern reaches a file that EXISTS. A typo in PURE_GLOBS would leave every test above green
// while the gate read nothing. These two hit the real filesystem instead.

const REPO_ROOT = `${import.meta.dir}/..`;

test("every PURE_GLOBS entry matches at least one real file on disk", async () => {
  const scans = await scanScope(REPO_ROOT);
  expect(scans.map((s) => s.pattern)).toEqual([...PURE_GLOBS]);
  for (const { pattern, files } of scans) {
    expect({ pattern, matched: files.length > 0 }).toEqual({ pattern, matched: true });
  }
  // and the files found really are the pure trees, not incidental matches
  const all = scans.flatMap((s) => s.files);
  expect(all).toContain("src/core/result.ts");
  expect(all).toContain("src/notekit/core-fence.ts");
  expect(all).toContain("src/notekit/core-renderspec.ts");
  expect(all.every((f) => coversFile(f))).toBe(true);
});

test("the zero-match guard names every glob that found nothing", () => {
  expect(emptyGlobs([{ pattern: "src/core/**/*.ts", files: ["src/core/result.ts"] }])).toEqual([]);
  // a typo'd pattern scans zero files — the gate must go red, not print a clean result
  expect(
    emptyGlobs([
      { pattern: "src/core/**/*.ts", files: ["src/core/result.ts"] },
      { pattern: "src/notekit/core*-.ts", files: [] },
    ]),
  ).toEqual(["src/notekit/core*-.ts"]);
  expect(emptyGlobs([]).length).toBe(0);
});

test("a typo'd glob really does find zero files (the guard's premise)", async () => {
  const scans = await scanScope(REPO_ROOT);
  const typo = "src/notekit/core*-.ts"; // the `*` and `-` transposed
  expect([...PURE_GLOBS]).not.toContain(typo);
  const matched: string[] = [];
  for await (const file of new Bun.Glob(typo).scan(REPO_ROOT)) matched.push(file);
  expect(matched).toEqual([]);
  // …whereas the real pattern it was typo'd from does find files
  expect(scans.find((s) => s.pattern === "src/notekit/core-*.ts")!.files.length).toBeGreaterThan(0);
});
