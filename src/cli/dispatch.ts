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
    default:
      // Unreachable at runtime — validate() rejects any kind outside STEP_KINDS before dispatch. The
      // `never` assignment makes a missing case a COMPILE error the day Story 4.4 adds the `adapter` kind.
      return assertNever(step.kind);
  }
}

/** Exhaustiveness guard: a compile error if a `StepKind` is added without a `stepVerdict` case. */
function assertNever(kind: never): never {
  throw new Error(`std: unhandled step kind '${String(kind)}'`);
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

/** The parsed argv: the (first) command name + the recognized flags. Story 4.3 extends 4.2's lone
 *  `--keep-going` to `--help`/`--json`, stripped here so they can never be mistaken for a command. */
export interface ParsedArgs {
  command: string;
  keepGoing: boolean;
  help: boolean;
  json: boolean;
}

/**
 * Parse argv into a command + flags. The first non-`--` token is the command; recognized flags are
 * stripped (Task 2.2). Unknown `--flags` are ignored (forward-compatible, and keeps the SM4 parity
 * surface stable — the engine never branches on a flag it doesn't know).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let command = "";
  let keepGoing = false;
  let help = false;
  let json = false;
  for (const a of argv) {
    if (a === "--keep-going") keepGoing = true;
    else if (a === "--help") help = true;
    else if (a === "--json") json = true;
    else if (!a.startsWith("--") && command === "") command = a;
  }
  return { command, keepGoing, help, json };
}

/**
 * Render `--help` PURELY from the validated manifest (AC2) — no hand-kept command text. With no (or an
 * unknown) command name: the full menu of command names. With a known command: its name + ordered step
 * labels. A short flag footer is the only static text (it documents the engine's flags, not the menu).
 */
export function formatHelp(manifest: Manifest, name?: string): string {
  const command = name ? manifest.commands.find((c) => c.name === name) : undefined;
  if (command) {
    const lines = [`std ${command.name} — ${command.steps.length} step(s):`];
    for (const s of command.steps) lines.push(`  ${s.label}`);
    return lines.join("\n");
  }
  const lines = ["std — commands:"];
  for (const c of manifest.commands) lines.push(`  ${c.name}`);
  lines.push("", "flags: --keep-going  --json  --help");
  return lines.join("\n");
}

/** The `--json` payload shape (AC2): command name, per-step results, overall verdict, and exit code. */
export interface JsonResult {
  command: string;
  steps: Array<{ label: string; verdict: Verdict }>;
  verdict: Verdict;
  exit: number;
}

/** Build the `--json` payload from a dispatch result. Pure — kept separate from `run` so the stable
 *  output SHAPE is unit-testable without capturing stdout. */
export function jsonResult(command: string, result: DispatchResult): JsonResult {
  return {
    command,
    steps: result.steps,
    verdict: result.verdict,
    exit: verdictToExit(result.verdict),
  };
}

/**
 * Real executor factory: `zsh -c <run>`. In human mode stdio is fully INHERITED, so a consumer's script
 * output passes through verbatim (the basis for byte-identical Makefile parity, SM4). In `quiet` mode
 * (used by `--json`) the child's stdout is redirected to the parent's STDERR, so std's final JSON line is
 * the ONLY thing on stdout — `--json` stays machine-parseable while step diagnostics still surface on
 * stderr. (Quiet mode never runs on the SM4 path; the shim invokes commands without `--json`.)
 */
function makeShellExec(quiet: boolean): Exec {
  const stdio: Array<"inherit" | number> = quiet ? ["inherit", 2, 2] : ["inherit", "inherit", "inherit"];
  return (run) => spawnSync("zsh", ["-c", run], { stdio }).status ?? 1;
}

/**
 * Dispatch `argv` against the manifest. Parses flags (`--keep-going`/`--help`/`--json`), then the first
 * non-flag token is the command name. `--help` prints the menu (or a command's steps) and exits 0.
 * Otherwise the command runs; with `--json` the machine-readable result is emitted to stdout (the steps
 * still run, so their inherited-stdio output passes through — in human mode that passthrough IS the
 * output, no summary is printed: SM4 byte-parity). Returns the exit code (0/1), or 2 for an unknown
 * command. `exec` is injectable for tests; in production the shell runner is chosen by `--json` (quiet,
 * so stdout carries only the JSON) vs human mode (full passthrough).
 */
export function run(argv: string[], manifest: Manifest, exec?: Exec): number {
  const { command: name, keepGoing, help, json } = parseArgs(argv);

  if (help) {
    console.log(formatHelp(manifest, name || undefined));
    return 0;
  }

  const command = manifest.commands.find((c) => c.name === name);
  if (!command) {
    const known = manifest.commands.map((c) => c.name).join(", ");
    console.error(`std: unknown command '${name}'. Known: ${known || "(none)"}`);
    return 2;
  }

  const runner = exec ?? makeShellExec(json);
  const result = dispatchSteps(command.steps, runner, { keepGoing });
  if (json) console.log(JSON.stringify(jsonResult(command.name, result)));
  return verdictToExit(result.verdict);
}
