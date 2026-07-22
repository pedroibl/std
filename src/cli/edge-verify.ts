// edge-verify — the generic, edge-agnostic half of `std <edge> verify --vault <dir>`: read a real
// vault's enabled set + installed versions, compare against the edge's declared contract (the pure
// `verifyPlugins` in core), render, and dispatch to the 0/1/2 exit contract.
//
//   std cn verify --vault <dir>        std dashkit verify --vault <dir>
//
// PROMOTED, NOT COPIED (Story 8.4 D-2, the Rule-of-Three / D2/AD-3). 7.3 shipped this shape once, for cn,
// inside `cn-verify.ts`. dashkit is the second caller, and AD-8 forbids `dashkit → cn` — so the parts that
// differ between edges (the CONTRACT and the edge LABEL) arrive in a `VerifySpec`, and everything else —
// the vault read, the fixed line format, the summary suppression, and the `0|1|2` dispatch — lives here,
// SHARED. `cn-verify.ts` and `dashkit-verify.ts` become thin wiring, exactly as `cn-deploy.ts` /
// `dashkit-deploy.ts` are thin wiring over `edge-deploy.ts`.
//
// BUN EDGE, deliberately NOT inside an edge slice. The CONTRACT and the COMPARATOR are pure (`core`);
// only the vault READ lives here. fs code inside `src/cn/` or `src/dashkit/` would drag it into the graph
// `Bun.build` walks and ship it inside the deployed vault artifact.
//
// NOT A CI GATE, on purpose. There is no vault on GitHub's Linux runner, so a `scripts/check-*-plugins.ts`
// could only ever SKIP — a check that cannot fail is not a check. The pure comparator gets fixture coverage
// in CI; this file gets a contact check against the real vault, once per edge.
//
// IDENTITY-FREE (D4/NFR3). The vault path arrives only as `--vault`.

import { basename, dirname, join, resolve } from "node:path";

import { flagValue } from "../core/args";
import {
  type PluginContractEntry,
  type PluginFinding,
  type VaultPlugins,
  verifyPlugins,
} from "../core/plugin-contract";
import { GLYPH } from "../core/severity";
import { emptyCounts, statusLine } from "../core/status";
import { exists, loadJson, walkFiles } from "../fsx/index";

/** Fail-loud conditions. The CLI prints `.message` (`✗ …`) and returns the usage/failure exit code. */
export class EdgeVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeVerifyError";
  }
}

/** Column width for the id, so the messages line up. Ids are short; the longest declared is 21 chars. */
const ID_WIDTH = 24;

/**
 * Read the enabled set + the installed versions out of a real vault.
 *
 * GUARDS mirror `<edge> deploy`'s exactly (vault missing/empty, vault absent, no `.obsidian/`), plus the
 * one this command adds: `community-plugins.json` missing or not a JSON array.
 *
 * TWO CASES THAT ARE NOT GUARD FAILURES, deliberately:
 *   - `.obsidian/plugins/` missing entirely — `walkFiles` fail-softs to `[]` on a non-directory root, so
 *     this yields `versions = {}` and every enabled id falls to the enabled-but-unversioned rule.
 *   - an enabled id with no `manifest.json` — that IS the finding (error for a foundation, info
 *     otherwise), not a crash.
 */
