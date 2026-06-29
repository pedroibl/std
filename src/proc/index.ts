// proc — the Bun-edge subprocess primitive (AD-9 plumbing topology).
//
// WHY: across the estate, subprocess wrappers re-implement the same Promise-wrapped
// spawn-with-timeout dance — three near-identical copies (an LLM inference call, a secret
// scanner, a cross-vendor audit). They differ only in cosmetics and in ONE real way: error
// handling. Some never reject; one rejects on launch-failure and nonzero exit. `spawnCapture`
// unifies them on a single **never-reject** contract: the caller inspects `code`, never a catch.
//
// RUNTIME: `node:child_process` (not `Bun.spawn`), the same primitive `glab` uses and the exact
// pattern the three target consumers use — so this is a true superset. The choice is load-bearing,
// not stylistic: the contract demands (a) the call RESOLVES at the timeout even if the child traps
// SIGTERM (a `Bun.spawn` read-stream-to-EOF model HANGS there — verified), and (b) signal-aware exit
// codes (`128 + signo`), which Bun reports as a flat `128`. The EventEmitter model — accumulate via
// `data`, resolve once on the first of {close, timeout, error} — gives both for free.
//
// CONSUMER-AGNOSTIC (D4): the command, args, env, and timeout are all caller-supplied. No model
// names, no `ANTHROPIC_*` env-scrub, no baked binary names or timeouts live here — that identity
// stays in the callers. This edge only spawns and captures.

import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { constants } from "node:os";

/** What `spawnCapture` resolves with. `code` is always a `number` — never `null`. */
export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Caller-supplied knobs. Everything is optional; nothing carries consumer identity. */
export interface SpawnOptions {
  /** Written to the child's stdin, which is then closed. Avoids ARG_MAX for large inputs. */
  stdin?: string;
  /** Milliseconds before the child is SIGTERM'd and the call resolves with `code: 124`. */
  timeout?: number;
  /** Sets the child's environment (node semantics). Omit to inherit the parent's. */
  env?: Record<string, string>;
}

/** Conventional exit code for a process terminated because it ran past its timeout. */
const TIMEOUT_CODE = 124;
/** Conventional "command not found" code — used when the spawn itself fails to launch. */
const SPAWN_FAILURE_CODE = 127;
/** Base for "terminated by a signal" exit codes — the shell `128 + signal-number` convention. */
const SIGNAL_BASE = 128;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Map a node `close` `(code, signal)` pair to a single numeric exit code (`128 + signo` for signals). */
function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) return SIGNAL_BASE + (constants.signals[signal] ?? 0);
  return SIGNAL_BASE;
}

/**
 * Run `cmd` with `args`, capturing stdout/stderr and the exit code.
 *
 * **Never rejects, never hangs (the contract).** The returned promise always resolves — for a clean
 * exit, a nonzero exit, a timeout, a launch failure, or a signal kill. The caller branches on `code`;
 * it never needs a try/catch around this call. Sentinels:
 *   - `124` — the child ran past `opts.timeout` and was SIGTERM'd. Resolves AT the timeout with the
 *     output captured so far, even if the child ignores SIGTERM (it is then left to the OS).
 *   - `127` — the spawn failed to launch (e.g. `ENOENT`); `stderr` holds the error message.
 *   - `128 + signo` — the child was terminated by a signal with no clean exit code (e.g. `130` for
 *     SIGINT, `143` for SIGTERM).
 * Real process exit codes (including app-specific ones) pass through verbatim.
 *
 * SIGTERM only on timeout — no SIGKILL escalation; a child that ignores SIGTERM is left to the OS.
 */
export function spawnCapture(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // The single resolution point. Guarded so the FIRST of {close, timeout, error} wins atomically —
    // a later callback is a no-op. This closes the timeout-vs-completion race and the timer leak:
    // every terminal path goes through here, and here always clears the timer.
    const finish = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    const options: SpawnOptionsWithoutStdio = opts.env ? { env: opts.env } : {};
    let child;
    try {
      child = spawn(cmd, args, options);
    } catch (err) {
      // node usually defers ENOENT to the async 'error' event, but bad args can throw synchronously.
      finish({ stdout: "", stderr: message(err), code: SPAWN_FAILURE_CODE });
      return;
    }

    // Launch failure (ENOENT / EACCES …) arrives here, asynchronously. Never reject — resolve 127.
    child.on("error", (err) => {
      finish({ stdout, stderr: stderr + message(err), code: SPAWN_FAILURE_CODE });
    });

    // Accumulate continuously so a timeout can resolve IMMEDIATELY with whatever has arrived, without
    // waiting for stream EOF (the read-to-EOF approach hangs when a child ignores SIGTERM).
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    child.on("close", (code, signal) => {
      finish({ stdout, stderr, code: exitCodeOf(code, signal) });
    });

    // stdin: an 'error' listener is REQUIRED — an EPIPE on a child that already closed its stdin is
    // emitted as an unhandled stream error (which would crash/reject) unless caught here; the sync
    // write/end can also throw EPIPE. Both are swallowed: a vanished stdin is not our failure.
    child.stdin.on("error", () => {});
    try {
      if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
      child.stdin.end();
    } catch {
      /* child closed stdin early — ignore, never reject */
    }

    if (opts.timeout !== undefined) {
      timer = setTimeout(() => {
        child.kill("SIGTERM"); // SIGTERM only, no SIGKILL escalation (AC4)
        finish({ stdout, stderr, code: TIMEOUT_CODE });
      }, opts.timeout);
    }
  });
}
