// plugin-contract — the pure vocabulary + comparator for an Obsidian edge's plugin-dependency
// envelope (AD-6). PROMOTED to core at Story 8.4's second caller.
//
// cn (7.3) declared this shape for one vault; dashkit (8.4) is the SECOND Obsidian edge to need it —
// and AD-8 forbids `dashkit → cn`. So, exactly as AD-8 prescribes ("what they share is promoted DOWN
// into core, never reused sideways"), the record types and the comparator live here, ONCE. Each edge
// keeps only its OWN contract DATA (`CN_PLUGIN_CONTRACT` in `src/cn/plugins.ts`,
// `DASHKIT_PLUGIN_CONTRACT` in `src/dashkit/plugins.ts`) and passes it in — together with its own edge
// LABEL, so a rendered finding names the right edge ("cn cannot run without it" vs "dashkit cannot run
// without it"). The label is a parameter (D-3), never baked in, so promoting the comparator changed no
// existing rendered string.
//
// PURE (D1/NFR1): data shapes + a comparator. No fs, no DOM, no `process`, no `node:*`. The vault READ
// is a Bun edge (`src/cli/edge-verify.ts`); putting fs here would break core purity and drag node into
// the graph the Obsidian bundler walks. core is the ONLY legal home for this: an edge slice typechecks
// under `types: []` and the post-#56 bundle import guard permits only `import type … from "../core/"`
// from a slice, so a `src/cli/**` home would drag a Bun edge into a DOM edge's compile.
//
// IDENTITY-FREE (D4/NFR3): a plugin id is an edge's own runtime contract, the same way `Severity` is
// core's own vocabulary — it belongs here. A VAULT path or vault NAME does not, in any string including
// a `why`; the path arrives only as `--vault`, caller-side.

import type { Severity } from "./severity";

/**
 * What a plugin is TO AN EDGE — not how important it is to the vault.
 *
 * `foundation` — the edge genuinely cannot run without it. `ambient` — installed in the vault, and the
 * edge never calls it. Listing the ambient ones is load-bearing, not decoration: a contract naming only
 * what it needs cannot distinguish "the edge does not use Advanced Tables" from "nobody checked".
 */
export type PluginRole = "foundation" | "ambient";

/** One declared row of an edge's envelope. Closed record — every field always present. */
export interface PluginContractEntry {
  readonly id: string;
  readonly name: string;
  readonly role: PluginRole;
  /** True only for a `foundation` the edge calls at runtime. An absent required id is an `error`. */
  readonly required: boolean;
  /** The version SEEN when this contract was last reconciled — never a pin. `null` = not installed. */
  readonly observedVersion: string | null;
  readonly why: string;
}

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
 * Compare an observed vault against `contract`. Pure — no I/O, no clock, no globals. `edge` is the edge's
 * label ("cn" / "dashkit"), threaded into the messages that name the edge so a promotion of this function
 * leaves each caller's rendered strings byte-identical (D-3).
 *
 * ⚠ THE MAPPING KEYS ON `role`, NOT ON CONTRACT MEMBERSHIP. Ambient entries ARE in the contract, so a
 * membership test would report them `ok` and claim the edge depends on Advanced Tables.
 *
 *   foundation, absent or disabled ................ error  (the envelope is broken; the edge cannot run)
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
  contract: readonly PluginContractEntry[],
  edge: string,
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
          message: `${entry.name} ${installed ?? "(no manifest)"} — ambient, outside ${edge}'s envelope`,
        });
      }
      continue;
    }

    if (!isEnabled) {
      findings.push({
        id: entry.id,
        severity: "error",
        message: `${entry.name} — required foundation not enabled; ${edge} cannot run without it`,
      });
      continue;
    }
    if (installed === null) {
      findings.push({
        id: entry.id,
        severity: "error",
        message: `${entry.name} — enabled but not installed (no manifest.json); ${edge} cannot run without it`,
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
  // Iterate the SET, not the raw array: a hand-edited or sync-conflicted `community-plugins.json` can
  // list an id twice, which reported the same finding twice and inflated the summary tally by one.
  // A Set preserves insertion order, so the report order is unchanged. (PR #56 MINOR 3, D-6 fix #2.)
  for (const id of enabled) {
    if (declared.has(id)) continue;
    const installed = Object.prototype.hasOwnProperty.call(observed.versions, id)
      ? observed.versions[id]!
      : null;
    findings.push({
      id,
      severity: "info",
      message: `${installed ?? "(no manifest)"} — enabled in the vault, not in ${edge}'s contract`,
    });
  }

  return findings;
}
