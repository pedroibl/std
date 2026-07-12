import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { _resetTokenCacheForTests, accessToken, archiveBatch, countQuery, gmail } from "./gmail";

// Hermetic local server standing in for both the OAuth token endpoint and the Gmail REST API — no
// real network, no real Google credentials.
let server: ReturnType<typeof Bun.serve>;
let base: string;
let tokenRequests = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/token") {
        tokenRequests++;
        return Response.json({ access_token: "fake-token", expires_in: 3600 });
      }
      if (pathname === "/token-fail") {
        return new Response("invalid_grant", { status: 400 });
      }
      // Gmail REST routes, keyed by path — mirrors the shape gmail() builds ( `${apiBaseUrl()}${path}` ).
      if (pathname === "/users/me/messages" && req.method === "GET") {
        return Response.json({ resultSizeEstimate: 42 });
      }
      if (pathname === "/users/me/messages/batchModify" && req.method === "POST") {
        // THE regression: Gmail's real batchModify returns an EMPTY 2xx body on success.
        return new Response("", { status: 200 });
      }
      if (pathname === "/users/me/messages/send-empty" && req.method === "POST") {
        return new Response("", { status: 200 });
      }
      if (pathname === "/users/me/messages/json-body" && req.method === "GET") {
        return Response.json({ id: "abc123", snippet: "hello" });
      }
      if (pathname === "/users/me/messages/fail" && req.method === "GET") {
        return new Response("permission denied", { status: 403 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

const ORIGINAL_ENV = { ...process.env };
let credsFile: string;

beforeEach(() => {
  // Never read the real ~/.claude credentials — a fresh temp creds file per test, injected via the
  // documented env override.
  const dir = mkdtempSync(join(tmpdir(), "pai-gmail-test-"));
  credsFile = join(dir, "credentials.json");
  writeFileSync(
    credsFile,
    JSON.stringify({ client_id: "test-client", client_secret: "test-secret", refresh_token: "test-refresh" }),
  );
  process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = credsFile;
  process.env.GMAIL_OAUTH_URL = `${base}/token`;
  process.env.GMAIL_API_BASE_URL = `${base}/users/me`;
  tokenRequests = 0;
  // The token cache is module-level state that would otherwise leak a still-valid token across tests
  // (each with its own temp creds file / oauth route) — reset it so every test gets a fresh exchange.
  _resetTokenCacheForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("accessToken() — OAuth refresh via httpJson (real JSON both ways)", () => {
  test("parses the real JSON success envelope", async () => {
    const token = await accessToken();
    expect(token).toBe("fake-token");
  });

  test("a non-2xx token response is fail-loud (httpJson throws)", async () => {
    process.env.GMAIL_OAUTH_URL = `${base}/token-fail`;
    let caught: unknown;
    try {
      await accessToken();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("400");
  });
});

describe("gmail() — THE decision: fetchWithTimeout + edge parse, not httpJson", () => {
  test("REGRESSION: an EMPTY 2xx body (archive/batchModify) stays green through fetchWithTimeout", async () => {
    // If this call were routed through httpJson instead, it would throw "response body was not valid
    // JSON" on the empty body — httpJson is fail-loud on a non-JSON 2xx body by design. This proves
    // the fetchWithTimeout + `text ? JSON.parse(text) : {}` edge parse is the one that must be used.
    const result = await gmail("/messages/batchModify", {
      method: "POST",
      body: JSON.stringify({ ids: ["1", "2"], removeLabelIds: ["INBOX"] }),
    });
    expect(result).toEqual({});
  });

  test("a route returning a real JSON body parses it correctly", async () => {
    const result = await gmail("/messages/json-body");
    expect(result).toEqual({ id: "abc123", snippet: "hello" });
  });

  test("a non-2xx response throws with status + path + body in the message", async () => {
    let caught: unknown;
    try {
      await gmail("/messages/fail");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("403");
    expect(msg).toContain("/messages/fail");
    expect(msg).toContain("permission denied");
  });

  test("archiveBatch (the real batchModify caller) succeeds on the empty-body response", async () => {
    await expect(archiveBatch(["id1", "id2", "id3"])).resolves.toBeUndefined();
  });

  test("countQuery parses a real JSON body (resultSizeEstimate)", async () => {
    const count = await countQuery("in:inbox");
    expect(count).toBe(42);
  });

  test("the access token is cached — one token request serves multiple gmail() calls", async () => {
    await countQuery("in:inbox");
    await countQuery("in:inbox");
    expect(tokenRequests).toBe(1);
  });
});
