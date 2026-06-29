// http — the Bun-edge `fetch` plumbing (AD-9 topology), sibling to `glab`/`proc`/`git`.
//
// WHY: across the estate, network calls are hand-rolled the same two ways. (1) An AbortController
// timeout envelope — `new AbortController()` + `setTimeout(abort)` + `clearTimeout` in a `finally` —
// wraps a `fetch`, re-spawned verbatim by an HTML archiver and a notify pair. (2) On top of that, a
// fetch → assert-`ok` → parse-JSON layer is re-spawned by two JSON API clients. `fetchWithTimeout`
// is the one tested envelope they collapse onto; `httpJson` is the assert-ok+JSON layer built on it.
//
// SPLIT ERROR CONTRACT (load-bearing, D2/FR5): the two functions diverge deliberately.
//   • `fetchWithTimeout` is TRANSPARENT — it returns the raw `Response`, asserts nothing, reads no
//     body, and swallows nothing. A network failure and the `AbortError` both propagate to the caller.
//   • `httpJson` is FAIL-LOUD — it throws on a non-2xx `Response` (FR5: an expected-but-unhandled HTTP
//     failure must surface, never be silently swallowed).
//   The notify callers' FAIL-SOFT posture (`console.error` + swallow) stays IN THE CALLER — no
//   fail-soft `http` variant is built, because no JSON consumer wants one and the notify callers keep
//   their own swallow (a speculative third contract otherwise, D2).
//
// TIMEOUT SCOPE (review Decision-1): the timeout bounds TIME-TO-RESPONSE — establishing the
// connection and receiving the response headers — NOT the body transfer. `fetchWithTimeout` returns
// the raw `Response` the instant headers arrive and clears the timer in its `finally`; the caller then
// reads the body OUTSIDE the timeout window. This is forced by the return-a-`Response` decision (the
// function returns before the body is read) and is the correct behaviour for a process that must exit
// cleanly — leaving the abort timer armed past return would hang a short-lived CLI for up to `timeout`
// ms. The notify/discard callers read no body, so this is exactly their original behaviour. A caller
// that streams a large body and needs the *transfer* bounded must enforce that itself (its own outer
// deadline). `httpJson` reads the body after the window for the same reason; its real consumers had no
// timeout at all today, so a time-to-response bound is a strict improvement either way.
//
// CONSUMER-AGNOSTIC (D4): `url`, `opts.headers`, `opts.body`, and `opts.timeout` are the only inputs.
// No baked URL (no Pulse `localhost:31337`), no `voice_enabled`/voice-ID or `agent`/`slug`/`phase`
// body fields, no `User-Agent`/`Accept` header, no `Authorization`/Bearer/API-key, no `~/.claude`
// path. Every consumer identity stays in the rewritten caller; this edge only times out and parses.
//
// EDGE, not core: it uses the web-standard `fetch` + `AbortController` globals (present in Bun, no
// `node:*`). It lives in `src/http/**`, so D1 core-purity does not apply. It imports nothing from the
// other plumbing slices — `http` shares the AD-9 topology with `proc`/`git` but lives on its own
// network axis, independent of them.

/**
 * Generic default timeout, used only when `opts.timeout` is omitted. A safety bound so a stalled
 * server can't hang a caller that forgot to pass one — NOT consumer identity. The real consumers pass
 * their own (`TlpArchive` 25_000, the notify pair 2_000), so this is a fallback, not a policy.
 */
export const HTTP_TIMEOUT_MS = 30_000;

/**
 * Upper bound on how much of an error-response body `httpJson` reads into the thrown `Error` message.
 * Bounds peak memory on the failure path: a pathological multi-MB error body is read only up to this
 * cap, then the stream is cancelled. Error bodies of interest (API JSON errors) are far smaller.
 */
const MAX_ERROR_BODY_CHARS = 2048;

/** `fetch`'s own options, plus an optional `timeout` (ms). The function installs its own `signal`. */
export type FetchOpts = RequestInit & { timeout?: number };

/**
 * `fetch(url, opts)` wrapped in an AbortController timeout envelope; returns the raw `Response`.
 *
 * **Transparent — asserts nothing, reads no body, swallows nothing.** It does not check `res.ok` and
 * does not touch the body, so the caller picks the body verb (`.text()` / `.json()` / discard). A
 * network failure or the timeout's `AbortError` propagates to the caller unchanged.
 *
 * **`timeout` bounds time-to-response, not body transfer** (see the TIMEOUT SCOPE note above): the
 * timer is cleared the instant the response headers arrive, before the caller reads the body.
 *
 * The function owns the `AbortController`/`signal`: any `opts.signal` is destructured out before the
 * `fetch` spread and ignored (no consumer passes one — they each made their own controller, which is
 * exactly the mechanism lifted here). The timer is always cleared in a `finally`, on success or throw.
 */
export async function fetchWithTimeout(url: string, opts?: FetchOpts): Promise<Response> {
  // Drop `timeout` (not a RequestInit field) and any caller `signal` (this function owns the signal)
  // before spreading the rest into `fetch` — the override is explicit in code, not just a comment.
  const { timeout, signal: _ignored, ...init } = opts ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout ?? HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `fetchWithTimeout`, then **assert `ok` (fail-loud) and parse JSON**: returns `await res.json()` typed
 * as `T`.
 *
 * **Fail-loud (FR5):** a non-2xx `Response` throws an `Error` whose message carries `res.status`,
 * `res.statusText` (when the server sent a reason phrase), and — best-effort, length-bounded — the
 * error-response body (a superset richer than a bare status; the API-specific extraction a caller may
 * want, e.g. `err.error?.message`, stays in the caller). A 2xx body that is **not valid JSON** also
 * throws fail-loud, wrapped with the status rather than surfacing a bare `SyntaxError`. The timeout
 * `AbortError` and network errors propagate from `fetchWithTimeout` unchanged.
 *
 * Minimal on the success path: `res.json()` (which throws on an empty body — fail-loud). A caller
 * needing empty-body tolerance keeps that in the caller; `http` does not special-case it.
 */
export async function httpJson<T>(url: string, opts?: FetchOpts): Promise<T> {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok) {
    const body = await readBodySnippet(res, MAX_ERROR_BODY_CHARS);
    const detail = body ? `: ${body}` : "";
    throw new Error(`HTTP ${statusLabel(res)}${detail}`);
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    // A 2xx with a non-JSON (or empty) body: rethrow fail-loud WITH the status, instead of letting a
    // bare `SyntaxError` (no HTTP context) escape.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`HTTP ${statusLabel(res)}: response body was not valid JSON (${reason})`);
  }
}

/** `"<status> <statusText>"`, or just `"<status>"` when the server omitted the reason phrase. */
function statusLabel(res: Response): string {
  return res.statusText ? `${res.status} ${res.statusText}` : `${res.status}`;
}

/**
 * Read at most `maxChars` characters of `res`'s body, then cancel the stream (freeing the socket).
 * Best-effort: any read failure yields `""` so a body-read problem never masks the real HTTP status.
 * Bounds peak memory — it stops pulling chunks once the cap is reached rather than buffering the whole
 * body via `res.text()`.
 */
async function readBodySnippet(res: Response, maxChars: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    return out.length > maxChars ? out.slice(0, maxChars) : out;
  } catch {
    return "";
  } finally {
    // Discard any unread remainder so a capped read doesn't leak the connection.
    await reader.cancel().catch(() => {});
  }
}
