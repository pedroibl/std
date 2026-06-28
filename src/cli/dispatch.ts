// Story 4.1 — the Tier-1 dispatch core. A consumer supplies a manifest of commands; each command is
// an ordered list of steps that shell out to the consumer's OWN scripts. The dispatcher reimplements
// none of that logic (D3) — it only sequences, honors exit codes, and normalizes the verdict.
//
// Dispatch contract (AD-1 / NFR8): run steps IN ORDER, FAIL-FAST (stop at the first non-zero), with
// SKIP-as-green (a step that exits 0 — whether it did work or skipped itself — is green). Overall exit
// is 0 (all green) or 1 (a step failed); an unknown command name is exit 2.
//
// This is a Bun edge (it spawns a shell), so it may use node:* — only src/core/** is held to D1 purity.
// (Story 4.2 formalizes the manifest as a validated, versioned, serializable config; 4.1 is the spike.)

import { spawnSync } from "node:child_process";

/** One dispatch step: a human label + the shell command to run. Data, never a function value (AD-1). */
export interface Step {
  label: string;
  run: string;
}

/** A named command = an ordered list of steps. */
export interface Command {
  name: string;
  steps: Step[];
}

/** The consumer's manifest of commands. */
export interface Manifest {
  commands: Command[];
}

/** Runs a shell command, returns its exit code. Injected in tests so the sequencing logic stays pure. */
export type Exec = (run: string) => number;

/**
 * Run steps in order, fail-fast, SKIP-as-green. Returns 0 when every step exits 0, else 1 (NFR8).
 * A step's own exit 0 is green whether it did work or skipped itself — the engine never inspects output.
 */
export function dispatchSteps(steps: Step[], exec: Exec): number {
  for (const step of steps) {
    if (exec(step.run) !== 0) return 1; // fail-fast
  }
  return 0;
}

/** Real executor: `zsh -c` with INHERITED stdio, so a consumer's script output passes through verbatim
 *  (the basis for byte-identical Makefile parity, SM4). */
function execShell(run: string): number {
  const r = spawnSync("zsh", ["-c", run], { stdio: "inherit" });
  return r.status ?? 1;
}

/**
 * Dispatch `argv[0]` against the manifest. Returns the command's verdict (0/1), or 2 for an unknown
 * command. `exec` is injectable for tests; production uses the inherited-stdio shell runner.
 */
export function run(argv: string[], manifest: Manifest, exec: Exec = execShell): number {
  const name = argv[0] ?? "";
  const command = manifest.commands.find((c) => c.name === name);
  if (!command) {
    const known = manifest.commands.map((c) => c.name).join(", ");
    console.error(`std: unknown command '${name}'. Known: ${known || "(none)"}`);
    return 2;
  }
  return dispatchSteps(command.steps, exec);
}
