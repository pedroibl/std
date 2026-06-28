// Enforcement harness — D1 / NFR1 / CM3: `src/core/**` is runtime-neutral.
//
// core is the only slice that crosses the Bun<->Obsidian boundary, so it must import nothing
// runtime-specific: no `node:*` / fs / DOM / network imports, and no reference to `process`
// or `document`. This check is TOOLING (not part of core), so it may use Bun/node APIs freely.
//
// Pure scanner (`scanSource`) is unit-tested beside this file; `main()` globs core and gates CI.

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "crypto", "dgram", "dns",
  "events", "fs", "http", "http2", "https", "net", "os", "path", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "timers",
  "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
]);

// DOM/network also reach the source as bare globals (no import): `document` (DOM) and
// `fetch`/`XMLHttpRequest`/`WebSocket` (network). With `process`, these are scanned per-line below.
// A pure core may not pull a DOM library by import either.
const FORBIDDEN_BARE = new Set(["jsdom", "happy-dom", "linkedom"]);
const FORBIDDEN_GLOBALS = ["process", "document", "fetch", "XMLHttpRequest", "WebSocket"];

export type Violation = { line: number; kind: string; detail: string };

const FROM_IMPORT = /\bimport\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT = /\bimport\s+["']([^"']+)["']/g;
const REQUIRE_CALL = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
// Dynamic `import("…")` / `await import("…")` is a real runtime edge too, so it is scanned alongside
// the static forms — otherwise `await import("node:fs")` slips straight past the gate.
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

// Blank out the *content* of block comments while preserving their newlines (and column offsets),
// so `lineOf` keeps reporting the original line of every later violation.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Pure: return every runtime-purity violation in a core source file's text. */
export function scanSource(src: string): Violation[] {
  const out: Violation[] = [];
  const clean = stripComments(src);

  const flag = (spec: string, index: number) => {
    const line = lineOf(clean, index);
    if (spec.startsWith("node:")) { out.push({ line, kind: "node-import", detail: spec }); return; }
    // Match on the root segment so builtin subpaths (`fs/promises`, `stream/web`) are caught too.
    const root = spec.split("/")[0]!;
    if (NODE_BUILTINS.has(root)) out.push({ line, kind: "node-builtin-import", detail: spec });
    else if (FORBIDDEN_BARE.has(spec)) out.push({ line, kind: "forbidden-import", detail: spec });
  };

  for (const re of [FROM_IMPORT, SIDE_EFFECT_IMPORT, REQUIRE_CALL, DYNAMIC_IMPORT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) flag(m[1]!, m.index);
  }

  clean.split("\n").forEach((line, i) => {
    for (const g of FORBIDDEN_GLOBALS) {
      // A *bare* global read only: reject member access (`client.fetch`), longer identifiers,
      // and property keys (`{ fetch: … }`) — none of those read the forbidden global, so flagging
      // them would be a false positive in a merge-blocking gate.
      if (new RegExp(`(?<![.\\w$])${g}\\b(?!\\s*:)`).test(line)) {
        out.push({ line: i + 1, kind: "global-ref", detail: g });
      }
    }
  });

  return out;
}

async function main(): Promise<void> {
  const glob = new Bun.Glob("src/core/**/*.ts");
  const findings: Array<{ file: string; v: Violation }> = [];

  for await (const file of glob.scan(".")) {
    if (file.endsWith(".test.ts")) continue; // tests are not shipped; they may import bun:test
    const src = await Bun.file(file).text();
    for (const v of scanSource(src)) findings.push({ file, v });
  }

  if (findings.length > 0) {
    console.error("✗ core purity violations (D1/NFR1):");
    for (const { file, v } of findings) console.error(`  ${file}:${v.line}  ${v.kind}: ${v.detail}`);
    console.error(`\n${findings.length} violation(s) — core must be runtime-neutral.`);
    process.exit(1);
  }

  console.log("✓ core is pure — no node:*/fs/DOM/network imports, no process/document refs (D1/NFR1)");
}

if (import.meta.main) await main();
