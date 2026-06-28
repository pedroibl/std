// Story 4.1 → 4.2 — the Tier-1 dispatch core. A consumer supplies a manifest (validated, versioned,
// serializable — see config.ts); each command is an ordered list of steps that shell out to the
// consumer's OWN scripts. The dispatcher reimplements none of that logic (D3) — it sequences, branches
// ONLY on the `kind`/`verdict` enums (never on entry content — NFR3 assertion 3), and normalizes exit.
//
// Dispatch contract (AD-1 / NFR8): run steps IN ORDER, FAIL-FAST by default (stop at the first `fail`),
// with `--keep-going` to run them all and aggregate. SKIP is a first-class verdict (green). Overall exit
// is 0 (pass/skip) or 1 (a step failed); an unknown command name is exit 2.
//
// This is a Bun edge (it spawns a shell), so it may use node:* — only src/core/** is held to D1 purity.

import { spawnSync } from "node:child_process";

import type { Manifest, Step, Verdict } from "./config";

/** Runs a shell command, returns its exit code. Injected in tests so the sequencing logic stays pure. */
export type Exec = (run: string) => number;

/** The verdict + ordered per-step results of dispatching a command. */
export interface DispatchResult {
  verdict: Verdict;
  steps: Array<{ label: string; verdict: Verdict }>;
}

/** Options for a dispatch run. `keepGoing` overrides the default fail-fast (NFR8). */
export interface DispatchOptions {
  keepGoing?: boolean;
}

/**
 * Resolve a single step to a Verdict by branching ONLY on its `kind` enum (NFR3 assertion 3) — the
 * engine never inspects `run`/`label` content to decide control flow. An `exec` step's exit code maps
 * 0 → pass, non-zero → fail. (The `skip` verdict's producer is the adapter kind, Story 4.4.)
 */
export function stepVerdict(step: Step, exec: Exec): Verdict {
  switch (step.kind) {
    case "exec":
      return exec(step.run) === 0 ? "pass" : "fail";
  }
}

/**
 * Run steps in order. Default fail-fast: stop at the first `fail`. With `keepGoing`, run them all and
 * aggregate — overall `fail` if any step failed, else `pass`. SKIP never fails the aggregate (NFR8).
 */
export function dispatchSteps(steps: Step[], exec: Exec, opts: DispatchOptions = {}): DispatchResult {
  const results: DispatchResult["steps"] = [];
  let overall: Verdict = "pass";
  for (const step of steps) {
    const verdict = stepVerdict(step, exec);
    results.push({ label: step.label, verdict });
    if (verdict === "fail") {
      overall = "fail";
      if (!opts.keepGoing) break; // fail-fast
    }
  }
  return { verdict: overall, steps: results };
}

/** Map a command verdict to a process exit code (NFR8): pass/skip → 0, fail → 1. */
export function verdictToExit(verdict: Verdict): number {
  return verdict === "fail" ? 1 : 0;
}

/** Real executor: `zsh -c` with INHERITED stdio, so a consumer's script output passes through verbatim
 *  (the basis for byte-identical Makefile parity, SM4). */
function execShell(run: string): number {
  const r = spawnSync("zsh", ["-c", run], { stdio: "inherit" });
  return r.status ?? 1;
}

/**
 * Dispatch `argv` against the manifest. Parses `--keep-going` (override fail-fast), then the first
 * non-flag token is the command name. Returns the command's exit code (0/1), or 2 for an unknown command.
 * `exec` is injectable for tests; production uses the inherited-stdio shell runner.
 */
export function run(argv: string[], manifest: Manifest, exec: Exec = execShell): number {
  const keepGoing = argv.includes("--keep-going");
  const name = argv.find((a) => !a.startsWith("--")) ?? "";
  const command = manifest.commands.find((c) => c.name === name);
  if (!command) {
    const known = manifest.commands.map((c) => c.name).join(", ");
    console.error(`std: unknown command '${name}'. Known: ${known || "(none)"}`);
    return 2;
  }
  return verdictToExit(dispatchSteps(command.steps, exec, { keepGoing }).verdict);
}
