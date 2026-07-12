// Hermetic proof test for secret-scan.ts (Story 12.5 — proc cluster).
//
// The fake `trufflehog` bin is a shell script controlled via env vars (FAKE_TH_OUTPUT / FAKE_TH_EXIT)
// that `spawnCapture` forwards by inheritance (this tool never passes `opts.env`). It branches on
// argv[2] so the SAME script can answer both call shapes the tool makes: the "is it installed?" probe
// (`runTruffleHog("--help", [])` → args `filesystem --help --json --no-update`) always exits 0, and the
// real scan (`filesystem <targetDir> --json --no-update [--verify]`) echoes FAKE_TH_OUTPUT and exits
// FAKE_TH_EXIT.
//
// SECRETSCAN_TRUFFLEHOG_BIN is read once at import time (like CATO_CODEX_BIN), so it is set before a
// dynamic `import()` — a static import would be hoisted ahead of any env-mutation in this file.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN_DIR = mkdtempSync(join(tmpdir(), "secretscan-bin-"));
const FAKE_TRUFFLEHOG = join(BIN_DIR, "trufflehog");

const FAKE_TRUFFLEHOG_SCRIPT = [
  "#!/bin/sh",
  'if [ "$2" = "--help" ]; then',
  "  exit 0",
  "fi",
  'printf \'%s\' "$FAKE_TH_OUTPUT"',
  'exit "${FAKE_TH_EXIT:-0}"',
  "",
].join("\n");
writeFileSync(FAKE_TRUFFLEHOG, FAKE_TRUFFLEHOG_SCRIPT);
chmodSync(FAKE_TRUFFLEHOG, 0o755);

process.env.SECRETSCAN_TRUFFLEHOG_BIN = FAKE_TRUFFLEHOG;

const { runTruffleHog, filterFindings, parseTruffleHogOutput, main } = await import("./secret-scan");

const SCAN_DIR = mkdtempSync(join(tmpdir(), "secretscan-target-"));
mkdirSync(join(SCAN_DIR, "sub"), { recursive: true });

function findingLine(overrides: Partial<{ file: string; verified: boolean; detector: string }> = {}): string {
  const { file = "config.env", verified = false, detector = "AWS" } = overrides;
  return JSON.stringify({
    SourceMetadata: { Data: { Filesystem: { file, line: 1 } } },
    DetectorType: detector,
    DecoderName: "PLAIN",
    Verified: verified,
    Raw: "secret-raw-value",
    RawV2: "secret-raw-value",
    Redacted: "sec***lue",
    ExtraData: null,
  });
}

// ─── runTruffleHog — {0,183} success branch + reconstructed else-throw ───

describe("runTruffleHog", () => {
  test("exit 0 resolves with stdout", async () => {
    process.env.FAKE_TH_OUTPUT = findingLine() + "\n";
    process.env.FAKE_TH_EXIT = "0";
    const out = await runTruffleHog(SCAN_DIR, []);
    expect(out).toContain('"DetectorType":"AWS"');
  });

  test("exit 183 (findings detected) also resolves with stdout, not a throw", async () => {
    process.env.FAKE_TH_OUTPUT = findingLine({ detector: "Stripe" }) + "\n";
    process.env.FAKE_TH_EXIT = "183";
    const out = await runTruffleHog(SCAN_DIR, []);
    expect(out).toContain('"DetectorType":"Stripe"');
  });

  test("a non-{0,183} exit code is RECONSTRUCTED as a throw (spawnCapture itself never rejects)", async () => {
    process.env.FAKE_TH_OUTPUT = "";
    process.env.FAKE_TH_EXIT = "2";
    await expect(runTruffleHog(SCAN_DIR, [])).rejects.toThrow("TruffleHog exited with code 2");
  });

  test("a missing binary (spawnCapture launch-failure sentinel 127) is also reconstructed as a throw", async () => {
    // Remove the fake bin file entirely (the module-captured path stays the same string; the filesystem
    // lookup at spawn-time is what changes) — spawnCapture resolves code 127 on ENOENT, never rejects,
    // so runTruffleHog must raise explicitly or a real missing-binary condition would look like success.
    rmSync(FAKE_TRUFFLEHOG);
    try {
      await expect(runTruffleHog(SCAN_DIR, [])).rejects.toThrow(/TruffleHog exited with code 127/);
    } finally {
      writeFileSync(FAKE_TRUFFLEHOG, FAKE_TRUFFLEHOG_SCRIPT);
      chmodSync(FAKE_TRUFFLEHOG, 0o755);
    }
  });
});

