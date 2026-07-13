// args — pure argv-parsing vocabulary: `string[]` in, value out. Promoted from `glab/args.ts`
// (Story 10.1) so the hand-rolled parsers scattered across the estate share one tested definition.
//
// PURE (D1/NFR1): no `node:*`, no fs/DOM/network, no `process`/`document`, no I/O. `process.argv` and
// `process.exit` stay at the EDGE (the CLI wrapper that calls these) — core only transforms values.

/** First non-`--` token (e.g. a positional issue number). Empty string when there is none. */
export function positional(args: string[]): string {
  return args.find((a) => !a.startsWith("--")) ?? "";
}

/**
 * Value of a `--name` flag, supporting BOTH forms:
 *   `--name value`   (space form — returns the following token)
 *   `--name=value`   (equals form — returns the substring after `=`)
 * Returns `undefined` when the flag is absent, or when a space-form `--name` is the last token (no
 * value follows). `--name=` (empty equals) returns `""` — distinguishable from absent. The equals form
 * is checked first, so it wins if both appear for the same name.
 */
export function flagValue(args: string[], name: string): string | undefined {
  const eq = `--${name}=`;
  const hit = args.find((a) => a.startsWith(eq));
  if (hit !== undefined) return hit.slice(eq.length);
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

/** True if the boolean `--name` flag is present (bare form). */
export function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

/**
 * Look up `cmd` in a command→handler map and run the match, returning its exit code. Unknown commands
 * route to `onUnknown(cmd)`, supplied by the EDGE — which owns the usage message + its own exit code
 * (the unknown name is passed in, so the caller need not close over `cmd` to build the error). `dispatch`
 * ALWAYS returns a number and never conflates "no such command" with a handler's own return value (so a
 * handler may legitimately return any code). Pure: no console, no process, no exit — the only side
 * effects are whatever the caller's handlers / `onUnknown` do. `Object.hasOwn` ensures inherited
 * prototype keys (`constructor`, `toString`, …) are never run as handlers — they fall through to
 * `onUnknown`. Handlers are synchronous and return a number; when the handlers do async work (network,
 * fs), use `dispatchAsync` (the sibling below), which the D2 "when a real consumer needs it" note that
 * used to sit here has since earned.
 */
export function dispatch(
  cmd: string,
  handlers: Record<string, () => number>,
  onUnknown: (cmd: string) => number,
): number {
  return Object.hasOwn(handlers, cmd) ? handlers[cmd]() : onUnknown(cmd);
}

/**
 * Async sibling of `dispatch` — identical routing, for CLIs whose subcommands do awaited work (an HTTP
 * call, an fs walk). Promoted in Epic 17 after every non-trivial extracted CLI hand-rolled this exact
 * `Object.hasOwn`-keyed async switch because `dispatch` was sync-only (the deferred consumer the sync
 * doc anticipated arrived ≥8× over across the 12.5 sweep).
 *
 * Semantics mirror `dispatch` byte-for-byte, only the value type changes: handlers return
 * `Promise<number>`, and the returned promise resolves to the matched handler's exit code, or to
 * `onUnknown(cmd)`'s. `onUnknown` may be sync OR async (`Promise<number> | number`) — a plain
 * `console.error(...); return 1` edge handler is accepted unchanged, and `await` on a bare number is a
 * no-op, so callers need not wrap it. Own-property lookup only, so inherited prototype keys
 * (`constructor`, `toString`, …) still fall through to `onUnknown`. Pure: no console, no process, no
 * exit — side effects are whatever the caller's handlers / `onUnknown` do.
 */
export async function dispatchAsync(
  cmd: string,
  handlers: Record<string, () => Promise<number>>,
  onUnknown: (cmd: string) => Promise<number> | number,
): Promise<number> {
  return Object.hasOwn(handlers, cmd) ? handlers[cmd]() : onUnknown(cmd);
}
