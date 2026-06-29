import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { fetchWithTimeout, httpJson } from "./index";

// Hermetic local server on an ephemeral port (`port: 0`) — no real network, no Pulse `localhost:31337`.
// Routed by path so every test shares one server. Started in beforeAll, stopped in afterAll.
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      switch (pathname) {
        case "/json":
          return Response.json({ ok: true, n: 42 });
        case "/500":
          return new Response("boom-500", { status: 500 });
        case "/404":
          return new Response("missing-404", { status: 404 });
        case "/no-reason":
          // Empty reason phrase (HTTP/2 omits them) — exercises the status-label formatting.
          return new Response("err-body", { status: 500, statusText: "" });
        case "/big-error":
          // Oversized error body — exercises the bounded-read cap on the failure path.
          return new Response("x".repeat(100_000), { status: 500 });
        case "/not-json":
          // 2xx with a non-JSON body — exercises the wrapped fail-loud parse error.
          return new Response("<<< not json >>>", {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        case "/teapot":
          // 418 with a body — proves fetchWithTimeout returns it un-asserted (does not throw on !ok).
          return new Response("i-am-a-teapot", { status: 418 });
        case "/slow":
          // Deliberately delays past a short caller timeout so the abort surfaces deterministically.
          await Bun.sleep(500);
          return Response.json({ tooLate: true });
        case "/echo":
          // Echo back what the server actually received — proves method/headers/body are arguments.
          return Response.json({
            method: req.method,
            xCustom: req.headers.get("x-custom"),
            body: await req.text(),
          });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("httpJson — assert-ok + parse JSON (fail-loud)", () => {
  test("GET 200 returns the parsed, typed object", async () => {
    const out = await httpJson<{ ok: boolean; n: number }>(`${base}/json`);
    expect(out).toEqual({ ok: true, n: 42 });
  });

  test("a 500 throws fail-loud with the status in the message", async () => {
    let caught: unknown;
    try {
      await httpJson(`${base}/500`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("500");
    // best-effort error body folded into the message (the chosen superset, Decision 5)
    expect((caught as Error).message).toContain("boom-500");
  });

  test("a 404 throws fail-loud with the status in the message", async () => {
    let caught: unknown;
    try {
      await httpJson(`${base}/404`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("404");
  });

  test("the status-line formats cleanly — no double/trailing space (statusText fragility)", async () => {
    // Bun's HTTP layer reinstates a canonical reason phrase even when the handler sends `statusText: ""`,
    // so over the wire this is "HTTP 500 Internal Server Error: …". The guard that matters regardless is
    // that the status, optional reason phrase, and body detail are joined without a stray double space —
    // the bug `statusLabel` exists to prevent when the reason phrase IS empty.
    let caught: unknown;
    try {
      await httpJson(`${base}/no-reason`);
    } catch (err) {
      caught = err;
    }
    const msg = (caught as Error).message;
    expect(msg).toMatch(/^HTTP 500( |:)/); // status, then a single space (reason) or straight to ":"
    expect(msg).toContain("err-body");
    expect(msg).not.toContain("  "); // never a double space, with or without a reason phrase
  });

  test("an oversized error body is bounded in the thrown message (peak-memory cap)", async () => {
    let caught: unknown;
    try {
      await httpJson(`${base}/big-error`);
    } catch (err) {
      caught = err;
    }
    const msg = (caught as Error).message;
    expect(msg).toContain("500");
    // 100_000-char body must not land verbatim in the message — the snippet is capped.
    expect(msg.length).toBeLessThan(3000);
  });

  test("a non-JSON 2xx body throws fail-loud wrapped with the status (not a bare SyntaxError)", async () => {
    let caught: unknown;
    try {
      await httpJson(`${base}/not-json`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("200");
    expect(msg).toContain("not valid JSON");
  });
});

describe("fetchWithTimeout — transparent timeout envelope", () => {
  test("aborts when the server delays past a short timeout (err.name === 'AbortError')", async () => {
    let caught: unknown;
    try {
      // Bun throws a DOMException (not a plain Error) on abort — assert on `.name`, not `instanceof`.
      await fetchWithTimeout(`${base}/slow`, { timeout: 50 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { name?: string }).name).toBe("AbortError");
  });

  test("passes method/headers/body through (URL/headers are arguments, nothing baked)", async () => {
    const res = await fetchWithTimeout(`${base}/echo`, {
      method: "POST",
      headers: { "x-custom": "hello" },
      body: "payload-123",
    });
    const echoed = (await res.json()) as { method: string; xCustom: string; body: string };
    expect(echoed.method).toBe("POST");
    expect(echoed.xCustom).toBe("hello");
    expect(echoed.body).toBe("payload-123");
  });

  test("returns the raw Response un-asserted — a 418 resolves, does not throw", async () => {
    const res = await fetchWithTimeout(`${base}/teapot`);
    // It neither asserts `ok` nor reads the body — the caller does.
    expect(res.ok).toBe(false);
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("i-am-a-teapot");
  });

  test("clears the timer on the success path (clearTimeout spy proves the finally ran)", async () => {
    // bun:test exposes no pending-timer count, so assert the `finally`'s clearTimeout fired rather
    // than rely on a non-deterministic clean process exit.
    const spy = spyOn(globalThis, "clearTimeout");
    try {
      const res = await fetchWithTimeout(`${base}/json`);
      expect(res.ok).toBe(true);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
