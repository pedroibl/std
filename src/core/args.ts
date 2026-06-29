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
 * Look up `cmd` in a command→handler map and run the match, returning its exit code. An unknown command
 * → `undefined` — the EDGE decides what that means (typically: print usage and return its own code,
 * e.g. `2`). Pure: no console, no process, no exit. Uses `Object.hasOwn` so inherited prototype keys
 * (`constructor`, `toString`, …) are never mistaken for handlers.
 */
export function dispatch(
  cmd: string,
  handlers: Record<string, () => number>,
): number | undefined {
  return Object.hasOwn(handlers, cmd) ? handlers[cmd]() : undefined;
}
