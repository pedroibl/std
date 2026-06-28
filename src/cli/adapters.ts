// Story 4.4 — the review-adapter runtime (the one new logic home AD-1 permits beyond `exec`).
//
// An `adapter` step NAMES a member of the closed, std-owned `ReviewAdapter` set (config selects, never
// supplies — AC3). This module owns what each name MEANS. The contract that earns 4.2's first-class SKIP:
// when a selected adapter's tool/credential is ABSENT, it self-disables → `skip` (green, exit 0), NEVER a
// 127-red (AC1). "review didn't run because sourcery isn't installed" is fine; "review crashed" is not.
//
// This is a Bun edge (it probes PATH + spawns the tool), so it may use node:* — core stays pure (D1).

import { spawnSync } from "node:child_process";

import { type ReviewAdapter, type Verdict } from "./config";

/** Is the adapter's tool usable (binary on PATH + any required credential)? Injected in tests so the
 *  absent/present paths are unit-testable without a real sourcery install. */
export type Capability = (adapter: ReviewAdapter) => boolean;

/** Run the adapter's tool; return its process exit code. Injected in tests. */
export type AdapterExec = (adapter: ReviewAdapter) => number;

/** Resolve an adapter NAME to a Verdict — the full adapter contract. Injected wherever the runner needs
 *  to evaluate an `adapter` step. */
export type AdapterResolver = (adapter: ReviewAdapter) => Verdict;

/**
 * The core adapter decision (AC1), pure given its injected `cap`/`exec`:
 *   • `none`        → always SKIP (an explicit no-op reviewer).
 *   • `coderabbit`  → SKIP (named-but-deferred — a member of the closed set so the contract is stable,
 *                     but its behavior lands in its own story; we do NOT fake it).
 *   • `sourcery`    → probe; ABSENT → SKIP (self-disable, never 127); PRESENT → run, 0→pass else fail.
 * `assertNever` makes adding a `ReviewAdapter` member without a branch a COMPILE error.
 */
export function adapterVerdict(adapter: ReviewAdapter, cap: Capability, exec: AdapterExec): Verdict {
  switch (adapter) {
    case "none":
      return "skip";
    case "coderabbit":
      return "skip";
    case "sourcery":
      if (!cap(adapter)) return "skip"; // tool/cred absent → self-disable, NOT a 127-red
      return exec(adapter) === 0 ? "pass" : "fail";
    default:
      return assertNever(adapter);
  }
}

function assertNever(adapter: never): never {
  throw new Error(`std: unhandled review adapter '${String(adapter)}'`);
}

/** Does `bin` resolve to an executable? A missing binary makes spawnSync set `.error` (ENOENT) with a
 *  null status — that's the ABSENT signal. A present binary runs (any exit code) → available. */
function onPath(bin: string): boolean {
  const r = spawnSync(bin, ["--version"], { stdio: "ignore" });
  return !r.error && r.status != null;
}

/**
 * Production capability probe. `sourcery` needs both its binary AND a credential (`SOURCERY_CLI_TOKEN`,
 * the same env the consumer's Sourcery flow reads); either absent ⇒ unavailable ⇒ SKIP. The deferred/none
 * members never reach here (handled before the probe in `adapterVerdict`).
 */
export function defaultCapability(adapter: ReviewAdapter): boolean {
  if (adapter === "sourcery") return onPath("sourcery") && Boolean(process.env.SOURCERY_CLI_TOKEN);
  return false;
}

/** Production adapter exec — the std-OWNED invocation per reviewer (config can't influence it, AC3).
 *  `sourcery`: a non-mutating `review --check` over the repo root. Others never reach here. */
export function defaultAdapterExec(adapter: ReviewAdapter): number {
  if (adapter === "sourcery") {
    return spawnSync("sourcery", ["review", "--check", "."], { stdio: "inherit" }).status ?? 1;
  }
  return 0;
}

/** The production resolver: probe + run, wired with the real capability/exec. */
export const resolveAdapter: AdapterResolver = (adapter) =>
  adapterVerdict(adapter, defaultCapability, defaultAdapterExec);
