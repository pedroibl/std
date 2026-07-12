// Hermetic proof test for cross-vendor-audit.ts (Story 12.5 — proc cluster).
//
// HOME/CODEX_BIN/CODEX_TIMEOUT_MS are all module-level constants captured once at import time
// (env-overridable, per the D4 test seam), so this file sets `process.env.HOME`,
// `process.env.CATO_CODEX_BIN`, and `process.env.CATO_CODEX_TIMEOUT_MS` to a fresh mkdtemp fixture
// BEFORE dynamically importing the module — a static `import` would be hoisted ahead of any top-level
// env-mutation in this file, so a top-level `await import(...)` is required to get the ordering right.
// The fake `codex` bin is a tiny shell script controlled per-call via env vars
// (FAKE_CODEX_OUTPUT / FAKE_CODEX_EXIT / FAKE_CODEX_SLEEP_SEC) that `spawnCapture` forwards by
// inheritance (this tool never passes `opts.env`, so the child sees the full parent env).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "cato-home-"));
const BIN_DIR = mkdtempSync(join(tmpdir(), "cato-bin-"));
const FAKE_CODEX = join(BIN_DIR, "codex");

const FAKE_CODEX_SCRIPT = [
  "#!/bin/sh",
  "cat > /dev/null", // drain stdin fully before doing anything else — avoids a pipe-backpressure deadlock
  'if [ -n "$FAKE_CODEX_SLEEP_SEC" ]; then sleep "$FAKE_CODEX_SLEEP_SEC"; fi',
  'printf \'%s\' "$FAKE_CODEX_OUTPUT"',
  'exit "${FAKE_CODEX_EXIT:-0}"',
  "",
].join("\n");

function writeFakeCodex(): void {
  writeFileSync(FAKE_CODEX, FAKE_CODEX_SCRIPT);
  chmodSync(FAKE_CODEX, 0o755);
}
writeFakeCodex();

process.env.HOME = FAKE_HOME;
process.env.CATO_CODEX_BIN = FAKE_CODEX;
process.env.CATO_CODEX_TIMEOUT_MS = "400"; // short — the sleep test only waits ~400ms, not 120s
// RT-2 (AD-9.3): the module now resolves its framework dir via `LIFEOS_DIR || PAI_DIR || resolveFrameworkDir(HOME)`.
// The ambient shell may export a real PAI_DIR (live PAI), which would leak past the HOME seam, so pin the
// framework dir explicitly at the fixture and clear LIFEOS_DIR — this keeps the PAI_DIR const below authoritative.
delete process.env.LIFEOS_DIR;
process.env.PAI_DIR = join(FAKE_HOME, ".claude", "PAI");

const {
  parseArgs,
  readISA,
  readArtifacts,
  readToolActivityTail,
  assembleBundle,
  invokeCodex,
  extractCatoResponse,
  appendFinding,
  main,
} = await import("./cross-vendor-audit");

const PAI_DIR = join(FAKE_HOME, ".claude", "PAI");
const WORK_DIR = join(PAI_DIR, "MEMORY", "WORK");
const FINDINGS_LOG = join(PAI_DIR, "MEMORY", "VERIFICATION", "cato-findings.jsonl");
const TOOL_ACTIVITY_LOG = join(PAI_DIR, "MEMORY", "OBSERVABILITY", "tool-activity.jsonl");

