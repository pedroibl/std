import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { advisor, inference, parseCliArgs, synthesizeAdvisorState } from "./inference";

// Hermetic local server on an ephemeral port — no real network, no real Anthropic/OpenRouter call.
let server: ReturnType<typeof Bun.serve>;
let base: string;

function anthropicEnvelope(text: string) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      switch (pathname) {
        case "/anthropic/ok":
          return Response.json(anthropicEnvelope("plain text reply"));
        case "/anthropic/array":
          // The model's text response is a JSON ARRAY — the extractJson upgrade case.
          return Response.json(anthropicEnvelope('[{"a":1},{"a":2}]'));
        case "/anthropic/500":
          return new Response("anthropic-down", { status: 500 });
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

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Never touch the real ~/.claude/.env or real keys — point everything at temp/local, and set the
  // API key directly (getEnvKey checks process.env first, so the dotenv path is never exercised).
  process.env.PAI_INFERENCE_ENV_FILE = join(tmpdir(), "pai-inference-test-nonexistent.env");
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  delete process.env.OPENROUTER_API_KEY; // isolate the primary-failure test to the Anthropic leg
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("inference() — array-upgrade via extractJson (NOT byte-identical to the source)", () => {
  test("a model response containing a JSON ARRAY parses to the array, not the inner object", async () => {
    process.env.PAI_INFERENCE_ANTHROPIC_URL = `${base}/anthropic/array`;
    const result = await inference({
      systemPrompt: "sys",
      userPrompt: "give me json",
      level: "fast",
      expectJson: true,
    });
    expect(result.success).toBe(true);
    // The original hand-rolled parser tried object-match then array-match, in that fixed order,
    // regardless of which bracket opened first — for "[{...}]" it would have grabbed the inner object
    // {"a":1}. std/core's extractJson orders by first-opening bracket, so this resolves to the ARRAY.
    expect(result.parsed).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe("inference() — a normal call round-trips through httpJson", () => {
  test("plain text (no --json) returns success with the trimmed output", async () => {
    process.env.PAI_INFERENCE_ANTHROPIC_URL = `${base}/anthropic/ok`;
    const result = await inference({ systemPrompt: "sys", userPrompt: "hi", level: "fast" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("plain text reply");
    expect(result.parsed).toBeUndefined();
  });
});

describe("inference() — a non-2xx is fail-loud through httpJson", () => {
  test("a 500 from Anthropic surfaces (status + body) in the combined error", async () => {
    process.env.PAI_INFERENCE_ANTHROPIC_URL = `${base}/anthropic/500`;
    // OPENROUTER_API_KEY is unset (beforeEach), so the fallback leg short-circuits without a network
    // call — isolating this assertion to httpJson's fail-loud message from the Anthropic leg.
    const result = await inference({ systemPrompt: "sys", userPrompt: "hi", level: "fast" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
    expect(result.error).toContain("anthropic-down");
    expect(result.error).toContain("OPENROUTER_API_KEY not set");
  });
});

describe("inference() — OpenRouter fallback on primary failure", () => {
  test("falls back to OpenRouter (real JSON, not empty-body) when Anthropic fails", async () => {
    // A SEPARATE local server for this test (not the shared module-level `server`/`base` other
    // describe blocks depend on) — a dedicated route standing in for the OpenRouter chat-completions
    // envelope, stopped at the end of this test only.
    const fallbackServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/anthropic/down") return new Response("down", { status: 503 });
        if (pathname === "/openrouter/ok") {
          return Response.json({ choices: [{ message: { content: "fallback reply" } }] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const fbBase = `http://localhost:${fallbackServer.port}`;
      process.env.PAI_INFERENCE_ANTHROPIC_URL = `${fbBase}/anthropic/down`;
      process.env.PAI_INFERENCE_OPENROUTER_URL = `${fbBase}/openrouter/ok`;
      process.env.OPENROUTER_API_KEY = "test-openrouter-key";

      const result = await inference({ systemPrompt: "sys", userPrompt: "hi", level: "fast" });
      expect(result.success).toBe(true);
      expect(result.output).toBe("fallback reply");
    } finally {
      fallbackServer.stop(true);
    }
  });
});

describe("advisor() — auto-synthesize reads the ISA via walkFiles/statMtime", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pai-inference-work-"));
    process.env.PAI_INFERENCE_WORK_DIR = workDir;
    process.env.PAI_INFERENCE_STATE_FILE = join(tmpdir(), "pai-inference-state-nonexistent.json");
  });

  test("synthesizeAdvisorState picks the most recently modified ISA.md across session dirs", async () => {
    const older = join(workDir, "older-session");
    const newer = join(workDir, "newer-session");
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(older, "ISA.md"), "# older ISA content");
    // Ensure a distinct, later mtime for the "newer" file.
    await Bun.sleep(5);
    writeFileSync(join(newer, "ISA.md"), "# newer ISA content");

    const state = await synthesizeAdvisorState();
    expect(state).toContain("ISA: newer-session");
    expect(state).toContain("newer ISA content");
    expect(state).not.toContain("older ISA content");
  });

  test("an empty workDir returns the no-active-ISA message", async () => {
    const state = await synthesizeAdvisorState();
    expect(state).toBe("No active ISA found. Advisor state unavailable.");
  });

  test("advisor() surfaces the auto-synthesized state through a real inference call", async () => {
    const slugDir = join(workDir, "only-session");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, "ISA.md"), "# the only ISA");

    process.env.PAI_INFERENCE_ANTHROPIC_URL = `${base}/anthropic/ok`;
    const result = await advisor({ task: "ship it", question: "any gaps?", autoSynthesize: true });
    expect(result.success).toBe(true);
    expect(result.level).toBe("smart");
  });
});

describe("parseCliArgs — flagValue/hasFlag/positional collection (pure, no network)", () => {
  test("collects --level's VALUE, not as a stray positional (the value-flag-blind gotcha)", () => {
    const parsed = parseCliArgs(["--level", "fast", "system prompt", "user prompt"]);
    expect(parsed.level).toBe("fast");
    expect(parsed.positionalArgs).toEqual(["system prompt", "user prompt"]);
  });

  test("--json and --auto-state are bare boolean flags via hasFlag", () => {
    const parsed = parseCliArgs(["--mode", "advisor", "--auto-state", "--json", "task", "question"]);
    expect(parsed.mode).toBe("advisor");
    expect(parsed.autoState).toBe(true);
    expect(parsed.expectJson).toBe(true);
    expect(parsed.positionalArgs).toEqual(["task", "question"]);
  });

  test("--timeout's value parses to a number and is stripped from positionals", () => {
    const parsed = parseCliArgs(["--timeout", "5000", "sys", "usr"]);
    expect(parsed.timeout).toBe(5000);
    expect(parsed.positionalArgs).toEqual(["sys", "usr"]);
  });

  test("defaults: standard level, inference mode, no flags", () => {
    const parsed = parseCliArgs(["sys", "usr"]);
    expect(parsed.level).toBe("standard");
    expect(parsed.mode).toBe("inference");
    expect(parsed.expectJson).toBe(false);
    expect(parsed.autoState).toBe(false);
    expect(parsed.timeout).toBeUndefined();
  });
});
