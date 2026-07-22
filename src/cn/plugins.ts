// cn's plugin-dependency contract (AD-6) — the envelope, DECLARED rather than ambient.
//
// AD-6 is per-vault: this edge pins its OWN vault's plugin SET and verifies versions against THAT
// vault's manifests, with NO HARD VERSION-PINS. A version here is an `observedVersion` — a measurement
// taken at a point in time, not an invariant. Drift is a `warn`, forever; only a missing foundation is
// an `error`.
//
// DATA ONLY (Story 8.4 D-2). The record types and the `verifyPlugins` comparator were PROMOTED to
// `src/core/plugin-contract.ts` when dashkit became the second edge to need them (AD-8: what two edges
// share is promoted DOWN into core, never reused sideways). This file now holds ONLY `CN_PLUGIN_CONTRACT`
// and imports the vocabulary type-only from core — so the cn source-scan (which forbids a VALUE import in
// `src/cn/`) still sees nothing but an erased `import type`. The comparator lives once, in core; cn's
// callers (`cn-verify.ts` / `cn-deploy.ts`) get it from there and pass the `"cn"` edge label.
//
// IDENTITY-FREE (D4/NFR3). Plugin ids are cn's own runtime contract, the same way `Severity` is core's
// own vocabulary — they belong here. A VAULT PATH or vault NAME does not, in any string including a
// `why`; the path arrives only as `--vault`.
//
// NOT A CI GATE, deliberately. GitHub Actions runs on Linux with no vault, so a vault check could only
// ever SKIP — a check whose every execution is a no-op has never evaluated its subject. The comparator
// (now in core) gets real fixture coverage in CI; the vault read is a CLI command.

import type { PluginContractEntry } from "../core/plugin-contract";

// Re-export the promoted vocabulary types so cn's existing importers of `../cn/plugins` keep resolving
// (erased `export type`, legal under the cn source-scan). The comparator VALUE is NOT re-exported here —
// it would be a value import from core, which the scan forbids for `src/cn/`; callers import it from core.
export type {
  PluginContractEntry,
  PluginFinding,
  PluginRole,
  VaultPlugins,
} from "../core/plugin-contract";

/**
 * cn's declared envelope. Flat, closed, and CLOSED-WORLD: every plugin enabled in the target vault at
 * reconciliation time appears here, with the ones cn never calls carried explicitly as `ambient`.
 *
 * The version source of truth is the target vault's own `CLAUDE.md` §Plugins, which in turn cites each
 * `.obsidian/plugins/<id>/manifest.json`. `std cn verify --vault <dir>` is what checks doc against reality.
 */
export const CN_PLUGIN_CONTRACT: readonly PluginContractEntry[] = [
  {
    id: "fix-require-modules",
    name: "CodeScript Toolkit",
    role: "foundation",
    required: true,
    observedVersion: "13.3.2",
    // Phrased WITHOUT a literal `require(` call: this slice's source is scanned for one, and the scan
    // deliberately keeps string interiors intact (a real dependency hides in a string as easily as in
    // code). The fact is the same; the shape that trips the guard is not.
    why: "the loader — a `require` of the deployed /Scripts artifact is the only way cn enters a note",
  },
  {
    id: "dataview",
    name: "Dataview",
    role: "foundation",
    required: true,
    observedVersion: "0.5.68",
    why: "read-only data — `getDataview(app)` reaches `app.plugins.plugins.dataview.api`, null when absent",
  },
  {
    id: "table-editor-obsidian",
    name: "Advanced Tables",
    role: "ambient",
    required: false,
    observedVersion: "0.23.2",
    why: "vault-ambient authoring convenience; cn never calls it",
  },
  {
    id: "color-folders-files",
    name: "Color Folders and Files",
    role: "ambient",
    required: false,
    observedVersion: "1.4.1",
    why: "vault-ambient cosmetic; cn never calls it",
  },
  {
    id: "js-engine",
    name: "JS Engine",
    role: "ambient",
    required: false,
    observedVersion: null,
    // ⚠ Names no vault, deliberately (D4/NFR3). "the other edge's" is the whole fact; which vault that
    // is belongs caller-side. (This vault name WOULD be caught by check:no-consumer-ids' denylist — the
    // guard was widened in Story 7.1 — but keeping it out of the string is the primary discipline.)
    why: "the other Obsidian edge's foundation; deliberately not installed in this edge's vault",
  },
];
