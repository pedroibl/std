import { test, expect } from "bun:test";
import { scanBackEdges, scanManifest, findCycle } from "./check-dep-root";

test("scanBackEdges flags a relative loom import", () => {
  const v = scanBackEdges(`import { x } from "../loom/foo";`);
  expect(v.some((o) => o.kind === "back-edge" && o.detail === "../loom/foo")).toBe(true);
});

test("scanBackEdges flags a bare loom import", () => {
  const v = scanBackEdges(`import { x } from "loom/x";`);
  expect(v.some((o) => o.detail === "loom/x")).toBe(true);
});

test("scanBackEdges flags both PAI/Tools and PAI-Tools forms", () => {
  const path = scanBackEdges(`import { t } from "../PAI/Tools/glab";`);
  const pkg = scanBackEdges(`import { t } from "PAI-Tools";`);
  expect(path.some((o) => o.detail === "../PAI/Tools/glab")).toBe(true);
  expect(pkg.some((o) => o.detail === "PAI-Tools")).toBe(true);
});

test("scanBackEdges flags the case-insensitive PAI/TOOLS real dir (Note #1 option a)", () => {
  // The real on-disk dir is ALL-CAPS `PAI/TOOLS`; the mixed-case regex would have missed it on a
  // case-sensitive FS. The `i` flag catches both the old mixed-case form and the real all-caps dir.
  expect(scanBackEdges(`import { t } from "../PAI/TOOLS/glab";`).some((o) => o.detail === "../PAI/TOOLS/glab")).toBe(true);
  expect(scanBackEdges(`import { t } from "../PAI/Tools/glab";`).some((o) => o.detail === "../PAI/Tools/glab")).toBe(true);
});

test("scanBackEdges flags the new LIFEOS/TOOLS framework-dir back-edge (RT-4, case-exact)", () => {
  expect(scanBackEdges(`import { t } from "../src/x/LIFEOS/TOOLS/y";`).some((o) => o.detail === "../src/x/LIFEOS/TOOLS/y")).toBe(true);
  expect(scanBackEdges(`import { t } from "LIFEOS-TOOLS";`).some((o) => o.detail === "LIFEOS-TOOLS")).toBe(true);
});

test("scanBackEdges flags the LifeOS and LifeOs identifiers (RT-4)", () => {
  expect(scanBackEdges(`import { t } from "../LifeOS/x";`).some((o) => o.detail === "../LifeOS/x")).toBe(true);
  expect(scanBackEdges(`import { t } from "../LifeOs/x";`).some((o) => o.detail === "../LifeOs/x")).toBe(true);
});

test("scanBackEdges does NOT false-positive on bloomfilter or a clean relative import", () => {
  expect(scanBackEdges(`import { B } from "bloomfilter";`)).toEqual([]);
  expect(scanBackEdges(`import { other } from "./other";`)).toEqual([]);
});

test("RT-4 does NOT false-positive on benign lifeoslike / PAILtools lookalikes", () => {
  // case-exact LIFEOS + word-bounded LifeO[sS] means lowercase `lifeoslike` never matches;
  // `PAILtools` has no `/`|`-` separator after `PAI`, so isPaiTools misses it too.
  expect(scanBackEdges(`import { x } from "./lifeoslike/util";`)).toEqual([]);
  expect(scanBackEdges(`import { x } from "PAILtools";`)).toEqual([]);
});

test("scanBackEdges ignores a commented-out loom import", () => {
  const src = `// import x from "../loom/foo"\n/* import y from "loom/y" */\nexport const z = 1;`;
  expect(scanBackEdges(src)).toEqual([]);
});

test("scanBackEdges flags a loom back-edge expressed as a re-export", () => {
  expect(scanBackEdges(`export { x } from "../loom/x";`).some((o) => o.detail === "../loom/x")).toBe(true);
  expect(scanBackEdges(`export * from "loom/y";`).some((o) => o.detail === "loom/y")).toBe(true);
});

test("scanBackEdges flags a loom back-edge expressed as a dynamic import", () => {
  expect(scanBackEdges(`const m = await import("../loom/x");`).some((o) => o.detail === "../loom/x")).toBe(true);
});

test("scanBackEdges reports the original line after a multi-line block comment", () => {
  const src = `/*\n header\n*/\nimport { x } from "loom/x";`;
  expect(scanBackEdges(src).some((o) => o.detail === "loom/x" && o.line === 4)).toBe(true);
});

test("scanBackEdges does NOT flag a local re-export barrel or a local type re-export", () => {
  expect(scanBackEdges(`export * from "./core/index";`)).toEqual([]);
  expect(scanBackEdges(`export type { T } from "./t";`)).toEqual([]);
});

test("findCycle detects a cycle routed through export-* barrels", () => {
  // a.ts `export * from "./b"`, b.ts `export * from "./a"` — graph nodes are the resolved files.
  const cycle = findCycle({ "a.ts": ["b.ts"], "b.ts": ["a.ts"] });
  expect(cycle).not.toBeNull();
});

test("scanManifest flags loom, scoped @pedroibl/loom, and PAI-Tools deps", () => {
  const v = scanManifest({
    dependencies: { loom: "^1.0.0" },
    devDependencies: { "@pedroibl/loom": "^1.0.0" },
    peerDependencies: { "PAI-Tools": "^1.0.0" },
  });
  expect(v.some((o) => o.detail === "dependencies.loom")).toBe(true);
  expect(v.some((o) => o.detail === "devDependencies.@pedroibl/loom")).toBe(true);
  expect(v.some((o) => o.detail === "peerDependencies.PAI-Tools")).toBe(true);
});

test("scanManifest returns [] for the real clean manifest", () => {
  const v = scanManifest({
    devDependencies: { "@types/bun": "latest", typescript: "^5.8.0" },
  });
  expect(v).toEqual([]);
});

test("findCycle returns null on a DAG", () => {
  expect(findCycle({ a: ["b", "c"], b: ["c"], c: [] })).toBeNull();
});

test("findCycle detects a self-loop", () => {
  expect(findCycle({ a: ["a"] })).not.toBeNull();
});

test("findCycle detects a 2-cycle", () => {
  const cycle = findCycle({ a: ["b"], b: ["a"] });
  expect(cycle).not.toBeNull();
  expect(cycle!.length).toBeGreaterThan(1);
});

test("findCycle detects a cycle nested inside a larger graph", () => {
  // entry → a → b → c → a (cycle), plus an acyclic tail d.
  const cycle = findCycle({ entry: ["a", "d"], a: ["b"], b: ["c"], c: ["a"], d: [], e: ["b"] });
  expect(cycle).not.toBeNull();
});

test("findCycle ignores edges to external (absent) nodes", () => {
  // 'b' and 'ext' are not keys in the graph — they are externals, not internal cycle nodes.
  expect(findCycle({ a: ["b", "ext"] })).toBeNull();
});
