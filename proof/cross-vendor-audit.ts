#!/usr/bin/env bun
/**
 * CrossVendorAudit — Story 12.5 rewrite onto the std substrate (proof/ consumer; live cutover to
 * ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). Behavior preserved; the re-rolled
 * subprocess/JSON-extraction/audit-log plumbing now imports tested std primitives.
 *
 * Cato's audit tool. Bundles ISA + artifacts + tool-activity tail + Advisor verdict, pipes to
 * codex exec (GPT-5.4 read-only), parses JSON response, appends to
 * MEMORY/VERIFICATION/cato-findings.jsonl, emits parsed JSON to stdout.
 *
 * Usage:
 *   bun cross-vendor-audit.ts --slug <slug> --advisor-verdict "<text>"
 *
 * Algorithm v3.27 Rule 2a. E4/E5 VERIFY phase only.
 *
 * SUBPROCESS CONVERGENCE (Story 10.2 / AD-9): `invokeCodex` was a hand-rolled `spawn`+`Promise`+
 * `setTimeout` dance (the ORIGIN of `std/proc`'s never-reject/never-hang contract — see proc/index.ts's
 * header). Its synthetic 120s-timeout `code: 124` sentinel is BYTE-IDENTICAL to `spawnCapture`'s
 * `TIMEOUT_CODE`, so the rewrite is a clean swap: `spawnCapture(CODEX_BIN, [...], { stdin, timeout })`
 * replaces the manual promise, and the `code === 124` timeout branch is unchanged.
 *
 * JSON-EXTRACTION SPLIT (D2 — no speculative generalization of `extractJson`): the original regex
 * `/\{[\s\S]*"verdict"[\s\S]*\}/` is KEY-ANCHORED — it only matches a blob that contains `"verdict"`.
 * `std/core.extractJson` does the generic balanced-bracket grab (no key requirement, 1 consumer here) —
 * so the "must look like a Cato response" check stays a CALLER-SIDE post-parse guard
 * (`parsed?.verdict ?? "skipped"`), not a new `extractJson` option.
 *
 * STAYS CALLER-LOCAL (D4): AUDIT_PROMPT / Cato persona, CODEX_BIN default path, the `gpt-5.4` model +
 * `--sandbox read-only` flags, the cost-estimate model, the ISA/tier schema, and every MEMORY/PAI_DIR
 * path (all consumer identity — no path/model/persona lives in std).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { extractJson, flagValue } from "std/core";
import { readIfExists } from "std/fsx";
import { spawnCapture } from "std/proc";
import { appendAudit } from "std/report";

// `process.env.HOME` is honored first so a hermetic test can point the whole PAI/WORK/FINDINGS/
// TOOL-ACTIVITY tree at a mkdtemp fixture (same test-seam discipline as CODEX_BIN below) — `homedir()`
// only backs it up when HOME is unset, which is the same value on any real machine, so no live-tool
// behavior changes.
const HOME = process.env.HOME || homedir();
const PAI_DIR = join(HOME, ".claude", "PAI");
const WORK_DIR = join(PAI_DIR, "MEMORY", "WORK");
const FINDINGS_LOG = join(PAI_DIR, "MEMORY", "VERIFICATION", "cato-findings.jsonl");
const TOOL_ACTIVITY_LOG = join(PAI_DIR, "MEMORY", "OBSERVABILITY", "tool-activity.jsonl");
// Overridable so a hermetic test can point at a fake `codex` bin; the real default is preserved (D4).
const CODEX_BIN = process.env.CATO_CODEX_BIN || join(HOME, ".bun", "bin", "codex");

const BUNDLE_TOKEN_CAP = 80_000;
const CHARS_PER_TOKEN = 4; // rough estimate for bundle sizing
const BUNDLE_CHAR_CAP = BUNDLE_TOKEN_CAP * CHARS_PER_TOKEN;
// Overridable so a hermetic test can inject a short timeout (real default preserved, D4/test seam —
// same discipline as CODEX_BIN below). The "codex timeout at 120s" message text stays a fixed literal
// regardless of the configured value, matching the original's byte-for-byte.
const CODEX_TIMEOUT_MS = Number(process.env.CATO_CODEX_TIMEOUT_MS) || 120_000;
const TOOL_ACTIVITY_TAIL_LINES = 200;
const ARTIFACT_PER_FILE_CAP = 30_000 * CHARS_PER_TOKEN;

const AUDIT_PROMPT = `You are Cato, an independent cross-vendor auditor. The executor (Claude Sonnet) and reviewer (Claude Opus via the Advisor) have already signed off on this work. Your job is to find what THEY missed — specifically Anthropic-family blind spots they share (format conventions, API contract readings, RLHF preferences, constitutional biases).

Audit this ISA against its ISC criteria. For each criterion:
 1. Is there concrete evidence of completion in the artifacts?
 2. Is the evidence consistent with the stated claim?
 3. Are there failure modes the same-family reviewers would share that are present here?

Signal over noise. If the Advisor was right and there is nothing to flag, say so explicitly with "agrees_with_advisor": "yes" and "findings": []. Do not manufacture concerns. Your credibility depends on surfacing real Anthropic-family blind spots, not on inflating finding counts.

Output ONLY this JSON on one line, no markdown, no prose, no preamble:

{"verdict":"pass|concerns|fail","criticality":"high|medium|low","findings":[{"severity":"critical|warning|info","isc_ref":"ISC-N or null","issue":"...","evidence":"..."}],"blind_spots_surfaced":["..."],"agrees_with_advisor":"yes|no|partial","model_used":"gpt-5.4","tokens_used":0}`;

interface Args {
  slug: string;
  advisorVerdict: string;
}

interface CatoResponse {
  verdict: "pass" | "concerns" | "fail" | "skipped" | "error";
  criticality?: "high" | "medium" | "low";
  findings?: Array<{ severity: string; isc_ref: string | null; issue: string; evidence: string }>;
  blind_spots_surfaced?: string[];
  agrees_with_advisor?: "yes" | "no" | "partial";
  model_used?: string;
  tokens_used?: number;
  cost_usd_est?: number;
  reason?: string;
}

export function parseArgs(argv: string[]): Args {
  // core/args.flagValue handles both `--k v` and `--k=v`; argv here is process.argv (incl. the node/
  // script slots), matching the original's `for (i = 2; ...)` walk, so we slice before scanning.
  const rest = argv.slice(2);
  const slug = flagValue(rest, "slug");
  const advisorVerdict = flagValue(rest, "advisor-verdict");
  if (!slug) throw new Error("--slug required");
  return { slug, advisorVerdict: advisorVerdict ?? "(not provided)" };
}

export function readISA(slug: string): string {
  // Read order: ISA.md (canonical, v4.1.0+) → PRD.md (legacy alias, retired at v4.2.0).
  const dir = join(WORK_DIR, slug);
  const isaPath = join(dir, "ISA.md");
  const legacyPath = join(dir, "PRD.md");
  const isaText = readIfExists(isaPath);
  if (isaText !== null) return isaText;
  const legacyText = readIfExists(legacyPath);
  if (legacyText !== null) return legacyText;
  throw new Error(`ISA not found in ${dir} (tried ISA.md and legacy PRD.md)`);
}

export function readArtifacts(isa: string): string {
  // Extract file paths referenced in ISA ## Decisions section.
  const decisionsMatch = isa.match(/## Decisions\n([\s\S]*?)(?=\n## |\n---|\n*$)/);
  if (!decisionsMatch) return "(no ## Decisions section found)";

  const decisions = decisionsMatch[1];
  const pathPattern = /`([~/][^\s`]+\.(?:ts|md|json|yaml|yml|tsx|jsx|js|txt))`/g;
  const paths = new Set<string>();
  let match;
  while ((match = pathPattern.exec(decisions))) {
    let p = match[1];
    if (p.startsWith("~/")) p = join(HOME, p.slice(2));
    paths.add(resolve(p));
  }

  if (paths.size === 0) return "(no file references found in ## Decisions)";

  const chunks: string[] = [];
  let totalChars = 0;
  for (const p of paths) {
    let content = readIfExists(p);
    if (content === null) continue; // not a file, or missing — skip (matches original's existsSync+isFile guard)
    if (content.length > ARTIFACT_PER_FILE_CAP) {
      content = content.slice(0, ARTIFACT_PER_FILE_CAP) + "\n[TRUNCATED]";
    }
    const block = `--- FILE: ${p} ---\n${content}\n`;
    if (totalChars + block.length > BUNDLE_CHAR_CAP / 2) break; // reserve half for other sections
    chunks.push(block);
    totalChars += block.length;
  }
  return chunks.length > 0 ? chunks.join("\n") : "(no readable artifacts found)";
}

export function readToolActivityTail(slug: string): string {
  const content = readIfExists(TOOL_ACTIVITY_LOG);
  if (content === null) return "(tool-activity.jsonl not found)";
  const lines = content.trim().split("\n");
  const recent = lines.slice(-500); // look at last 500 lines total
  const filtered = recent.filter((l) => l.includes(slug)).slice(-TOOL_ACTIVITY_TAIL_LINES);
  return filtered.length > 0 ? filtered.join("\n") : "(no tool-activity lines for this slug)";
}

export function assembleBundle(isa: string, artifacts: string, toolTail: string, advisorVerdict: string): string {
  let bundle = [
    "===== ISA =====",
    isa,
    "",
    "===== OUTPUT ARTIFACTS =====",
    artifacts,
    "",
    "===== TOOL ACTIVITY TAIL =====",
    toolTail,
    "",
    "===== ADVISOR VERDICT =====",
    advisorVerdict,
    "",
    "===== AUDIT INSTRUCTIONS =====",
    AUDIT_PROMPT,
  ].join("\n");

  // If over cap, drop tool-tail first, then trim artifacts.
  if (bundle.length > BUNDLE_CHAR_CAP) {
    bundle = [
      "===== ISA =====",
      isa,
      "",
      "===== OUTPUT ARTIFACTS =====",
      artifacts,
      "",
      "===== TOOL ACTIVITY TAIL =====",
      "(dropped — bundle size cap)",
      "",
      "===== ADVISOR VERDICT =====",
      advisorVerdict,
      "",
      "===== AUDIT INSTRUCTIONS =====",
      AUDIT_PROMPT,
    ].join("\n");
  }
  if (bundle.length > BUNDLE_CHAR_CAP) {
    const overshoot = bundle.length - BUNDLE_CHAR_CAP;
    const trimmed = artifacts.slice(0, Math.max(0, artifacts.length - overshoot - 100));
    bundle = [
      "===== ISA =====",
      isa,
      "",
      "===== OUTPUT ARTIFACTS (trimmed) =====",
      trimmed + "\n[TRUNCATED - bundle size cap]",
      "",
      "===== TOOL ACTIVITY TAIL =====",
      "(dropped — bundle size cap)",
      "",
      "===== ADVISOR VERDICT =====",
      advisorVerdict,
      "",
      "===== AUDIT INSTRUCTIONS =====",
      AUDIT_PROMPT,
    ].join("\n");
  }
  return bundle;
}

/**
 * Invoke codex via `spawnCapture`. The original's 120s-SIGTERM synthetic `code: 124` timeout sentinel
 * is byte-identical to `spawnCapture`'s `TIMEOUT_CODE`, so `code === 124` downstream means the same
 * thing whether it came from a real codex exit or the timeout — no branch changes at the call site.
 */
