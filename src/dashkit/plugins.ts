// dashkit's plugin-dependency contract (AD-6) — the note-report vault's envelope, DECLARED rather than
// ambient. The sibling of `src/cn/plugins.ts`: a DIFFERENT vault, a DIFFERENT plugin set (AD-6/AD-8).
//
// AD-6 is per-vault: this edge pins its OWN vault's plugin SET and verifies versions against THAT vault's
// manifests, with NO HARD VERSION-PINS. A version here is an `observedVersion` — a measurement taken at a
// point in time (live from `.obsidian/plugins/<id>/manifest.json` when this was reconciled), not an
// invariant. Drift is a `warn`, forever; only a missing foundation is an `error`.
//
// DATA ONLY (Story 8.4 D-2). The record types and the `verifyPlugins` comparator are PROMOTED to core
// (`src/core/plugin-contract.ts`) — shared with cn, imported type-only here. dashkit MUST NOT import cn
// (AD-8): what the two edges share flows DOWN through core, never sideways. This module imports `core`
// type-only and nothing else — no fs, no DOM, no `process`.
//
// IDENTITY-FREE (D4/NFR3). A plugin id is dashkit's own runtime contract, like `Severity` is core's
// vocabulary — it belongs here. A VAULT path or vault NAME does NOT, in any string including a `why`.
// ⚠ And unlike the stale warning that once sat in cn's contract, this IS enforced loudly: the vault name
// is on `scripts/check-no-consumer-ids.ts`'s denylist and that gate keeps string interiors — so a vault
// name in a `name:`/`why:` field is a RED CI gate, not a silent slip. The path arrives only as `--vault`.
//
// NOT A CI GATE, deliberately. GitHub Actions runs on Linux with no vault, so a vault check could only
// ever SKIP — a check whose every execution is a no-op has never evaluated its subject. The comparator
// (in core) gets real fixture coverage in CI; the vault read is a CLI command plus one live contact run.

import type { PluginContractEntry } from '../core/plugin-contract';

/**
 * dashkit's declared envelope. Flat, closed, and CLOSED-WORLD: every plugin enabled in the note-report
 * vault at reconciliation time appears here, with the ones dashkit never calls carried explicitly as
 * `ambient`. Listing the six ambient rows is load-bearing, not decoration — a contract naming only what it
 * needs cannot distinguish "dashkit does not use Markwhen" from "nobody checked".
 *
 * ⚠ ROLES ARE THE VAULT CONTRACT, NOT THE IMPORT GRAPH (Story 8.4 D-1). Measured live, `dashkit.ts` calls
 * the JS Engine API not at all (it is the note-level HOST that renders dashkit's output), reaches Dataview
 * through a single null-safe accessor, and hard-depends only on CodeScript Toolkit. All three are declared
 * `foundation`/`required` ANYWAY: AD-6 is [ADOPTED] and names all three, cn's shipped contract already
 * marks `dataview` required on the identical null-tolerant accessor, and "the edge cannot run without it"
 * means "cannot reach a reader" — a vault with no JS Engine shows no dashboard even though the module would
 * import fine. The measurement is recorded in the `why` clauses + a dated PROPOSED addendum under AD-6
 * (Story 8.4 AC10); no role is demoted. The version SoT is the vault's own `CLAUDE.md` §Plugins, which
 * cites each manifest; `std dashkit verify --vault <dir>` checks doc against reality, and
 * `std dashkit deploy` runs the same check as a preflight.
 */
export const DASHKIT_PLUGIN_CONTRACT: readonly PluginContractEntry[] = [
  {
    id: 'fix-require-modules',
    name: 'CodeScript Toolkit',
    role: 'foundation',
    required: true,
    observedVersion: '13.3.2',
    // Hard, two ways. Phrased WITHOUT a literal `require(` call (the slice source is scanned for one, and
    // the scan keeps string interiors): it is the loader — a `require` of the deployed /Scripts artifact is
    // how dashkit enters a note — AND dashkit reaches its `node:*` bridge through it for desktop shell-outs.
    why: 'the loader — a `require` of the deployed /Scripts artifact, and dashkit reaches node builtins through it for desktop shell-outs',
  },
  {
    id: 'js-engine',
    name: 'JS Engine',
    role: 'foundation',
    required: true,
    observedVersion: '0.3.6',
    // The note-level HOST that runs the deployed bundle and renders its output; the library never calls the
    // js-engine API itself (D-1). A vault without it cannot show a dashboard even though the module imports.
    why: 'the host that runs the deployed bundle in a note and renders its output; no dashboard reaches a reader without it',
  },
  {
    id: 'dataview',
    name: 'Dataview',
    role: 'foundation',
    required: true,
    observedVersion: '0.5.68',
    // The entire surface is one null-safe accessor — the same shape cn declares required on Dataview.
    why: 'read-only data — `getDataview(app)` reaches `app.plugins.plugins.dataview.api`, null when absent',
  },
  {
    id: 'callout-manager',
    name: 'Callout Manager',
    role: 'ambient',
    required: false,
    observedVersion: '1.1.1',
    why: 'vault-ambient content-block authoring; dashkit never calls it',
  },
  {
    id: 'callout-integrator',
    name: 'Callout Integrator',
    role: 'ambient',
    required: false,
    observedVersion: '1.1.4',
    why: 'vault-ambient content-block authoring; dashkit never calls it',
  },
  {
    id: 'project-manager',
    name: 'Project Manager',
    role: 'ambient',
    required: false,
    observedVersion: '1.8.0',
    // An App, out of std scope (AD-6). It READS the read-only mirror dashkit writes; dashkit never calls it.
    why: 'an app, out of std scope (AD-6); it reads the read-only mirror dashkit emits, and dashkit never calls it',
  },
  {
    id: 'markwhen',
    name: 'Markwhen',
    role: 'ambient',
    required: false,
    observedVersion: '0.0.7',
    why: 'an app, out of std scope (AD-6); desktop-only timeline authoring; dashkit never calls it',
  },
  {
    id: 'table-editor-obsidian',
    name: 'Advanced Tables',
    role: 'ambient',
    required: false,
    observedVersion: '0.23.2',
    why: 'vault-ambient authoring convenience; dashkit never calls it',
  },
  {
    id: 'color-folders-files',
    name: 'Color Folders and Files',
    role: 'ambient',
    required: false,
    observedVersion: '1.4.1',
    why: 'vault-ambient cosmetic; dashkit never calls it',
  },
];
