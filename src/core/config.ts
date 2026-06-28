// Story 2.5 — graceful-degradation config reads. Pure (D1): core never touches the environment or
// the filesystem itself — the edge passes the raw value / supplies the parse. These two primitives
// hold the "optional config must not crash the caller" policy (FR6) in one place.
//
// NOTE the deliberate contrast with the Result union (result.ts): Result is FAIL-LOUD for operations
// whose failure is a real error. THIS module is for OPTIONAL config, where absence/unreadability is a
// normal, expected case — so here, and only here, we degrade to a default/null instead of throwing.

/**
 * Resolve an optional config value: the present value, else `fallback`. Absent (`undefined`/`null`)
 * or empty (`""`) all degrade to the fallback — the edge passes `raw` (e.g. `process.env.FOO`) in.
 */
export function configValue<T>(raw: string | null | undefined, fallback: T): string | T {
  return raw === undefined || raw === null || raw === "" ? fallback : raw;
}

/**
 * Run a config parse that may throw (e.g. `JSON.parse`) and degrade to `null` rather than crash the
 * caller. The swallow is intentional and scoped to optional config — the parse fn is supplied so core
 * stays pure (it owns no parser, no I/O).
 */
export function tryParse<T>(parse: () => T): T | null {
  try {
    return parse();
  } catch {
    return null;
  }
}
