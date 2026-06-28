// Story 4.2 — the manifest contract. A consumer authors a `std.config.ts` (executable TypeScript), but
// before the dispatcher touches it the manifest must reduce to inert, validated, SERIALIZABLE data — no
// function values, no smuggled load-time computation (AD-1). This module owns that reduction: the typed
// shape (`defineConfig`), the whole-at-load fail-closed `validate`, and zero-config `discover`/`load`.
//
// Versioned (AD-4): the manifest carries a `schemaVersion` literal the loader checks; validation is
// whole-manifest, at load, fail-closed — any breach aborts the run, never a partial/degraded one.
//
// This is a Bun edge (it reads the filesystem + dynamic-imports the config), so it may use node:* — only
// src/core/** is held to D1 purity. It bakes in NO consumer identity (D4/NFR3): discovery walks the dir
// tree generically; the only literal path is std's OWN global config home.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The manifest schema version. Bumped only on a breaking change (additive-only is the default, AD-4). */
export const SCHEMA_VERSION = 1 as const;

/** The outcome enum the runner branches on. SKIP is first-class — an absent capability is green, not red
 *  (its producer is the adapter self-disable in Story 4.4; `exec` steps yield only pass/fail today). */
export type Verdict = "pass" | "fail" | "skip";

/** The closed set of step kinds the runner dispatches on (NFR3 assertion 3). One member today; the
 *  `adapter` kind is the sanctioned 2nd member, added by Story 4.4 via the Rule-of-Three move (AD-1). */
export const STEP_KINDS = ["exec"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** One step: a kind the runner branches on + a human label + the shell command. Data, never a function. */
export interface Step {
  kind: StepKind;
  label: string;
  run: string;
}

/** A named command = an ordered list of steps. */
export interface Command {
  name: string;
  steps: Step[];
}

/** The consumer's manifest: a version literal + the commands. Reduces to pure serializable data. */
export interface Manifest {
  schemaVersion: typeof SCHEMA_VERSION;
  commands: Command[];
}

/** Identity helper so a consumer authors `std.config.ts` with full type-checking. Returns its argument. */
export function defineConfig(manifest: Manifest): Manifest {
  return manifest;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Recursively assert no value is a function — the AD-1 "no smuggled load-time computation" guard. A
 * function anywhere in the projection means the config tried to ship logic, not data; reject it loud.
 */
function assertNoFunctions(value: unknown, path: string): void {
  if (typeof value === "function") {
    throw new Error(`std.config: function value at ${path} — the manifest must be serializable data (AD-1)`);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoFunctions(v, `${path}[${i}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) assertNoFunctions(v, `${path}.${k}`);
  }
}

function validateStep(raw: unknown, path: string): Step {
  if (!isRecord(raw)) throw new Error(`std.config: ${path} must be an object`);
  if (typeof raw.kind !== "string" || !(STEP_KINDS as readonly string[]).includes(raw.kind)) {
    throw new Error(`std.config: ${path}.kind must be one of ${STEP_KINDS.join(" | ")} — got ${String(raw.kind)}`);
  }
  if (typeof raw.label !== "string") throw new Error(`std.config: ${path}.label must be a string`);
  if (typeof raw.run !== "string") throw new Error(`std.config: ${path}.run must be a string`);
  return { kind: raw.kind as StepKind, label: raw.label, run: raw.run };
}

function validateCommand(raw: unknown, path: string): Command {
  if (!isRecord(raw)) throw new Error(`std.config: ${path} must be an object`);
  if (typeof raw.name !== "string") throw new Error(`std.config: ${path}.name must be a string`);
  if (!Array.isArray(raw.steps)) throw new Error(`std.config: ${path}.steps must be an array`);
  return { name: raw.name, steps: raw.steps.map((s, i) => validateStep(s, `${path}.steps[${i}]`)) };
}

/**
 * Validate a raw config WHOLE, at load, FAIL-CLOSED (AD-4): any breach throws with the offending path.
 * The returned manifest is rebuilt from only the validated primitive fields — so the projection is, by
 * construction, pure serializable data (NFR3 assertion 1): any extra/function properties are dropped.
 */
export function validate(raw: unknown): Manifest {
  if (!isRecord(raw)) throw new Error("std.config: manifest must be an object");
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`std.config: schemaVersion must be ${SCHEMA_VERSION} — got ${String(raw.schemaVersion)}`);
  }
  if (!Array.isArray(raw.commands)) throw new Error("std.config: 'commands' must be an array");
  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION,
    commands: raw.commands.map((c, i) => validateCommand(c, `commands[${i}]`)),
  };
  assertNoFunctions(manifest, "manifest"); // belt-and-suspenders on the rebuilt projection
  return manifest;
}

/** std's OWN global config home — the only sanctioned literal path (no consumer identity, D4). Honors
 *  `XDG_CONFIG_HOME` (the platform convention), falling back to `~/.config`. */
export function globalConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "std", "config.ts");
}

/**
 * Zero-config discovery (NFR8): walk UP from `startDir` to the git toplevel, returning the first
 * `std.config.ts` found. Stops at the repo root (a dir containing `.git`) or the filesystem root — it
 * never walks past the repo. Returns null when none is found. Pure dir-tree walk, no consumer identity.
 *
 * Note: `.git` is matched by mere existence, NOT `isDirectory()` — a git worktree or submodule has a
 * `.git` FILE (a gitdir pointer), and that is still a legitimate repo toplevel we must stop at.
 */
export function discover(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "std.config.ts");
    if (existsSync(candidate)) return candidate;
    const atToplevel = existsSync(join(dir, ".git")); // file OR dir — worktrees use a .git file
    const parent = dirname(dir);
    if (atToplevel || parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the config path: repo-local `std.config.ts` (discovered from `startDir`) takes precedence;
 * otherwise the global `~/.config/std/config.ts` if it exists; else null.
 */
export function resolveConfigPath(startDir: string): string | null {
  const local = discover(startDir);
  if (local) return local;
  const global = globalConfigPath();
  return existsSync(global) ? global : null;
}

/**
 * Load + validate a config module at `path`. The module's default export (or a named `config` export,
 * or the module itself) is run through `validate` — fail-closed. Async because it dynamic-imports.
 */
export async function load(path: string): Promise<Manifest> {
  const mod = (await import(path)) as { default?: unknown; config?: unknown };
  const raw = mod.default ?? mod.config ?? mod;
  return validate(raw);
}
