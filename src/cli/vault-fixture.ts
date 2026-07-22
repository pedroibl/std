// Test support for the vault-deploying CLI edges — one builder for a temp dir shaped like an Obsidian vault.
//
// ⚠ WHY THIS IS A MODULE AND NOT A FUNCTION IN A TEST FILE. Since Story 7.3, `cn deploy` runs the
// plugin-envelope contract as a PREFLIGHT, so a bare `mkdir .obsidian` vault — all 7.1 and 7.2 ever
// needed — now aborts with exit 1 and writes nothing. Every temp-vault case in `src/cli/**` therefore
// has to build a contract-satisfying vault, and two test files need it (`cn-deploy.test.ts`,
// `main.test.ts`). Importing one test file from another would re-run its suites, and re-rolling the
// builder twice is how the two copies drift — so it lives here, once.
//
// PARAMETERIZED BY CONTRACT (Story 8.3 AC10 / retro action item 7). It used to hard-code
// `CN_PLUGIN_CONTRACT`; the caller now passes the contract (a plugin list of `{id, observedVersion}`) so
// 8.4's `DASHKIT_PLUGIN_CONTRACT` drops in without touching this file or cn's tests. cn's call sites pass
// theirs explicitly. This story authors NO dashkit contract — only the fixture's shape (D-5).
//
// Not exported from `src/cli/index.ts`: this is not shipped API, it is fixture support that happens to
// need a real module home. It reads nothing and writes only where the caller points it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The minimum a plugin-contract entry must expose for a fixture: an id and its observed (or null) version. */
export interface FixturePluginEntry {
  readonly id: string;
  readonly observedVersion: string | null;
}

/**
 * Create `dir` as an Obsidian vault: `.obsidian/`, a `community-plugins.json` enabling `contract`'s declared
 * plugins, and one `plugins/<id>/manifest.json` per enabled id at its `observedVersion`.
 *
 * `opts.omit` drops ids from the enabled set — omitting a foundation makes an `error` vault.
 * `opts.versions` overrides a manifest version — drifting a foundation makes a `warn` vault.
 */
export function makeVaultFixture(
  dir: string,
  contract: readonly FixturePluginEntry[],
  opts: { omit?: readonly string[]; versions?: Readonly<Record<string, string>> } = {},
): string {
  mkdirSync(join(dir, ".obsidian"), { recursive: true });
  const omit = new Set(opts.omit ?? []);
  const enabled: string[] = [];
  for (const e of contract) {
    if (e.observedVersion === null || omit.has(e.id)) continue;
    enabled.push(e.id);
    const pluginDir = join(dir, ".obsidian", "plugins", e.id);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "manifest.json"),
      JSON.stringify({ id: e.id, version: opts.versions?.[e.id] ?? e.observedVersion }),
    );
  }
  writeFileSync(join(dir, ".obsidian", "community-plugins.json"), JSON.stringify(enabled));
  return dir;
}
