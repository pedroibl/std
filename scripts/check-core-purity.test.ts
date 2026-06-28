import { test, expect } from "bun:test";
import { scanSource } from "./check-core-purity";

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
