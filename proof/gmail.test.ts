import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolveFrameworkDir } from "std/fsx";

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

describe("RT-2 framework-dir resolution (AD-9.3)", () => {
  // credsPath() is NOT exported — it is observed through creds()/accessToken(), which throws
  // "missing or invalid credentials file: <resolved path>" when the file is absent. That throw
  // happens INSIDE creds() (before accessToken's fetch), so no network is touched.
  //
  // NOTE: gmail resolves its default root via node:os `homedir()`, and Bun's `homedir()` IGNORES
  // process.env.HOME (verified empirically), so a temp home cannot be forced here. The resolver
  // FALLBACK itself (fresh → LIFEOS, legacy → PAI) is proven hermetically by the sibling
  // checkpoint/inference RT-2 blocks + src/fsx/index.test.ts. Here we prove (a) the override env
  // wins, (b) its leading $HOME is expanded, and (c) the default root delegates to
  // resolveFrameworkDir at the exact framework subpath — the last computed from the SAME resolver
  // the tool uses, so it is machine-independent.
  const KEYS = ["LIFEOS_DIR", "PAI_DIR", "HOME", "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE"] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    // Explicitly neutralize any ambient live-PAI env — the resolver reads none of these, but the
    // story mandates every test control them so nothing can leak in.
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    _resetTokenCacheForTests();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    _resetTokenCacheForTests();
  });

  // accessToken() → creds() → loadJson(credsPath()) throws with credsPath() in the message when the
  // file is missing/invalid. Returns that message. No network — the throw precedes accessToken's fetch.
  async function credsPathViaThrow(): Promise<string> {
    try {
      await accessToken();
      throw new Error("expected accessToken() to throw on a missing creds file");
    } catch (err) {
      return (err as Error).message;
    }
  }

  test("GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE override wins over the resolver", async () => {
    const override = join(mkdtempSync(join(tmpdir(), "rt2-gmail-")), "nonexistent-creds.json");
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = override;
    _resetTokenCacheForTests();
    const msg = await credsPathViaThrow();
    expect(msg).toContain(override);
  });

  test("the override's leading $HOME is expanded to homedir()", async () => {
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = "$HOME/rt2-nonexistent-xyz/creds.json";
    _resetTokenCacheForTests();
    const msg = await credsPathViaThrow();
    expect(msg).toContain(join(homedir(), "rt2-nonexistent-xyz", "creds.json"));
  });

  test("default root (no override) delegates to resolveFrameworkDir at USER/CREDENTIALS/google/credentials.json", async () => {
    delete process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
    _resetTokenCacheForTests();
    // Computed from the same resolver the tool uses → machine-independent (whichever framework dir
    // exists under the real home, both sides agree).
    const expected = join(resolveFrameworkDir(homedir()), "USER/CREDENTIALS/google/credentials.json");
    // Guarded so a real creds file (if ever present at that path) never triggers a token exchange;
    // it is absent on this machine and on CI runners, so creds() throws with `expected` inside.
    if (!existsSync(expected)) {
      const msg = await credsPathViaThrow();
      expect(msg).toContain(expected);
    }
  });
});
