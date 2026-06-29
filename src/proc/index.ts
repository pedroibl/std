// proc — the Bun-edge subprocess primitive (AD-9 plumbing topology).
//
// WHY: across the estate, subprocess wrappers re-implement the same Promise-wrapped
// spawn-with-timeout dance — three near-identical copies (an LLM inference call, a secret
// scanner, a cross-vendor audit). They differ only in cosmetics and in ONE real way: error
// handling. Some never reject; one rejects on launch-failure and nonzero exit. `spawnCapture`
// unifies them on a single **never-reject** contract: the caller inspects `code`, never a catch.
//
// CONSUMER-AGNOSTIC (D4): the command, args, env, and timeout are all caller-supplied. No model
// names, no `ANTHROPIC_*` env-scrub, no baked binary names or timeouts live here — that identity
// stays in the callers. This edge only spawns and captures.

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
  /** Replaces the child's environment verbatim (Bun semantics). Omit to inherit the parent's. */
  env?: Record<string, string>;
}

/** Conventional exit code for a process terminated because it ran past its timeout. */
const TIMEOUT_CODE = 124;
/** Conventional "command not found" code — used when the spawn itself fails to launch. */
const SPAWN_FAILURE_CODE = 127;
/** Generic "terminated by a signal we didn't send" sentinel (128 + signal, collapsed to 128). */
const SIGNALED_CODE = 128;

/**
 * Run `cmd` with `args`, capturing stdout/stderr and the exit code. Bun-edge.
 *
 * **Never rejects (the contract).** The returned promise always resolves — for a clean exit, a
 * nonzero exit, a timeout, AND a launch failure (e.g. the binary is missing). The caller branches
 * on `code`; it never needs a try/catch around this call. Sentinels:
 *   - `124` — the child ran past `opts.timeout` and was SIGTERM'd (stdout/stderr captured so far).
 *   - `127` — the spawn failed to launch (e.g. `ENOENT`); `stderr` holds the error message.
 *   - `128` — the child was terminated by a signal we didn't send (no clean exit code).
 * Real process exit codes (including app-specific ones) pass through verbatim.
 *
 * SIGTERM only on timeout — no SIGKILL escalation; a child that ignores SIGTERM is left to the OS.
 */
export async function spawnCapture(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    // Bun.spawn throws SYNCHRONOUSLY on a missing binary (unlike node's async 'error' event), so the
    // never-reject launch-failure path lives in this catch, not in a stream/exit handler.
    proc = Bun.spawn([cmd, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.env ? { env: opts.env } : {}),
    });
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: SPAWN_FAILURE_CODE,
    };
  }

  // Feed stdin (if any) and always close it, so a reader like `cat` sees EOF and exits instead of
  // blocking forever on an open pipe.
  if (opts.stdin !== undefined) proc.stdin.write(opts.stdin);
  proc.stdin.end();

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeout !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, opts.timeout);
  }

  // Draining both streams to text waits for the process to finish writing (i.e. to exit).
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  if (timer !== undefined) clearTimeout(timer);

  // exitCode is null when the process was terminated by a signal; coalesce to a numeric sentinel so
  // the `code: number` contract holds (124 if WE timed it out, 128 for any other signal kill).
  const code = timedOut ? TIMEOUT_CODE : (proc.exitCode ?? SIGNALED_CODE);
  return { stdout, stderr, code };
}