export async function invokeCodex(bundle: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return spawnCapture(CODEX_BIN, ["exec", "--sandbox", "read-only", "--model", "gpt-5.4", "-"], {
    stdin: bundle,
    timeout: CODEX_TIMEOUT_MS,
  });
}

/**
 * Balanced-bracket grab via `extractJson`, then a CALLER-SIDE "looks like a Cato response" guard
 * (the original's key-anchored regex folded into a post-parse check, D2 — extractJson stays generic).
 */
export function extractCatoResponse(rawStdout: string): CatoResponse {
  const parsed = extractJson<CatoResponse>(rawStdout);
  if (!parsed || typeof parsed !== "object" || !("verdict" in parsed)) {
    return { verdict: "skipped", reason: "no JSON in codex output" };
  }
  return parsed;
}

function estimateCost(tokens: number): number {
  // GPT-5 class rough: $0.015/1K combined. Conservative.
  return +(tokens * 0.000015).toFixed(4);
}

export function appendFinding(slug: string, advisorVerdict: string, response: CatoResponse, tier: string): void {
  const line = {
    timestamp: new Date().toISOString(),
    slug,
    tier,
    advisor_verdict: advisorVerdict.slice(0, 200),
    cato_verdict: response.verdict,
    criticality: response.criticality ?? null,
    unique_findings_count: response.findings?.length ?? 0,
    agrees_with_advisor: response.agrees_with_advisor ?? null,
    tokens: response.tokens_used ?? 0,
    cost_usd: response.cost_usd_est ?? estimateCost(response.tokens_used ?? 0),
    skipped: response.verdict === "skipped",
    reason: response.reason ?? null,
  };
  // Best-effort audit log (FR9) — a failed write must not break the audit run.
  appendAudit(FINDINGS_LOG, line);
}

