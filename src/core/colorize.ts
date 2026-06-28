// Story 2.2 — the colorize decision, made once, in pure core (D1). Core reads NO environment: the
// edge reads `process.env.NO_COLOR` and `process.stdout.isTTY` and passes the two booleans in. This
// keeps the policy ("colorize only when color isn't disabled AND we're on a TTY") in one testable place.

/**
 * Decide whether to emit ANSI color. `noColor` is the caller's NO_COLOR signal; `isTty` is whether
 * the output stream is a terminal. Color is on only when it's not disabled and we're attached to a TTY.
 */
export function shouldColorize(noColor: boolean, isTty: boolean): boolean {
  return !noColor && isTty;
}
