#!/usr/bin/env bun
// std — the CLI entrypoint (exposed as the `std` bin via `bun link`). Dispatches std built-ins; today
// that's `alias --install` (the AD-7 repo-nav + completion generator). Bun edge — fs/os/path/env ok.
//
// Identity-free (D4/NFR3): the registry path is std's OWN global config home; the ZDOTDIR target comes
// from `$ZDOTDIR`/the XDG default; the frozen set (if any) is read from the user's repos.ts, never baked
// in. `runMain` takes injected paths so the dispatch is unit-testable without touching the real config.

import { homedir } from "node:os";
import { join } from "node:path";

import { runBmad } from "../bmad/cli";
import { type CnDeployDeps, runCnDeploy } from "./cn-deploy";
import { runCnVerify } from "./cn-verify";
import { runDashkitDeploy } from "./dashkit-deploy";
import { runDashkitVerify } from "./dashkit-verify";
import { runNotekitDeploy } from "./notekit-deploy";
import { RepoNavError, defaultTargets, installAlias, type RepoConfig } from "./repo-nav";
import { SURFACE, renderAliasUsage, renderHelp } from "./surface";

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
  /** Overrides the SIGINT registration for `cn deploy --watch` (tests pass a no-op / a capture). */
  onWatchStart?: (stop: () => void) => void;
  /** Overrides the real file watcher, so the resident branch is testable without touching fs.watch. */
  watch?: CnDeployDeps["watch"];
}

/**
 * Top-level usage — RENDERED from the one surface model (3.1), no longer a hand-maintained literal whose
 * only drift protection was a comment. The export name and its bytes are unchanged: `main.test.ts` holds
 * a frozen copy of the shipped text and asserts byte-identity.
 */
export const HELP = renderHelp(SURFACE);

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
    // `verify` is synchronous and shares nothing with the deploy path but the `--vault` flag, so it
    // dispatches here rather than inside runCnDeploy (whose own usage line owns `deploy` only).
    if (rest[0] === "verify") return runCnVerify(rest.slice(1), { log });
    // SIGINT is registered HERE, at the callsite, and does nothing but call `stop()` — never inside
    // `runWatch`, or the loop could not be unit-tested without installing a real signal handler (and a
    // `process.exit` reachable from a test kills the test runner). `deps.onWatchStart` is only invoked
    // when `--watch` actually goes resident, so the one-shot path installs no handler.
    return await runCnDeploy(rest, {
      log,
      onWatchStart: deps.onWatchStart ?? ((stop) => process.on("SIGINT", stop)),
      watch: deps.watch,
    });
  }

  if (cmd === "dashkit") {
    // `verify` is synchronous and shares nothing with the deploy path but the `--vault` flag, so it
    // dispatches here rather than inside runDashkitDeploy (whose own usage line owns `deploy` only) —
    // exactly as `cn verify` does (8.4).
    if (rest[0] === "verify") return runDashkitVerify(rest.slice(1), { log });
    // SIGINT is registered HERE, at the callsite, exactly as for cn — never inside `runWatch` (a signal
    // handler or `process.exit` reachable from a test kills the test runner). `deps.onWatchStart` fires only
    // when `--watch` goes resident, so the one-shot path installs no handler.
    return await runDashkitDeploy(rest, {
      log,
      onWatchStart: deps.onWatchStart ?? ((stop) => process.on("SIGINT", stop)),
      watch: deps.watch,
    });
  }

  if (cmd === "notekit") {
    // No `verify` arm, and its absence is the ⚠️-2 decision made visible: notekit's plugin contract and
    // `notekit verify`/`doctor` are FR18 (Epic 3), so v1 registers `deploy` only. A `notekit verify`
    // typed today falls through to runNotekitDeploy's own usage line and exits 2, which is the right
    // answer for a subcommand that does not exist yet.
    //
    // SIGINT is registered HERE, at the callsite, exactly as for cn and dashkit — never inside
    // `runWatch` (a signal handler or `process.exit` reachable from a test kills the test runner).
    // `deps.onWatchStart` fires only when `--watch` goes resident, so the one-shot path installs no
    // handler.
    return await runNotekitDeploy(rest, {
      log,
      onWatchStart: deps.onWatchStart ?? ((stop) => process.on("SIGINT", stop)),
      watch: deps.watch,
    });
  }

  if (cmd === "bmad") {
    // The `bmad-manager` family (BM-1). Registered HERE, beside cn/dashkit — deliberately NOT in
    // `dispatch.ts`, which is the generic engine for shelling a CONSUMER's Step[] and is off-limits to
    // std's own command logic. `runBmad` owns its own subcommand routing and defaults `deps` to
    // `defaultBmadDeps()`, so `MainDeps` needs no new field (a `MainDeps` is not a `BmadDeps`).
    return await runBmad(rest);
  }

  if (cmd === "alias") {
    if (!rest.includes("--install")) {
      log(renderAliasUsage(SURFACE)); // R-3: one statement of this line, in the model (AC9)
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
        surface: SURFACE, // D-a closed: the completer now sees every command, not a hardcoded literal
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

  console.error(`std: unknown command '${cmd ?? ""}'. Known: alias, cn, dashkit, notekit, bmad`);
  return 2;
}

if (import.meta.main) {
  runMain(process.argv.slice(2)).then((code) => process.exit(code));
}