function extractTier(isa: string): string {
  const m = isa.match(/^effort:\s*(\w+)/m);
  return m ? m[1] : "unknown";
}

export async function main(argv: string[] = process.argv): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(JSON.stringify({ verdict: "error", reason: (err as Error).message }));
    return 2;
  }

  if (!existsSync(CODEX_BIN)) {
    const resp = { verdict: "skipped" as const, reason: "codex CLI not installed" };
    appendFinding(args.slug, args.advisorVerdict, resp, "unknown");
    console.log(JSON.stringify(resp));
    return 0;
  }

  let isa: string;
  try {
    isa = readISA(args.slug);
  } catch (err) {
    const resp = { verdict: "error" as const, reason: (err as Error).message };
    console.log(JSON.stringify(resp));
    return 1;
  }

  const tier = extractTier(isa);
  const artifacts = readArtifacts(isa);
  const toolTail = readToolActivityTail(args.slug);
  const bundle = assembleBundle(isa, artifacts, toolTail, args.advisorVerdict);

  const { stdout, stderr, code } = await invokeCodex(bundle);
  if (code === 124) {
    const resp = { verdict: "skipped" as const, reason: "codex timeout at 120s" };
    appendFinding(args.slug, args.advisorVerdict, resp, tier);
    console.log(JSON.stringify(resp));
    return 0;
  }
  if (code !== 0) {
    const resp = { verdict: "skipped" as const, reason: `codex exit ${code}: ${stderr.slice(0, 200)}` };
    appendFinding(args.slug, args.advisorVerdict, resp, tier);
    console.log(JSON.stringify(resp));
    return 0;
  }

  const parsed = extractCatoResponse(stdout);
  if (parsed.tokens_used && !parsed.cost_usd_est) {
    parsed.cost_usd_est = estimateCost(parsed.tokens_used);
  }
  appendFinding(args.slug, args.advisorVerdict, parsed, tier);
  console.log(JSON.stringify(parsed));
  return 0;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(JSON.stringify({ verdict: "error", reason: err.message }));
      process.exit(1);
    });
}
