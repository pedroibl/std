#!/usr/bin/env bun
/**
 * SecretScan — Story 12.5 rewrite onto the std substrate (proof/ consumer; live cutover to
 * ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). Behavior preserved; the re-rolled
 * subprocess + NDJSON-parsing plumbing now imports tested std primitives.
 *
 * Scan directories for sensitive information using TruffleHog. Detects 700+ credential types with
 * entropy analysis and pattern matching. Part of PAI CORE Tools.
 *
 * Usage:
 *   bun secret-scan.ts <directory>
 *   bun secret-scan.ts . --verbose
 *   bun secret-scan.ts . --verify
 *
 * ## Options
 * - --verbose: Show detailed information about each finding
 * - --json: Output results in JSON format
 * - --verify: Attempt to verify if credentials are active
 *
 * ## What it detects
 * - API keys (OpenAI, AWS, GitHub, Stripe, etc.)
 * - OAuth tokens
 * - Private keys
 * - Database connection strings
 * - And 700+ other credential types
 *
 * @see ~/.claude/skills/_PAI/Workflows/SecretScanning.md
 *
 * SUBPROCESS CONVERGENCE (Story 10.2 / AD-9): the original `runTruffleHog` was a hand-rolled
 * `spawn`+`Promise` wrapper — one of the three original consumers `spawnCapture`'s header cites as the
 * "reject on launch-failure and nonzero exit" outlier. `spawnCapture` NEVER rejects, so the original's
 * reject-on-anything-outside-{0,183} behavior is RECONSTRUCTED explicitly at this edge: `runTruffleHog`
 * now throws when `result.code` is neither `0` nor `183` — otherwise a real scan failure (a crashed
 * binary, a bad flag, or a missing binary surfacing as `spawnCapture`'s launch-failure sentinel `127`)
 * would be silently swallowed as success, since nothing else in the call chain would notice.
 *
 * STAYS CALLER-LOCAL (D4): the recommendation catalog, the TruffleHog JSON schema (`TruffleHogFinding`),
 * the nonstandard `183` "findings detected" exit code, and the `brew install trufflehog` hint — all
 * TruffleHog-specific / consumer identity, none of it belongs in std.
 */

import { existsSync } from "node:fs";

import { hasFlag, parseNdjson, positional } from "std/core";
import { spawnCapture } from "std/proc";

interface TruffleHogFinding {
  SourceMetadata: {
    Data: {
      Filesystem: {
        file: string;
        line: number;
      };
    };
  };
  DetectorType: string;
  DecoderName: string;
  Verified: boolean;
  Raw: string;
  RawV2: string;
  Redacted: string;
  ExtraData: unknown;
}

// Overridable so a hermetic test can point at a fake `trufflehog` bin; the real default is preserved (D4).
const TRUFFLEHOG_BIN = process.env.SECRETSCAN_TRUFFLEHOG_BIN || "trufflehog";

/**
 * Run TruffleHog via `spawnCapture` (no stdin/timeout — the original passed neither, preserved as-is).
 * `183` is TruffleHog's nonstandard "findings detected" success code, alongside the ordinary `0` — both
 * are treated as success. Anything else (including `spawnCapture`'s own `127` launch-failure sentinel
 * for a missing binary) is raised as an `Error`, reconstructing the promise-reject the original got for
 * free from a real `spawn`+`reject` wrapper.
 */
export async function runTruffleHog(targetDir: string, options: string[]): Promise<string> {
  const args = ["filesystem", targetDir, "--json", "--no-update", ...options];
  const result = await spawnCapture(TRUFFLEHOG_BIN, args);
  if (result.code !== 0 && result.code !== 183) {
    throw new Error(`TruffleHog exited with code ${result.code}: ${result.stderr}`);
  }
  return result.stdout;
}

/** Domain filter: keep only NDJSON records that carry a filesystem finding (edge-level shape guard). */
export function filterFindings(findings: TruffleHogFinding[]): TruffleHogFinding[] {
  return findings.filter((f) => Boolean(f?.SourceMetadata?.Data?.Filesystem));
}

/** Parse TruffleHog's `--json` NDJSON output and keep only filesystem findings. */
export function parseTruffleHogOutput(output: string): TruffleHogFinding[] {
  return filterFindings(parseNdjson<TruffleHogFinding>(output));
}

