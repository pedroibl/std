import { test, expect } from "bun:test";
import { scanDefinitions, resolveConsumers, scanConsumerTrees, type Consumer } from "./check-single-source";

test("scanDefinitions flags top-level definitions of tracked symbols", () => {
  expect(scanDefinitions(`export const cite = (p: string) => p;`).some((h) => h.symbol === "cite")).toBe(true);
  expect(scanDefinitions(`function cite(p) { return p; }`).some((h) => h.symbol === "cite")).toBe(true);
  expect(scanDefinitions(`type Counts = { ok: number };`).some((h) => h.symbol === "Counts")).toBe(true);
  expect(scanDefinitions(`const stat = 1;`).some((h) => h.symbol === "stat")).toBe(true);
  expect(scanDefinitions(`type Severity = "ok" | "error";`).some((h) => h.symbol === "Severity")).toBe(true);
});

test("scanDefinitions does NOT flag imports, re-export edges, comments, or strings", () => {
  expect(scanDefinitions(`import { cite } from "std/core";`)).toEqual([]);
  expect(scanDefinitions(`export { cite } from "./cite";`)).toEqual([]);
  expect(scanDefinitions(`// cite(...) is defined in core`)).toEqual([]);
  expect(scanDefinitions(`const s = "cite";`).some((h) => h.symbol === "cite")).toBe(false);
});

test("scanDefinitions does NOT flag a nested local binding (only top-level vocabulary)", () => {
  // The real-tree case: `const counts = new Map()` inside a function is a private local, not vocab.
  const src = `function ciStats() {\n  const counts = new Map();\n  return counts;\n}`;
  expect(scanDefinitions(src).some((h) => h.symbol === "counts")).toBe(false);
});

test("scanDefinitions reports the offending line and detail", () => {
  const hit = scanDefinitions(`const a = 1;\nexport const stat = 2;`).find((h) => h.symbol === "stat")!;
  expect(hit.line).toBe(2);
  expect(hit.detail).toContain("stat");
});

test("resolveConsumers: empty registry ⇒ empty list (SKIP-as-green)", () => {
  expect(resolveConsumers({}, () => null)).toEqual([]);
});

test("resolveConsumers: parses STD_CONSUMERS PATH-style with #mirror tags", () => {
  expect(resolveConsumers({ STD_CONSUMERS: "/a:/b#mirror" }, () => null)).toEqual([
    { path: "/a", mirror: false },
    { path: "/b", mirror: true },
  ]);
});

test("resolveConsumers: parses the local file, honouring `# mirror` tags and comments", () => {
  const local = "# header comment\n/x/consumer\n/y/consumer  # mirror\n\n";
  expect(resolveConsumers({}, () => local)).toEqual([
    { path: "/x/consumer", mirror: false },
    { path: "/y/consumer", mirror: true },
  ]);
});

test("scanConsumerTrees: a duplicate in a mirror consumer is skipped; in a non-mirror it is reported", () => {
  const consumers: Consumer[] = [
    { path: "/mirror", mirror: true },
    { path: "/real", mirror: false },
  ];
  const files: Record<string, string[]> = { "/mirror": ["/mirror/a.ts"], "/real": ["/real/a.ts"] };
  const contents: Record<string, string> = {
    "/mirror/a.ts": `export const cite = 1;`,
    "/real/a.ts": `export const cite = 1;`,
  };
  const found = scanConsumerTrees(consumers, (d) => files[d] ?? [], (f) => contents[f] ?? "");
  expect(found.map((x) => x.file)).toEqual(["/real/a.ts"]);
  expect(found[0]!.hit.symbol).toBe("cite");
});
