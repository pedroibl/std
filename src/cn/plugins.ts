// cn's plugin-dependency contract (AD-6) — the envelope, DECLARED rather than ambient.
//
// AD-6 is per-vault: this edge pins its OWN vault's plugin SET and verifies versions against THAT
// vault's manifests, with NO HARD VERSION-PINS. A version here is an `observedVersion` — a measurement
// taken at a point in time, not an invariant. Drift is a `warn`, forever; only a missing foundation is
// an `error`.
//
// PURE (D1-shaped, though this is the cn edge not core): data + a comparator. No fs, no DOM, no
// `process`, no `node:*`. The vault READ lives in `src/cli/cn-verify.ts`, a Bun edge — fs code inside
// `src/cn/` would enter the graph `Bun.build` walks and end up inside the deployed vault artifact.
//
// IDENTITY-FREE (D4/NFR3). Plugin ids are cn's own runtime contract, the same way `Severity` is core's
// own vocabulary — they belong here. A VAULT PATH or vault NAME does not, in any string including a
// `why`; the path arrives only as `--vault`.
//
// NOT A CI GATE, deliberately. GitHub Actions runs on Linux with no vault, so a vault check could only
// ever SKIP — a check whose every execution is a no-op has never evaluated its subject. The comparator
// below is pure and therefore gets real fixture coverage in CI; the vault read is a CLI command.

import type { Severity } from "../core/severity";

/**
 * What a plugin is TO CN — not how important it is to the vault.
 *
 * `foundation` — cn genuinely cannot run without it. `ambient` — installed in the vault, and cn never
 * calls it. Listing the ambient ones is load-bearing, not decoration: a contract naming only what it
 * needs cannot distinguish "cn does not use Advanced Tables" from "nobody checked".
 */
export type PluginRole = "foundation" | "ambient";

/** One declared row of cn's envelope. Closed record — every field always present. */
export interface PluginContractEntry {
  readonly id: string;
  readonly name: string;
  readonly role: PluginRole;
  /** True only for a `foundation` cn calls at runtime. An absent required id is an `error`. */
  readonly required: boolean;
  /** The version SEEN when this contract was last reconciled — never a pin. `null` = not installed. */
  readonly observedVersion: string | null;
  readonly why: string;
}

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
    // is belongs caller-side. The no-consumer-ids denylist would not catch a vault name here, which
    // makes it a SILENT doctrine violation — worse than a red one.
    why: "the other Obsidian edge's foundation; deliberately not installed in this edge's vault",
  },
];

/** Already-parsed vault state. `verifyPlugins` takes THIS, never a path — that is what keeps it pure. */
export interface VaultPlugins {
  /** ids from `.obsidian/community-plugins.json` (the enabled array). */
  readonly enabled: readonly string[];
  /** id -> version, one entry per installed `plugins/<id>/manifest.json`. */
  readonly versions: Readonly<Record<string, string>>;
}

/** One line of the report. `severity` is core's ONE vocabulary — never a local union, never a new glyph map. */
export interface PluginFinding {
  readonly id: string;
  readonly severity: Severity;
  readonly message: string;
}

/**
 * Compare an observed vault against the contract. Pure — no I/O, no clock, no globals.
 *
 * ⚠ THE MAPPING KEYS ON `role`, NOT ON CONTRACT MEMBERSHIP. Ambient entries ARE in the contract, so a
 * membership test would report them `ok` and claim cn depends on Advanced Tables.
 *
 *   foundation, absent or disabled ................ error  (the envelope is broken; cn cannot run)
 *   foundation, enabled, no manifest .............. error  (registered but not installed)
 *   foundation, enabled, version differs .......... warn   (drift — never fatal, AD-6 forbids pins)
 *   foundation, enabled, version matches .......... ok
 *   ambient, anything ............................. info   (never ok/warn/error; version never compared)
 *   enabled id absent from the contract entirely .. info
 *
 * An `observedVersion: null` entry can never produce a drift `warn` — there is nothing to compare to.
 *
 * Order is contract order first, then any extras, so the rendered report is stable across runs.
 */
export function verifyPlugins(
  observed: VaultPlugins,
  contract: readonly PluginContractEntry[] = CN_PLUGIN_CONTRACT,
): PluginFinding[] {
  const enabled = new Set(observed.enabled);
  const findings: PluginFinding[] = [];

  for (const entry of contract) {
    const isEnabled = enabled.has(entry.id);
    const installed = Object.prototype.hasOwnProperty.call(observed.versions, entry.id)
      ? observed.versions[entry.id]!
      : null;

    if (entry.role === "ambient") {
      // Never ok/warn/error, and the version is never compared — that is what "outside the envelope"
      // MEANS. The only thing that varies is how the message reads.
      if (!isEnabled) {
        findings.push({
          id: entry.id,
          severity: "info",
          message:
            entry.observedVersion === null
              ? `${entry.name} — deliberately absent from this vault (${entry.why})`
              : `${entry.name} — declared ambient, not enabled here`,
        });
      } else {
        findings.push({
          id: entry.id,
          severity: "info",
          message: `${entry.name} ${installed ?? "(no manifest)"} — ambient, outside cn's envelope`,
        });
      }
      continue;
    }

    if (!isEnabled) {
      findings.push({
        id: entry.id,
        severity: "error",
        message: `${entry.name} — required foundation not enabled; cn cannot run without it`,
      });
      continue;
    }
    if (installed === null) {
      findings.push({
        id: entry.id,
        severity: "error",
        message: `${entry.name} — enabled but not installed (no manifest.json); cn cannot run without it`,
      });
      continue;
    }
    if (entry.observedVersion === null || installed === entry.observedVersion) {
      findings.push({
        id: entry.id,
        severity: "ok",
        message: `${entry.name} ${installed} — foundation present`,
      });
      continue;
    }
    findings.push({
      id: entry.id,
      severity: "warn",
      message: `${entry.name} ${installed} — drift from the observed ${entry.observedVersion} (not fatal)`,
    });
  }

  const declared = new Set(contract.map((e) => e.id));
  for (const id of observed.enabled) {
    if (declared.has(id)) continue;
    const installed = Object.prototype.hasOwnProperty.call(observed.versions, id)
      ? observed.versions[id]!
      : null;
    findings.push({
      id,
      severity: "info",
      message: `${installed ?? "(no manifest)"} — enabled in the vault, not in cn's contract`,
    });
  }

  return findings;
}