function formatFindings(findings: TruffleHogFinding[], verbose: boolean): void {
  if (findings.length === 0) {
    console.log("✅ No sensitive information found!");
    return;
  }

  console.log(`🚨 Found ${findings.length} potential secret${findings.length > 1 ? "s" : ""}:\n`);
  console.log("─".repeat(60));

  // Group by severity
  const verified = findings.filter((f) => f.Verified);
  const unverified = findings.filter((f) => !f.Verified);

  if (verified.length > 0) {
    console.log("\n🔴 VERIFIED SECRETS (ACTIVE CREDENTIALS!)");
    console.log("─".repeat(60));
    for (const finding of verified) {
      displayFinding(finding, verbose);
    }
  }

  if (unverified.length > 0) {
    console.log("\n⚠️  POTENTIAL SECRETS (Unverified)");
    console.log("─".repeat(60));
    for (const finding of unverified) {
      displayFinding(finding, verbose);
    }
  }

  // Summary
  console.log("\n📋 SUMMARY & URGENT ACTIONS:");
  console.log("─".repeat(60));

  if (verified.length > 0) {
    console.log("\n🚨 CRITICAL - VERIFIED ACTIVE CREDENTIALS FOUND:");
    console.log("1. IMMEDIATELY rotate/revoke these credentials");
    console.log("2. Check if these were ever pushed to a public repository");
    console.log("3. Audit logs for any unauthorized access");
    console.log("4. Move all secrets to environment variables or secret vaults");
  }

  console.log("\n🛡️  RECOMMENDATIONS:");
  console.log("1. Never commit secrets to git repositories");
  console.log("2. Use .env files for local development (add to .gitignore)");
  console.log("3. Use secret management services for production");
  console.log("4. Set up pre-commit hooks to prevent secret commits");
  console.log("5. Run: git filter-branch or BFG to remove secrets from git history");
}

function displayFinding(finding: TruffleHogFinding, verbose: boolean): void {
  const file = finding.SourceMetadata.Data.Filesystem.file;
  const line = finding.SourceMetadata.Data.Filesystem.line || "unknown";
  const type = finding.DetectorType;
  const verified = finding.Verified ? "✓ VERIFIED" : "✗ Unverified";

  console.log(`\n📄 ${file}`);
  console.log(`   Type: ${type} ${verified}`);
  console.log(`   Line: ${line}`);

  if (verbose) {
    console.log(`   Secret: ${finding.Redacted}`);
    if (finding.ExtraData) {
      console.log(`   Details: ${JSON.stringify(finding.ExtraData, null, 2)}`);
    }
  }

  // Recommendations based on type — caller-local catalog (D4).
  const recommendations: { [key: string]: string } = {
    OpenAI: "Revoke at platform.openai.com, use OPENAI_API_KEY env var",
    AWS: "Rotate via AWS IAM immediately, use AWS Secrets Manager",
    GitHub: "Revoke at github.com/settings/tokens, use GitHub Secrets",
    Stripe: "Roll key at dashboard.stripe.com, use STRIPE_SECRET_KEY env var",
    Slack: "Revoke at api.slack.com/apps, use environment variables",
    Google: "Revoke at console.cloud.google.com, use Secret Manager",
  };

  const recommendation =
    Object.entries(recommendations).find(([key]) => String(type).includes(key))?.[1] ||
    "Remove from code and use secure secret management";

  console.log(`   💡 Fix: ${recommendation}`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const targetDir = positional(argv) || process.cwd();
  const verbose = hasFlag(argv, "verbose");
  const jsonOutput = hasFlag(argv, "json");
  const verify = hasFlag(argv, "verify");

  if (!existsSync(targetDir)) {
    console.error(`❌ Directory not found: ${targetDir}`);
    return 1;
  }

  // Check if trufflehog is installed — literally reproduces the original's odd probe call
  // (`runTruffleHog('--help', [])`, i.e. `targetDir` = "--help"): any non-{0,183} exit (including a
  // missing-binary launch failure) is treated as "not installed".
  try {
    await runTruffleHog("--help", []);
  } catch {
    console.error("❌ TruffleHog is not installed or not in PATH");
    console.error("Install with: brew install trufflehog");
    return 1;
  }

  try {
    const options: string[] = [];
    if (verify) {
      options.push("--verify");
    }

    const output = await runTruffleHog(targetDir, options);

    if (jsonOutput) {
      console.log(output);
    } else {
      formatFindings(parseTruffleHogOutput(output), verbose);
    }

    // Exit with error code if verified secrets found
    const findings = parseTruffleHogOutput(output);
    if (findings.some((f) => f.Verified)) {
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(`❌ Error running TruffleHog: ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