// ─── filterFindings / parseTruffleHogOutput — the domain filter at the edge ───

describe("filterFindings / parseTruffleHogOutput", () => {
  test("keeps only records shaped like a filesystem finding, skips garbage lines", () => {
    const ndjson = [findingLine({ file: "a.env" }), "not json at all", '{"no":"filesystem field"}', findingLine({ file: "b.env" })].join(
      "\n",
    );
    const findings = parseTruffleHogOutput(ndjson);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.SourceMetadata.Data.Filesystem.file)).toEqual(["a.env", "b.env"]);
  });

  test("filterFindings drops records without SourceMetadata.Data.Filesystem", () => {
    const shaped = JSON.parse(findingLine());
    const unshaped = JSON.parse('{"SourceMetadata":{"Data":{}},"DetectorType":"X","Verified":false}');
    const out = filterFindings([shaped, unshaped]);
    expect(out).toHaveLength(1);
  });
});

// ─── main — exit-code contract: 1 ONLY on a verified finding, else 0; not-installed; bad target dir ───

describe("main", () => {
  test("target directory not found → exit 1", async () => {
    const code = await main([join(tmpdir(), "no-such-secretscan-dir-xyz")]);
    expect(code).toBe(1);
  });

  test("unverified findings → exit 0", async () => {
    process.env.FAKE_TH_OUTPUT = findingLine({ verified: false }) + "\n";
    process.env.FAKE_TH_EXIT = "0";
    const code = await main([SCAN_DIR, "--json"]);
    expect(code).toBe(0);
  });

  test("a verified finding → exit 1", async () => {
    process.env.FAKE_TH_OUTPUT = findingLine({ verified: true, file: "prod.env" }) + "\n";
    process.env.FAKE_TH_EXIT = "0";
    const code = await main([SCAN_DIR, "--json"]);
    expect(code).toBe(1);
  });

  test("183 (findings detected) with no verified finding → exit 0", async () => {
    process.env.FAKE_TH_OUTPUT = findingLine({ verified: false }) + "\n";
    process.env.FAKE_TH_EXIT = "183";
    const code = await main([SCAN_DIR]);
    expect(code).toBe(0);
  });

  test("positional target + --verbose + --verify are accepted without changing the exit contract", async () => {
    process.env.FAKE_TH_OUTPUT = findingLine({ verified: false }) + "\n";
    process.env.FAKE_TH_EXIT = "0";
    const code = await main(["--verbose", SCAN_DIR, "--verify"]);
    expect(code).toBe(0);
  });

  test("a scan failure (non-{0,183} exit) surfaces as exit 1, not a crash", async () => {
    process.env.FAKE_TH_OUTPUT = "";
    process.env.FAKE_TH_EXIT = "2";
    const code = await main([SCAN_DIR]);
    expect(code).toBe(1);
  });

  test("a missing trufflehog binary is reported as 'not installed', exit 1", async () => {
    const realBin = process.env.SECRETSCAN_TRUFFLEHOG_BIN!;
    // Point the ALREADY-IMPORTED module's env lookup at a nonexistent path is impossible post-import
    // (the bin path is a module-level constant captured once) — so this exercises the SAME fake bin's
    // --help probe returning a non-{0,183} code instead, which the tool treats identically ("not
    // installed" is really "the install-check probe failed"). Simulate that by making the probe itself
    // fail: override FAKE_TH_EXIT so even the `$2 = --help` branch is bypassed by exiting nonzero first.
    const failingScript = ["#!/bin/sh", "exit 5", ""].join("\n");
    writeFileSync(realBin, failingScript);
    chmodSync(realBin, 0o755);
    try {
      const code = await main([SCAN_DIR]);
      expect(code).toBe(1);
    } finally {
      writeFileSync(realBin, FAKE_TRUFFLEHOG_SCRIPT);
      chmodSync(realBin, 0o755);
    }
  });
});
