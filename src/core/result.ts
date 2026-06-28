// Story 2.4 — the Result union and its fail-loud classifier. Pure (D1). Expected failures travel as
// data (`{ok:false,error}`); anything unexpected is RE-THROWN, never swallowed (FR5). Core owns no
// error vocabulary of its own — the caller passes the codes IT knows how to handle, so std never grows
// a speculative error-code list ahead of a real caller (CM1/D4).

/** The discriminated result of an operation that can fail in a known way. `ok` is the tag. */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** A classified failure: a known `code` plus the original error's message. */
export type Classified<C extends string> = { code: C; message: string };

/** Pull a string `code` off a caught value (the Node `err.code` convention), or undefined if absent. */
function codeOf(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "code" in e) {
    const c = (e as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

/**
 * Classify a caught value against the caller's `known` codes. Returns a typed `{code,message}` when
 * the value carries a known code; otherwise RE-THROWS the original (fail-loud — never swallow FR5).
 */
export function classify<C extends string>(e: unknown, known: readonly C[]): Classified<C> {
  const code = codeOf(e);
  if (code !== undefined && (known as readonly string[]).includes(code)) {
    return { code: code as C, message: e instanceof Error ? e.message : String(e) };
  }
  throw e; // unclassified — propagate, do not bury
}

/**
 * Run `fn`, wrapping success as `{ok:true,value}` and a KNOWN failure as `{ok:false,error}`. A failure
 * whose code isn't in `known` propagates out of `toResult` unchanged (fail-loud).
 */
export function toResult<T, C extends string>(
  fn: () => T,
  known: readonly C[],
): Result<T, Classified<C>> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: classify(e, known) };
  }
}
