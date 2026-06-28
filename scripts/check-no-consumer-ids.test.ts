import { test, expect } from "bun:test";
import { scanConsumerIds } from "./check-no-consumer-ids";

test("scanConsumerIds flags an owner/repo slug naming a consumer", () => {
  const hits = scanConsumerIds(`const repo = "pedroibl/loom";`);
  expect(hits.some((h) => h.identifier === "pedroibl/loom")).toBe(true);
});

test("scanConsumerIds flags a bare consumer name used as a branch literal", () => {
  const hits = scanConsumerIds(`if (slug === "loom") doThing();`);
  expect(hits.some((h) => h.identifier === "loom")).toBe(true);
});

test("scanConsumerIds flags an absolute filesystem path into a consumer tree", () => {
  const hits = scanConsumerIds(`const p = "/Users/x/Dev/loom";`);
  expect(hits.some((h) => h.identifier === "/Users/x/Dev/loom")).toBe(true);
});

test("scanConsumerIds flags a ~-rooted path into a consumer tree", () => {
  const hits = scanConsumerIds(`const p = "~/Dev/sesh-harvest";`);
  expect(hits.some((h) => h.identifier === "~/Dev/sesh-harvest")).toBe(true);
});

test("scanConsumerIds does NOT flag std's own identity", () => {
  expect(scanConsumerIds(`const repo = "pedroibl/std";`)).toEqual([]);
  expect(scanConsumerIds(`import { run } from "std/glab";`)).toEqual([]);
  expect(scanConsumerIds(`export * from "std/core";`)).toEqual([]);
});

test("scanConsumerIds does NOT flag a consumer name inside a comment (masked)", () => {
  expect(scanConsumerIds(`// fixes the pedroibl/loom default`)).toEqual([]);
  expect(scanConsumerIds(`/* old default was pedroibl/loom */\nexport const x = 1;`)).toEqual([]);
});

test("scanConsumerIds does NOT flag the STD_CONSUMERS registry mechanism / env reads", () => {
  expect(scanConsumerIds(`const e = process.env.STD_CONSUMERS;`)).toEqual([]);
  expect(scanConsumerIds(`const f = "scripts/std.consumers.local";`)).toEqual([]);
});

test("scanConsumerIds is segment-aware: bloomfilter / heirloom / loomis do NOT match", () => {
  expect(scanConsumerIds(`import { B } from "bloomfilter";`)).toEqual([]);
  expect(scanConsumerIds(`const a = "heirloom"; const b = "loomis";`)).toEqual([]);
});

test("scanConsumerIds reports the offending line", () => {
  const hit = scanConsumerIds(`const a = 1;\nconst r = "pedroibl/loom";`).find(
    (h) => h.identifier === "pedroibl/loom",
  )!;
  expect(hit.line).toBe(2);
  expect(hit.detail).toContain("loom");
});

test("scanConsumerIds: a custom names set is honoured (runtime-enrichment shape)", () => {
  const hits = scanConsumerIds(`const r = "pedroibl/widget";`, new Set(["widget"]));
  expect(hits.some((h) => h.identifier === "pedroibl/widget")).toBe(true);
});

test("current tree: globbing real src/** yields zero consumer-identifier hits (AC2 vacuous-green)", async () => {
  const glob = new Bun.Glob("src/**/*.ts");
  const findings: string[] = [];
  for await (const file of glob.scan(".")) {
    if (file.endsWith(".test.ts")) continue;
    const src = await Bun.file(file).text();
    for (const hit of scanConsumerIds(src)) findings.push(`${file}:${hit.line}  ${hit.identifier}`);
  }
  expect(findings).toEqual([]);
});
