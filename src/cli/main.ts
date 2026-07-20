#!/usr/bin/env bun
// std — the CLI entrypoint (exposed as the `std` bin via `bun link`). Dispatches std built-ins; today
// that's `alias --install` (the AD-7 repo-nav + completion generator). Bun edge — fs/os/path/env ok.
//
// Identity-free (D4/NFR3): the registry path is std's OWN global config home; the ZDOTDIR target comes
// from `$ZDOTDIR`/the XDG default; the frozen set (if any) is read from the user's repos.ts, never baked
// in. `runMain` takes injected paths so the dispatch is unit-testable without touching the real config.

import { homedir } from "node:os";
import { join } from "node:path";

import { runCnDeploy } from "./cn-deploy";
import { RepoNavError, defaultTargets, installAlias, type RepoConfig } from "./repo-nav";

/** std's own global registry path (XDG-aware), the SoT `alias --install` reads. */
export function globalReposPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "std", "repos.ts");
}

/** The live zsh config root the generator deploys into (`$ZDOTDIR`, else the XDG default). */
function defaultZdotdir(): string {
  return process.env.ZDOTDIR || join(homedir(), ".config", "zsh");
}

/** Injected paths/sink — defaulted to the real environment by the bin, overridden in tests. */
export interface MainDeps {
  reposPath?: string;
  zdotdir?: string;
  log?: (line: string) => void;
}

/** Top-level usage. A single hand-maintained constant — keep it in sync when commands change. */
export const HELP = `std — Pedro's standard CLI

usage: std <command> [options]

commands:
  alias --install   (re)generate repo-nav + the _std completion from ~/.config/std/repos.ts
  cn deploy         bundle src/cn -> <vault>/Scripts/cn.js (one-way; the vault is build output only)

cn deploy options:
  --vault <dir>     the Obsidian vault to deploy into (required — std bakes in no vault path)
  --format <fmt>    bundle format: esm (default) or cjs

flags:
  -h, --help        show this help`;

/**
 * Dispatch `std <command>`. Returns a process exit code (0 ok, 1 fail-loud, 2 usage/unknown). The bin
 * does `process.exit(runMain(...))`. `-h`/`--help` (or no command) print usage; `alias --install`
 * imports the registry, generates repo-nav + the `_std` completion, and deploys (fail-closed).
 */
export async function runMain(argv: string[], deps: MainDeps = {}): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const [cmd, ...rest] = argv;

  if (cmd === "-h" || cmd === "--help") {
    log(HELP);
    return 0;
  }
  if (cmd === undefined) {
    log(HELP);
    return 2; // no command — show help, but signal an incomplete invocation
  }

  if (cmd === "cn") {
    return await runCnDeploy(rest, { log });
  }

  if (cmd === "alias") {
    if (!rest.includes("--install")) {
      log("usage: std alias --install   # regenerate repo-nav + _std from ~/.config/std/repos.ts");
      return 2;
    }
    const reposPath = deps.reposPath ?? globalReposPath();
    let config: RepoConfig | undefined;
    try {
      // Import the user's OWN config (the standard TS-config pattern, like vite/eslint configs and
      // std's own config.load) — trusted input from their XDG home, not external/untrusted data.
      const mod = (await import(reposPath)) as { default?: RepoConfig; config?: RepoConfig };
      config = mod.default ?? mod.config;
    } catch {
      console.error(`std: cannot read registry at ${reposPath} — create it (a RepoConfig default export)`);
      return 1;
    }
    if (!config) {
      console.error(`std: ${reposPath} has no default export (expected a RepoConfig)`);
      return 1;
    }
    try {
      const res = installAlias({
        config,
        commands: ["alias"],
        targets: defaultTargets(deps.zdotdir ?? defaultZdotdir()),
        frozenNames: new Set(config.frozen ?? []),
      });
      log(`✓ repo-nav → ${res.repoNavPath}`);
      log(`✓ _std     → ${res.completionPath}`);
      return 0;
    } catch (e) {
      if (e instanceof RepoNavError) {
        console.error(`✗ ${e.message}`);
        return 1;
      }
      throw e; // unexpected — fail loud, never swallow (FR5)
    }
  }

  console.error(`std: unknown command '${cmd ?? ""}'. Known: alias, cn`);
  return 2;
}

if (import.meta.main) {
  runMain(process.argv.slice(2)).then((code) => process.exit(code));
}