export function readVaultPlugins(vault: string | undefined): VaultPlugins {
  if (vault === undefined || vault === "") {
    throw new EdgeVerifyError("--vault <dir> is required (the Obsidian vault to verify)");
  }
  if (!exists(vault)) {
    throw new EdgeVerifyError(`vault does not exist: ${vault}`);
  }
  const obsidian = join(vault, ".obsidian");
  if (!exists(obsidian)) {
    throw new EdgeVerifyError(`not an Obsidian vault (no .obsidian/): ${vault}`);
  }

  const enabledPath = join(obsidian, "community-plugins.json");
  if (!exists(enabledPath)) {
    throw new EdgeVerifyError(
      `no community-plugins.json in ${obsidian} — cannot tell which plugins are enabled`,
    );
  }
  // `loadJson`'s fallback would silently turn malformed JSON into an empty vault, and an empty vault
  // reports "both foundations missing" — a parse failure dressed up as a real finding. Sentinel + an
  // explicit shape check keeps it fail-loud (FR5).
  const raw = loadJson<unknown>(enabledPath, null);
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
    throw new EdgeVerifyError(`${enabledPath} is not a JSON array of plugin ids`);
  }

  const pluginsRoot = resolve(join(obsidian, "plugins"));
  const manifests = walkFiles(pluginsRoot, (p) => basename(p) === "manifest.json", {
    // Only DIRECT children of plugins/ hold a plugin manifest. Without this, the walk descends every
    // plugin's own bundled assets — and a vendored manifest.json two levels down would register a
    // phantom plugin. (PR #56 MINOR/depth-1 prune, D-6 fix #3.)
    prune: (dir) => dirname(dir) !== pluginsRoot,
  }).filter((p) => dirname(dirname(p)) === pluginsRoot);

  const versions: Record<string, string> = {};
  for (const path of manifests) {
    const m = loadJson<{ id?: unknown; version?: unknown } | null>(path, {});
    // `loadJson` only fail-softs a MISSING or UNPARSEABLE file. A manifest containing exactly `null`
    // (or an array, or a bare string) parses fine and comes straight back — and `m.id` on it threw a
    // raw TypeError that reached the user as `✗ TypeError: null is not an object`, bypassing the
    // injected sink. A junk manifest is "no manifest", which is already a finding the comparator
    // reports properly. (PR #56 MINOR 2, D-6 fix #1.)
    if (m === null || typeof m !== "object" || Array.isArray(m)) continue;
    // The manifest's own `id` is the source of truth; the directory name is only a fallback for a
    // hand-renamed plugin dir. A manifest with no usable version is treated as no manifest at all.
    const id = typeof m.id === "string" && m.id !== "" ? m.id : basename(dirname(path));
    if (typeof m.version === "string" && m.version !== "") versions[id] = m.version;
  }

  return { enabled: raw as string[], versions };
}

/**
 * Render findings + the summary line. Pure — takes findings, returns lines, so the exact printed output
 * is assertable without a vault.
 *
 * `statusLine` returns `""` for an all-zero tally; suppress the line entirely rather than printing a
 * blank one. The tally is built INSIDE this function on purpose — a module-level `const counts = …`
 * is a Gate 6 (`check:single-source`) failure.
 */
export function renderFindings(findings: readonly PluginFinding[]): string[] {
  const counts = emptyCounts();
  const lines: string[] = [];
  for (const f of findings) {
    counts[f.severity] += 1;
    lines.push(`${GLYPH[f.severity]} ${f.id.padEnd(ID_WIDTH)} ${f.message}`);
  }
  const summary = statusLine(counts);
  if (summary !== "") {
    lines.push("");
    lines.push(summary);
  }
  return lines;
}

/** Everything that differs between one edge's verify and another: the label and the declared contract. */
export interface VerifySpec {
  /** "cn" | "dashkit" — threaded into `verifyPlugins` so the findings name the right edge. */
  readonly edge: string;
  /** The edge's declared envelope (`CN_PLUGIN_CONTRACT` / `DASHKIT_PLUGIN_CONTRACT`). */
  readonly contract: readonly PluginContractEntry[];
}

/** Injected sink so the command is testable without capturing stdout. */
export interface EdgeVerifyDeps {
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

/**
 * `std <edge> verify --vault <dir>`. Returns a process exit code, mirroring `<edge> deploy`'s contract
 * exactly: 0 ok, 1 fail-loud, 2 usage (a missing `--vault` is usage; every other guard is a real failure).
 *
 * DRIFT NEVER FAILS THE COMMAND (AD-6: no hard version-pins). Only an `error` finding — a required
 * foundation missing, disabled, or registered-but-not-installed — returns 1.
 */
export function runVerify(spec: VerifySpec, argv: string[], deps: EdgeVerifyDeps = {}): number {
  const log = deps.log ?? ((l: string) => console.log(l));
  const logError = deps.logError ?? ((l: string) => console.error(l));

  const vault = flagValue(argv, "vault");
  let observed: VaultPlugins;
  try {
    observed = readVaultPlugins(vault);
  } catch (e) {
    if (e instanceof EdgeVerifyError) {
      logError(`✗ ${e.message}`);
      return vault === undefined || vault === "" ? 2 : 1;
    }
    // A real fs fault (permission denied, not-a-directory) — report it in the house format and keep
    // the 0/1/2 contract rather than escaping as an unhandled rejection past main.ts's process.exit.
    logError(`✗ cannot read the vault plugin set in ${vault}: ${e}`);
    return 1;
  }

  const findings = verifyPlugins(observed, spec.contract, spec.edge);
  for (const line of renderFindings(findings)) log(line);
  return findings.some((f) => f.severity === "error") ? 1 : 0;
}