function makeSlugDir(slug: string): string {
  const dir = join(WORK_DIR, slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── parseArgs ───

describe("parseArgs", () => {
  test("requires --slug", () => {
    expect(() => parseArgs(["node", "script"])).toThrow("--slug required");
  });

  test("defaults --advisor-verdict when omitted", () => {
    const args = parseArgs(["node", "script", "--slug", "s1"]);
    expect(args).toEqual({ slug: "s1", advisorVerdict: "(not provided)" });
  });

  test("parses both flags (space form)", () => {
    const args = parseArgs(["node", "script", "--slug", "s2", "--advisor-verdict", "looks good"]);
    expect(args).toEqual({ slug: "s2", advisorVerdict: "looks good" });
  });
});

// ─── readISA ───

describe("readISA", () => {
  test("reads ISA.md when present", () => {
    const slug = "slug-isa";
    const dir = makeSlugDir(slug);
    writeFileSync(join(dir, "ISA.md"), "effort: E4\n## Decisions\n");
    expect(readISA(slug)).toContain("effort: E4");
  });

  test("falls back to legacy PRD.md when ISA.md is absent", () => {
    const slug = "slug-legacy";
    const dir = makeSlugDir(slug);
    writeFileSync(join(dir, "PRD.md"), "legacy content");
    expect(readISA(slug)).toBe("legacy content");
  });

  test("throws when neither ISA.md nor PRD.md exists", () => {
    const slug = "slug-missing";
    makeSlugDir(slug);
    expect(() => readISA(slug)).toThrow(/ISA not found/);
  });
});

// ─── readArtifacts ───

describe("readArtifacts", () => {
  test("returns placeholder when there is no ## Decisions section", () => {
    expect(readArtifacts("# no decisions here")).toBe("(no ## Decisions section found)");
  });

  test("returns placeholder when Decisions has no file references", () => {
    const isa = "## Decisions\nJust prose, no backticked paths.\n";
    expect(readArtifacts(isa)).toBe("(no file references found in ## Decisions)");
  });

  test("reads a referenced file's content into the bundle", () => {
    writeFileSync(join(FAKE_HOME, "artifact.ts"), "export const x = 1;");
    const isa = "## Decisions\nSee `~/artifact.ts` for the change.\n";
    const out = readArtifacts(isa);
    expect(out).toContain("--- FILE:");
    expect(out).toContain("export const x = 1;");
  });
});

// ─── readToolActivityTail ───

describe("readToolActivityTail", () => {
  test("returns placeholder when the log file is missing", () => {
    expect(readToolActivityTail("no-such-slug")).toBe("(tool-activity.jsonl not found)");
  });

  test("filters lines by slug", () => {
    mkdirSync(join(PAI_DIR, "MEMORY", "OBSERVABILITY"), { recursive: true });
    const lines = ['{"slug":"target-slug","x":1}', '{"slug":"other-slug","x":2}', '{"slug":"target-slug","x":3}'].join(
      "\n",
    );
    writeFileSync(TOOL_ACTIVITY_LOG, lines + "\n");
    const out = readToolActivityTail("target-slug");
    expect(out).toContain('"target-slug"');
    expect(out).not.toContain('"other-slug"');
  });
});

// ─── assembleBundle ───

describe("assembleBundle", () => {
  test("assembles all sections under the cap", () => {
    const bundle = assembleBundle("ISA TEXT", "ARTIFACT TEXT", "TAIL TEXT", "VERDICT TEXT");
    expect(bundle).toContain("===== ISA =====");
    expect(bundle).toContain("ISA TEXT");
    expect(bundle).toContain("===== OUTPUT ARTIFACTS =====");
    expect(bundle).toContain("ARTIFACT TEXT");
    expect(bundle).toContain("===== TOOL ACTIVITY TAIL =====");
    expect(bundle).toContain("TAIL TEXT");
    expect(bundle).toContain("===== ADVISOR VERDICT =====");
    expect(bundle).toContain("VERDICT TEXT");
  });

  test("drops the tool tail and trims artifacts over the size cap", () => {
    const bigArtifacts = "x".repeat(400_000); // > BUNDLE_CHAR_CAP (320,000)
    const bundle = assembleBundle("ISA", bigArtifacts, "TAIL TEXT", "VERDICT");
    expect(bundle).toContain("(dropped — bundle size cap)");
    expect(bundle).toContain("[TRUNCATED - bundle size cap]");
    expect(bundle).not.toContain("TAIL TEXT");
  });
});

// ─── extractCatoResponse — the reconstructed key-anchored-regex → extractJson + caller-side guard ───

describe("extractCatoResponse", () => {
  test("extracts a verdict JSON blob surrounded by CLI noise", () => {
    const raw = 'codex session banner...\n{"verdict":"pass","criticality":"low","findings":[]}\ndone.';
    const resp = extractCatoResponse(raw);
    expect(resp.verdict).toBe("pass");
    expect(resp.criticality).toBe("low");
  });

  test("returns skipped when there is no JSON at all", () => {
    const resp = extractCatoResponse("no json here whatsoever");
    expect(resp).toEqual({ verdict: "skipped", reason: "no JSON in codex output" });
  });

  test("returns skipped when JSON is present but lacks a verdict key (key-anchor parity)", () => {
    // The original regex required the literal substring "verdict" inside the match; a JSON blob without
    // it would never match at all. extractJson is generic, so the guard is reconstructed post-parse.
    const resp = extractCatoResponse('{"foo":"bar"}');
    expect(resp).toEqual({ verdict: "skipped", reason: "no JSON in codex output" });
  });
});

// ─── invokeCodex — spawnCapture convergence, incl. the 124-timeout sentinel ───

describe("invokeCodex", () => {
  test("captures a fast fake-codex response verbatim", async () => {
    process.env.FAKE_CODEX_OUTPUT = '{"verdict":"concerns","criticality":"medium","findings":[]}';
    process.env.FAKE_CODEX_EXIT = "0";
    delete process.env.FAKE_CODEX_SLEEP_SEC;
    const { stdout, code } = await invokeCodex("bundle text");
    expect(code).toBe(0);
    expect(stdout).toContain('"verdict":"concerns"');
  });

  test("a codex call that outlives CATO_CODEX_TIMEOUT_MS resolves with sentinel 124", async () => {
    process.env.FAKE_CODEX_OUTPUT = "";
    process.env.FAKE_CODEX_EXIT = "0";
    process.env.FAKE_CODEX_SLEEP_SEC = "2"; // > the 400ms CATO_CODEX_TIMEOUT_MS fixture
    const t0 = Date.now();
    const { code } = await invokeCodex("bundle text");
    const elapsed = Date.now() - t0;
    expect(code).toBe(124);
    expect(elapsed).toBeLessThan(1800); // resolved at the timeout, not after the full 2s sleep
    delete process.env.FAKE_CODEX_SLEEP_SEC;
  });
});

// ─── appendFinding — best-effort audit log via std/report.appendAudit ───

describe("appendFinding", () => {
  test("appends a JSONL record to the findings log", () => {
    appendFinding("slug-append", "verdict text", { verdict: "pass", findings: [] }, "E4");
    const content = readFileSync(FINDINGS_LOG, "utf8");
    const lastLine = content.trim().split("\n").pop()!;
    const parsed = JSON.parse(lastLine);
    expect(parsed.slug).toBe("slug-append");
    expect(parsed.cato_verdict).toBe("pass");
    expect(parsed.tier).toBe("E4");
  });
});

// ─── main — end-to-end exit-code contract ───

describe("main — exit codes", () => {
  test("exit 2 on missing --slug", async () => {
    const code = await main(["node", "script"]);
    expect(code).toBe(2);
  });

  test("exit 1 when the ISA cannot be found", async () => {
    writeFakeCodex(); // ensure the codex-installed branch is reached
    const code = await main(["node", "script", "--slug", "slug-no-isa-dir"]);
    expect(code).toBe(1);
  });

  test("exit 0 (skipped) when the codex binary is missing", async () => {
    const slug = "slug-no-codex";
    const dir = makeSlugDir(slug);
    writeFileSync(join(dir, "ISA.md"), "## Decisions\n");
    rmSync(FAKE_CODEX);
    try {
      const code = await main(["node", "script", "--slug", slug]);
      expect(code).toBe(0);
    } finally {
      writeFakeCodex();
    }
  });

  test("exit 0 (skipped) on codex timeout, with a findings-log entry", async () => {
    const slug = "slug-timeout";
    const dir = makeSlugDir(slug);
    writeFileSync(join(dir, "ISA.md"), "effort: E5\n## Decisions\n");
    process.env.FAKE_CODEX_SLEEP_SEC = "2";
    process.env.FAKE_CODEX_EXIT = "0";
    process.env.FAKE_CODEX_OUTPUT = "";
    const code = await main(["node", "script", "--slug", slug, "--advisor-verdict", "ok"]);
    delete process.env.FAKE_CODEX_SLEEP_SEC;
    expect(code).toBe(0);
    const lastLine = readFileSync(FINDINGS_LOG, "utf8").trim().split("\n").pop()!;
    const parsed = JSON.parse(lastLine);
    expect(parsed.slug).toBe(slug);
    expect(parsed.cato_verdict).toBe("skipped");
    expect(parsed.reason).toBe("codex timeout at 120s");
  });

  test("exit 0 with a parsed verdict on a successful codex run", async () => {
    const slug = "slug-success";
    const dir = makeSlugDir(slug);
    writeFileSync(join(dir, "ISA.md"), "effort: E4\n## Decisions\n");
    process.env.FAKE_CODEX_OUTPUT = '{"verdict":"pass","criticality":"low","findings":[],"agrees_with_advisor":"yes"}';
    process.env.FAKE_CODEX_EXIT = "0";
    const code = await main(["node", "script", "--slug", slug, "--advisor-verdict", "advisor said pass"]);
    expect(code).toBe(0);
    const lastLine = readFileSync(FINDINGS_LOG, "utf8").trim().split("\n").pop()!;
    const parsed = JSON.parse(lastLine);
    expect(parsed.slug).toBe(slug);
    expect(parsed.cato_verdict).toBe("pass");
    expect(parsed.agrees_with_advisor).toBe("yes");
  });
});

// Category 2 (RT-2, AD-9.3): PAI_DIR = LIFEOS_DIR || PAI_DIR || resolveFrameworkDir(HOME); the findings log
// hangs off <PAI_DIR>/MEMORY/VERIFICATION/. PAI_DIR is a module const — re-import under a controlled env
// (unique query busts Bun's cache) and observe where appendFinding writes cato-findings.jsonl.
let rt2Seq = 0;
describe("RT-2 framework-dir resolution — findings-log root (cato)", () => {
  const KEYS = ["LIFEOS_DIR", "PAI_DIR", "HOME"] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function writeFindingUnderEnv(): Promise<typeof import("./cross-vendor-audit")> {
    const mod = await import(`./cross-vendor-audit?rt2=${rt2Seq++}`);
    mod.appendFinding("rt2-slug", "advisor said pass", { verdict: "pass", findings: [] }, "E4");
    return mod;
  }
  const findingsAt = (root: string) => join(root, "MEMORY", "VERIFICATION", "cato-findings.jsonl");

  test("LIFEOS_DIR wins over PAI_DIR", async () => {
    const life = mkdtempSync(join(tmpdir(), "cato-life-"));
    const pai = mkdtempSync(join(tmpdir(), "cato-pai-"));
    process.env.LIFEOS_DIR = life;
    process.env.PAI_DIR = pai;
    try {
      await writeFindingUnderEnv();
      expect(existsSync(findingsAt(life))).toBe(true);
      expect(existsSync(findingsAt(pai))).toBe(false);
    } finally {
      rmSync(life, { recursive: true, force: true });
      rmSync(pai, { recursive: true, force: true });
    }
  });

  test("neither env set → resolver writes under .claude/LIFEOS of a fresh HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "cato-home-rt2-"));
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    process.env.HOME = home;
    try {
      await writeFindingUnderEnv();
      expect(existsSync(findingsAt(join(home, ".claude", "LIFEOS")))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
