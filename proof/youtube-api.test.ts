import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import {
  apiGet,
  defaultEnvPath,
  formatNum,
  getChannel,
  loadEnv,
  main,
  resolveConfig,
} from "./youtube-api";

// Hermetic local server on an ephemeral port (`port: 0`) — no real network. `BASE_URL` is an argument
// to every function under test, never a baked constant, so every test points at this mock instead of
// the real YouTube Data API.
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

const MISSING_ENV_PATH = "/nonexistent/std-12.5-youtube-api-test/.env-does-not-exist";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      switch (pathname) {
        case "/channels":
          return Response.json({
            items: [
              {
                snippet: { title: "Test Channel", description: "d", customUrl: "@testchannel" },
                statistics: { subscriberCount: "1234", viewCount: "56789", videoCount: "10" },
              },
            ],
          });
        case "/forbidden":
          // Shaped like a real YouTube Data API error envelope — proves the source's console-only
          // `err.error?.message` text still surfaces, just folded into httpJson's thrown message
          // instead of being separately parsed.
          return new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("apiGet — std/http httpJson path", () => {
  test("parses a canned 2xx JSON response, typed", async () => {
    const data = await apiGet<{ items: Array<{ snippet: { title: string } }> }>(
      { apiKey: "test-key", baseUrl },
      "/channels",
      { part: "snippet,statistics", id: "UCxxx" },
    );
    expect(data.items[0].snippet.title).toBe("Test Channel");
  });

  test("a non-2xx response surfaces fail-loud with the status + body in the message", async () => {
    let caught: unknown;
    try {
      await apiGet({ apiKey: "test-key", baseUrl }, "/forbidden", {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("403");
    expect(msg).toContain("quota exceeded");
  });

  test("the API key + params land on the querystring (proves no baked identity in the URL builder)", async () => {
    let seen: URL | undefined;
    const captureServer = Bun.serve({
      port: 0,
      fetch(req) {
        seen = new URL(req.url);
        return Response.json({ items: [] });
      },
    });
    try {
      await apiGet(
        { apiKey: "k-123", baseUrl: `http://localhost:${captureServer.port}` },
        "/videos",
        { part: "statistics", id: "abc" },
      );
      expect(seen?.searchParams.get("key")).toBe("k-123");
      expect(seen?.searchParams.get("part")).toBe("statistics");
      expect(seen?.searchParams.get("id")).toBe("abc");
    } finally {
      captureServer.stop(true);
    }
  });
});

describe("formatNum", () => {
  test("formats a numeric string with thousands separators", () => {
    expect(formatNum("1234567")).toBe("1,234,567");
  });

  test("formats a plain number", () => {
    expect(formatNum(42)).toBe("42");
  });
});

describe("getChannel — end-to-end console rendering off apiGet/httpJson", () => {
  test("renders title/subscriber/view/video counts from the canned response", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await getChannel({ apiKey: "k", channelId: "UCxxx", baseUrl });
    } finally {
      spy.mockRestore();
    }
    const joined = logs.join("\n");
    expect(joined).toContain("Test Channel");
    expect(joined).toContain("1,234");
    expect(joined).toContain("56,789");
  });
});

describe("loadEnv / resolveConfig", () => {
  test("loadEnv returns {} for a missing file (fsx.readIfExists is ENOENT-soft)", () => {
    expect(loadEnv(MISSING_ENV_PATH)).toEqual({});
  });

  test("resolveConfig returns null when no API key is set anywhere", () => {
    const saved = process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    try {
      expect(resolveConfig(MISSING_ENV_PATH)).toBeNull();
    } finally {
      if (saved !== undefined) process.env.YOUTUBE_API_KEY = saved;
    }
  });

  test("resolveConfig picks up key / channel / base URL from process.env (the test hook)", () => {
    const saved = {
      key: process.env.YOUTUBE_API_KEY,
      channel: process.env.YOUTUBE_CHANNEL_ID,
      base: process.env.YOUTUBE_API_BASE_URL,
    };
    process.env.YOUTUBE_API_KEY = "env-key";
    process.env.YOUTUBE_CHANNEL_ID = "env-channel";
    process.env.YOUTUBE_API_BASE_URL = baseUrl;
    try {
      expect(resolveConfig(MISSING_ENV_PATH)).toEqual({
        apiKey: "env-key",
        channelId: "env-channel",
        baseUrl,
      });
    } finally {
      if (saved.key === undefined) delete process.env.YOUTUBE_API_KEY;
      else process.env.YOUTUBE_API_KEY = saved.key;
      if (saved.channel === undefined) delete process.env.YOUTUBE_CHANNEL_ID;
      else process.env.YOUTUBE_CHANNEL_ID = saved.channel;
      if (saved.base === undefined) delete process.env.YOUTUBE_API_BASE_URL;
      else process.env.YOUTUBE_API_BASE_URL = saved.base;
    }
  });
});

describe("defaultEnvPath — LIFEOS_CONFIG_DIR preferred, PAI_CONFIG_DIR kept (RT-6)", () => {
  // The tool reads process.env.LIFEOS_CONFIG_DIR / PAI_CONFIG_DIR and homedir(). Set AND restore both
  // env stems explicitly in each case — Pedro's shell exports PAI_DIR/PAI_CONFIG_DIR ambiently, and a
  // leak there is exactly what 16.2's cross-vendor-audit test seam caught. homedir() (Bun's os.homedir)
  // ignores $HOME, so the neither-set branch is asserted by the returned path shape, not by redirecting HOME.
  const saved = { lifeos: process.env.LIFEOS_CONFIG_DIR, pai: process.env.PAI_CONFIG_DIR };
  const setEnv = (lifeos: string | undefined, pai: string | undefined) => {
    if (lifeos === undefined) delete process.env.LIFEOS_CONFIG_DIR;
    else process.env.LIFEOS_CONFIG_DIR = lifeos;
    if (pai === undefined) delete process.env.PAI_CONFIG_DIR;
    else process.env.PAI_CONFIG_DIR = pai;
  };
  afterAll(() => {
    setEnv(saved.lifeos, saved.pai);
  });

  test("LIFEOS_CONFIG_DIR wins even when PAI_CONFIG_DIR is also set", () => {
    setEnv("/tmp/rt6-lifeos", "/tmp/rt6-pai");
    expect(defaultEnvPath()).toBe(join("/tmp/rt6-lifeos", ".env"));
  });

  test("PAI_CONFIG_DIR is still honored when LIFEOS_CONFIG_DIR is unset (transition window)", () => {
    setEnv(undefined, "/tmp/rt6-pai");
    expect(defaultEnvPath()).toBe(join("/tmp/rt6-pai", ".env"));
  });

  test("an explicitly-empty LIFEOS_CONFIG_DIR falls through to PAI_CONFIG_DIR (|| not ??)", () => {
    setEnv("", "/tmp/rt6-pai");
    expect(defaultEnvPath()).toBe(join("/tmp/rt6-pai", ".env"));
  });

  test("neither set → ~/.claude/.env (claude-home fallback unchanged)", () => {
    setEnv(undefined, undefined);
    expect(defaultEnvPath().endsWith(join(".claude", ".env"))).toBe(true);
  });
});

describe("main — CLI edge (positional() routing, no dispatch — see SUBSTRATE FINDING)", () => {
  test("no command / --help / -h all print help and return 0", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main([], MISSING_ENV_PATH)).toBe(0);
      expect(await main(["--help"], MISSING_ENV_PATH)).toBe(0);
      expect(await main(["-h"], MISSING_ENV_PATH)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("an unknown command prints an error + help and returns 1", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main(["bogus"], MISSING_ENV_PATH)).toBe(1);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("a known command with no resolvable API key returns 1 (envPath forced to a missing file)", async () => {
    const saved = process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await main(["channel"], MISSING_ENV_PATH)).toBe(1);
    } finally {
      errSpy.mockRestore();
      if (saved !== undefined) process.env.YOUTUBE_API_KEY = saved;
    }
  });

  test("`video` with no id/title argument returns 1 without a network call", async () => {
    process.env.YOUTUBE_API_KEY = "k";
    process.env.YOUTUBE_API_BASE_URL = baseUrl;
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await main(["video"], MISSING_ENV_PATH)).toBe(1);
    } finally {
      errSpy.mockRestore();
      delete process.env.YOUTUBE_API_KEY;
      delete process.env.YOUTUBE_API_BASE_URL;
    }
  });

  test("`channel` end-to-end through main() against the mock server returns 0", async () => {
    process.env.YOUTUBE_API_KEY = "k";
    process.env.YOUTUBE_API_BASE_URL = baseUrl;
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main(["channel"], MISSING_ENV_PATH)).toBe(0);
    } finally {
      logSpy.mockRestore();
      delete process.env.YOUTUBE_API_KEY;
      delete process.env.YOUTUBE_API_BASE_URL;
    }
  });
});
