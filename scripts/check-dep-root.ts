// Enforcement harness — D4 / NFR2 / SM2: std is a clean dependency root.
//
// std imports NOTHING back: no import/require reaches `loom` or `PAI/Tools`, no `package.json`
// dependency names either, and no import cycle exists within std. `loom` is a future *consumer*,
// never a dependency. This check is TOOLING (not part of core), so it may use Bun/node APIs freely
// (Bun.Glob, Bun.file, node:path, process.exit) — only `src/core/**` is held to D1 purity.
//
// Three pure analyzers (scanBackEdges / scanManifest / findCycle) are unit-tested beside this file;
// main() globs src, builds the relative-import graph, scans, and gates CI.
//
// Zero new dependency (D4): the cycle detector is a hand-rolled DFS, not a graph library.
//
// The import/export specifier regexes + comment/string masking + `specifiers()` live in
// scripts/lib/specifiers.ts (the Rule-of-Three home, extracted at 1.4's third caller) — imported
// here, no longer re-declared. Re-export barrels (`export … from "…"`) and dynamic `import("…")`
// are real compile-time module edges, so `specifiers()` feeds both the back-edge scan AND the cycle
// graph; a type-only re-export still forms a cycle and is deliberately included.

import { specifiers, stripStringsAndComments, lineOf } from "./lib/specifiers";

export type Violation = { kind: string; detail: string; line?: number };

// Segment-aware so `bloomfilter` / `heirloom` / `loomis` do NOT false-positive; a bare substring would.
const isLoom = (spec: string): boolean => spec.split(/[\\/]/).includes("loom");
// Covers both the path form (`PAI/Tools`) and the package-name form (`PAI-Tools`).
const isPaiTools = (spec: string): boolean => /PAI[\/-]Tools/.test(spec);
const isBackEdge = (spec: string): boolean => isLoom(spec) || isPaiTools(spec);

/** Pure: flag any import/require specifier in a source file reaching `loom` or `PAI/Tools`. */
export function scanBackEdges(src: string): Violation[] {
  const out: Violation[] = [];
  const clean = stripStringsAndComments(src);
  for (const { spec, index } of specifiers(clean)) {
    if (isBackEdge(spec)) out.push({ kind: "back-edge", detail: spec, line: lineOf(clean, index) });
  }
  return out;
}

const DEP_BLOCKS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** Pure: flag any dep in package.json naming `loom`/`PAI-Tools` (incl. scoped `@scope/loom`). */
export function scanManifest(pkg: unknown): Violation[] {
  const out: Violation[] = [];
  if (typeof pkg !== "object" || pkg === null) return out;
  const obj = pkg as Record<string, unknown>;
  for (const block of DEP_BLOCKS) {
    const deps = obj[block];
    if (typeof deps !== "object" || deps === null) continue;
    for (const name of Object.keys(deps)) {
      if (isBackEdge(name)) out.push({ kind: "manifest-dep", detail: `${block}.${name}` });
    }
  }
  return out;
}

/**
 * Pure: return the first import cycle as a node path (`a → b → a`), else null. DFS with
 * white/gray/black coloring — an edge to a gray (on-stack) node is a back-edge. Edges to nodes
 * absent from the graph (externals) are skipped.
 */
export function findCycle(graph: Record<string, string[]>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color: Record<string, number> = {};
  for (const node of Object.keys(graph)) color[node] = WHITE;
  const stack: string[] = [];

  function dfs(v: string): string[] | null {
    color[v] = GRAY;
    stack.push(v);
    for (const w of graph[v] ?? []) {
      if (!(w in graph)) continue; // external — not an internal node
      if (color[w] === GRAY) return stack.slice(stack.indexOf(w)).concat(w);
      if (color[w] === WHITE) {
        const found = dfs(w);
        if (found) return found;
      }
    }
    stack.pop();
    color[v] = BLACK;
    return null;
  }

  for (const node of Object.keys(graph)) {
    if (color[node] === WHITE) {
      const found = dfs(node);
      if (found) return found;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const { dirname, join } = await import("node:path");

  const glob = new Bun.Glob("src/**/*.ts");
  const files: string[] = [];
  for await (const file of glob.scan(".")) {
    if (file.endsWith(".test.ts")) continue; // tests are not shipped; a cycle never routes through one
    files.push(file);
  }
  const fileSet = new Set(files);

  const findings: Array<{ where: string; v: Violation }> = [];
  const graph: Record<string, string[]> = {};
  for (const file of files) graph[file] = [];

  for (const file of files) {
    const src = await Bun.file(file).text();
    for (const v of scanBackEdges(src)) findings.push({ where: file, v });

    const clean = stripStringsAndComments(src);
    const dir = dirname(file);
    for (const { spec } of specifiers(clean)) {
      if (!spec.startsWith(".")) continue; // bare/external specifier → no internal graph edge
      const base = join(dir, spec);
      const target = [`${base}.ts`, join(base, "index.ts")].find((c) => fileSet.has(c));
      if (target) graph[file]!.push(target);
    }
  }

  const pkg = await Bun.file("package.json").json();
  for (const v of scanManifest(pkg)) findings.push({ where: "package.json", v });

  const cycle = findCycle(graph);

  if (findings.length > 0 || cycle !== null) {
    console.error("✗ dependency-root / no-cycle violations (D4/NFR2):");
    for (const { where, v } of findings) {
      console.error(`  ${where}${v.line ? `:${v.line}` : ""}  ${v.kind}: ${v.detail}`);
    }
    if (cycle) console.error(`  cycle: ${cycle.join(" → ")}`);
    const n = findings.length + (cycle ? 1 : 0);
    console.error(`\n${n} violation(s) — std must import nothing back and contain no cycle.`);
    process.exit(1);
  }

  console.log("✓ std is a clean dependency root — no loom/PAI-Tools back-edge, no import cycle (D4/NFR2)");
}

if (import.meta.main) await main();
