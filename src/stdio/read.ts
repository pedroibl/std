// stdio — the Bun-edge stdin/stdout JSON-framing primitive (AD-9 plumbing topology; Story 13.2 / AD-9.4).
//
// WHY: across ~30 of the 69 hook files, the SAME reader is re-hand-rolled — read the process's own stdin
// fully, race it against a timeout so a stalled harness cannot hang the hook, `JSON.parse` it, and treat
// empty / malformed / timeout as "no input". `readStdinJson` unifies that on ONE contract.
//
// POSTURE-NEUTRAL (AD-9.4 Rule 2): it returns `T | null` and DECIDES NOTHING. It never `process.exit`s,
// never throws-to-block, never allows-through. The CALLER maps `null` to its posture:
//   • fail-OPEN   (observability / logging hooks): `null → exit 0`, proceed. [the 13.2 canary]
//   • fail-CLOSED (security / ContainmentGuard, 13.6): `null → deny / exit 2`.
// A rewritten hook that adopts this and does NOT visibly branch on `null` per its posture is a review
// blocker for the rest of Epic 13.
//
// RUNTIME: `node:*` is allowed here (a Bun edge; forbidden only in `core`). Runtime boundary = module
// boundary: `stdio` frames the process's OWN stdin/stdout — distinct from `proc` (spawns OTHER
// processes), `fsx` (files), `http` (network). CONSUMER-AGNOSTIC (D4): no paths, no hook-event shapes, no
// consumer identity — the `HookInput` shape stays caller-local (AD-9.4 Rule 1, the SPLIT).
//
// WRITE SIDE DEFERRED (AD-9.4 Rule 1.3): `writeStdoutJson`/`respondJson` are NOT built here — land them
// only when a rewritten hook confirms the stdout-JSON-envelope idiom converges (the 13.2 canary writes to
// a JSONL file and exits 0, so it does not exercise the write side). Read-only for now — justified by the
// 30+ read sites alone.

/** Generous default so a slow harness under load does not race to a false `null` (AD-9.4 Rule 2.1). */
export const DEFAULT_STDIN_TIMEOUT_MS = 1000;

/**
 * Read the process's own stdin fully, race it against `timeoutMs`, and `JSON.parse` the result.
 * Resolves the parsed value on success, or **`null` on empty / malformed / timeout** — it never rejects,
 * never exits, never throws. Posture-neutral (see the module header): the caller maps `null` to its
 * posture. Note a valid JSON `null` literal also resolves `null` — the contract is "no usable input"; a
 * caller needing to distinguish it should not be using this reader (valid `false`/`0`/`""` return
 * distinctly).
 *
 * `timeoutMs` defaults to `DEFAULT_STDIN_TIMEOUT_MS` (1000) and is caller-overridable.
 */
export function readStdinJson<T = unknown>(timeoutMs: number = DEFAULT_STDIN_TIMEOUT_MS): Promise<T | null> {
  return readJsonFromStream<T>(process.stdin, timeoutMs);
}

/**
 * The stream-injected core of `readStdinJson`, split out so it is testable against a mock `Readable`
 * without touching the real `process.stdin`. NOT part of the slice's public surface (`index.ts` re-exports
 * only `readStdinJson`) — tests import it directly. Same posture-neutral `T | null` contract: whichever of
 * {full read + parse, timeout} wins first resolves the promise exactly once.
 */
export function readJsonFromStream<T = unknown>(
  stream: NodeJS.ReadableStream,
  timeoutMs: number = DEFAULT_STDIN_TIMEOUT_MS,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    let data = "";

    const onData = (chunk: Buffer | string): void => {
      data += typeof chunk === "string" ? chunk : chunk.toString();
    };
    const onEnd = (): void => {
      const text = data.trim();
      if (!text) return finish(null); // empty / whitespace-only stdin → null
      try {
        finish(JSON.parse(text) as T);
      } catch {
        finish(null); // malformed JSON → null (posture-neutral: we do not throw; the caller decides)
      }
    };
    const onError = (): void => finish(null);

    // The single resolution point — guarded so the FIRST of {end, timeout, error} wins. A later callback
    // is a no-op (no double-resolve, no timer leak). On resolution it also DETACHES the listeners and
    // pauses the stream: a flowing `process.stdin` left attached after a timeout keeps the event loop
    // ref'd, so a caller that returns naturally (rather than `process.exit`ing) would otherwise hang, and
    // an orphaned `data` handler would keep appending to a dead closure.
    const finish = (value: T | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      if (typeof stream.pause === "function") stream.pause();
      resolve(value);
    };
    // Timeout wins if the input never arrives or the stream never ends — resolve `null`, never hang.
    const timer = setTimeout(() => finish(null), timeoutMs);

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}
