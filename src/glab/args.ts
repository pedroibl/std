// Positional/flag parsers shared by the glab subcommands.

/** First non-`--` token (the positional issue number). */
export function positional(args: string[]): string {
  return args.find((a) => !a.startsWith("--")) ?? "";
}

/** Value of `--name <value>`, or undefined. */
export function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

/** True if the boolean `--name` flag is present. */
export function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}
