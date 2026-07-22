// Shared test-util for the edge-deploy suites (Story 8.3 AC3). Extracted out of `cn-deploy.test.ts`'s
// private `externalImportViolations()` (7.1/7.3) so BOTH `cn-deploy.test.ts` and `dashkit-deploy.test.ts`
// scan their slice's SOURCE with one implementation instead of a sideways copy (the duplication D-1 forbids
// for the engine, forbidden here too). Not shipped API — fixture support that happens to need a module home;
// never exported from `src/cli/index.ts`.
//
// WHY A POLICY PARAMETER. cn imports NOTHING as a value — its only legal edge is `import type {…} from
// "../core/…"` (erased by `verbatimModuleSyntax`, contributes zero bytes). dashkit is different: it legally
// VALUE-imports `parseSprint`/`summarize`/`bar`/`escapeHtml` from `../core` (Story 8.3 bite #4 — `core` is IN
// the dashkit bundle, which inverts cn's "imports nothing from core" contact observation). So the one scanner
// takes a `ScanPolicy`: both edges ban every non-core edge, but only dashkit permits VALUE imports from core.

/** What a slice is allowed to import. `allowValueFromCore` is the only axis that differs between edges. */
export interface ScanPolicy {
  /** The core specifier root, WITHOUT a trailing slash — `"../core"`. A spec is "core" iff it equals this or
   *  starts with it + "/". */
  readonly coreRoot: string;
  /** cn: false (type-only from core). dashkit: true (`core` is bundled, so value imports are legal). */
  readonly allowValueFromCore: boolean;
}

/** cn's policy: only `import type … from "../core/…"` is legal; cn value-imports nothing. */
export const CN_SCAN_POLICY: ScanPolicy = { coreRoot: "../core", allowValueFromCore: false };
/** dashkit's policy: value AND type imports from `../core`/`../core/…` are legal (`core` is bundled). */
export const DASHKIT_SCAN_POLICY: ScanPolicy = { coreRoot: "../core", allowValueFromCore: true };

/** Blank out `//` and block comments so a source scan sees code only, not prose about code. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");
}

/**
 * Every module-graph edge in `src` that is NOT one the slice's `policy` permits.
 *
 * ALLOWED: `import type {…}`/`import type * as X` from a core specifier (always); and, when
 * `policy.allowValueFromCore`, a plain VALUE `import {…}`/`export {…}` from a core specifier too. A core
 * specifier is `policy.coreRoot` exactly, or anything under it (`../core/sprint`).
 *
 * BANNED: every import/re-export whose specifier is not core; a VALUE import from core when the policy
 * forbids it (cn); every bare side-effect `import "…"`; and every `require(…)` / dynamic `import(…)` whose
 * specifier is not a `node:` builtin or core (a non-literal, un-verifiable argument is always banned).
 *
 * ⚠ `node:` builtins are ALLOWED in a require/dynamic-import (dashkit's desktop-only `require("node:child_
 * process")` shell-outs). They are runtime-provided by the Electron host — exactly like a plugin API — and
 * Bun leaves them external under `target:"browser"` (measured: the bundle stays ~24 KB, not inlined). cn has
 * no requires at all, so this allowance changes nothing for it.
 *
 * ⚠ SCANS THE WHOLE SOURCE, NOT LINE BY LINE. `import` / `export … from` are multi-line statements; a
 * per-line filter is blind to any whose first line is a bare `import`, which is exactly how 7.3's narrowing
 * reopened 7.1's hole (a three-line `import\n {GLYPH}\n from "../core/severity"` shipped its code into the
 * vault artifact with the whole merge bar green). Returns the offending statements so a failure names them.
 */
export function externalImportViolations(src: string, policy: ScanPolicy): string[] {
  const out: string[] = [];
  const isCore = (spec: string): boolean =>
    spec === policy.coreRoot || spec.startsWith(policy.coreRoot + "/");
  for (const m of src.matchAll(/^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)) {
    const stmt = m[0];
    const spec = m[1]!;
    // `import type {`/`import type *`/`export type {`/`export type *` — the ERASED forms. Note `import type
    // from "…"` (a DEFAULT import whose binding is literally named `type`) has no `{`/`*` after `type`, so it
    // is correctly treated as a VALUE import, not erased.
    const isTypeOnly = /^[ \t]*(?:import|export)\s+type\s*[{*]/.test(stmt);
    const legal = isCore(spec) && (isTypeOnly || policy.allowValueFromCore);
    if (!legal) out.push(stmt);
  }
  // A bare side-effect `import "…"` is always a violation — a pure runtime edge with no binding.
  const bare = src.match(/^[ \t]*import\s*["']/m);
  if (bare) out.push(bare[0]);
  // `require(…)` / dynamic `import(…)`: legal only for a `node:` builtin (runtime-provided host) or core; a
  // non-literal argument cannot be verified, so it is always flagged.
  for (const m of src.matchAll(/\b(?:require|import)\s*\(\s*(?:(["'])([^"']*)\1)?/g)) {
    const spec = m[2];
    if (spec === undefined) {
      out.push(m[0].trim()); // dynamic (non-literal) argument
    } else if (!spec.startsWith("node:") && !isCore(spec)) {
      out.push(m[0].trim());
    }
  }
  return out;
}

/**
 * Evasions that are a violation under EITHER edge's policy — external deps, cross-slice edges, and the
 * value-binding-named-`type` trap — each a real form that shipped green before 7.3's scanner fix. A suite
 * runs these plus its own policy-specific legal-form assertions. (cn additionally treats a VALUE core import
 * as a violation; dashkit does not — so the multi-line/default-value cases here use non-core specifiers to
 * stay violations under both.)
 */
export const SHARED_IMPORT_EVASIONS: readonly string[] = [
  'import\n  { parse }\n  from "yaml";', // multi-line external: the line filter's blind spot
  'import type from "yaml";', // a DEFAULT VALUE import whose binding is named `type`, from an external dep
  'export { parse } from "yaml";', // a re-export — never scanned at all before 7.3
  'import { parse } from "yaml";', // the plain external dependency the ceiling test was about
  'import { statCard } from "../cn/index";', // cross-slice: down-to-core only (D1/AD-8)
  'import "./side-effect";', // a bare side-effect import
  'const y = require("yaml");', // a require of an EXTERNAL package (a `node:` builtin is legal; this is not)
  'const x = await import("yaml");', // a dynamic import of an external package
];
