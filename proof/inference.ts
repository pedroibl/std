#!/usr/bin/env bun
/**
 * inference — Story 12.5 rewrite onto the std substrate (proof/ consumer; live cutover to
 * ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). Unified inference tool with three run levels +
 * advisor escalation. Behavior preserved EXCEPT the documented JSON-parse upgrade below.
 *
 * USAGE:
 *   bun inference.ts --level fast <system_prompt> <user_prompt>
 *   bun inference.ts --level standard <system_prompt> <user_prompt>
 *   bun inference.ts --level smart <system_prompt> <user_prompt>
 *   bun inference.ts --mode advisor <task> <state> <question>
 *   bun inference.ts --mode advisor --auto-state <task> <question>
 *   bun inference.ts --json --level fast <system_prompt> <user_prompt>
 *
 * OPTIONS:
 *   --level <fast|standard|smart>  Run level (default: standard)
 *   --mode advisor                 Advisor escalation mode — 3 positional args: task, state, question
 *   --auto-state                   Auto-synthesize state from current ISA + recent activity (advisor
 *                                   mode only, 2 positional args: task, question)
 *   --json                         Expect and parse JSON response
 *   --timeout <ms>                 Custom timeout (default varies by level)
 *
 * DEFAULTS BY LEVEL:
 *   fast:     model=haiku,   timeout=15s
 *   standard: model=sonnet,  timeout=30s
 *   smart:    model=opus,    timeout=90s
 *   advisor:  model=opus,    timeout=120s
 *
 * BILLING: Anthropic Messages API via ANTHROPIC_API_KEY (pay-per-use). Falls back to OpenRouter
 * (OPENROUTER_API_KEY) on any primary failure. Both keys live in ~/.claude/.env (op-sourced).
 *
 * SUBSTRATE FINDING #1 — JSON-parse upgrade (NOT byte-identical, intentional): the original
 * hand-rolled parser tried an object-match then an array-match, in that fixed order, regardless of
 * which bracket actually opened first in the model's output. For a response whose top-level shape is
 * an array of objects (`[{"a":1}]`), that ordering resolves to the INNER object `{"a":1}` — a latent
 * bug. `std/core`'s `extractJson` instead orders candidates by FIRST-OPENING BRACKET, so the same input
 * correctly resolves to the ARRAY. This rewrite adopts that behavior directly, per the story's explicit
 * instruction not to re-preserve the old ordering. See `inference.test.ts` for the regression that
 * proves it.
 *
 * SUBSTRATE FINDING #2 [RESOLVED — Epic 17] — `core.dispatch()` didn't fit this CLI's subcommand switch
 * (advisor vs inference): `dispatch()` was sync-only (`Record<string, () => number>`), but both branches
 * here `await` real work (an Anthropic/OpenRouter call). Forcing an async body through a sync handler
 * would either lose the awaited result or return before the work completes — a correctness bug, not a
 * style choice. `gmail.ts` (this same story) hit the identical wall, and the 12.5 sweep found ≥8 CLIs
 * hand-rolling the same `Object.hasOwn`-keyed async map. That is the "async/richer-result variant"
 * `dispatch`'s doc comment deferred "until a real consumer needs it" (D2) — the consumers arrived, so
 * `core.dispatchAsync` was promoted. `main()` below now routes through it (see the note there); this
 * file is one of its two proof-of-adoption consumers (with `tlp-archive.ts`).
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { dispatchAsync, extractJson, flagValue, hasFlag, positional } from "std/core";
// Only httpJson is needed here — both provider calls (Anthropic, OpenRouter) are POST-JSON with a
// parsed-JSON success path, not a raw/non-JSON/streaming fetch, so `fetchWithTimeout` (the transparent
// envelope one layer down) has no direct caller in THIS tool.
import { httpJson } from "std/http";
import { loadJson, readIfExists, resolveFrameworkDir, statMtime, walkFiles } from "std/fsx";

export type InferenceLevel = "fast" | "standard" | "smart";

export interface InferenceOptions {
  systemPrompt: string;
  userPrompt: string;
  level?: InferenceLevel;
  expectJson?: boolean;
  timeout?: number;
  /** Optional image file paths. Read from disk and sent as base64 image blocks
   * (Anthropic) / data-URI image_url parts (OpenRouter). */
  imagePaths?: string[];
}

export interface InferenceResult {
  success: boolean;
  output: string;
  parsed?: unknown;
  error?: string;
  latencyMs: number;
  level: InferenceLevel;
}

// ─── Caller-local identity (D4): level/model config, provider URLs, key resolution ──────────────────

const LEVEL_CONFIG: Record<InferenceLevel, { model: string; defaultTimeout: number }> = {
  fast: { model: "haiku", defaultTimeout: 15000 },
  standard: { model: "sonnet", defaultTimeout: 30000 },
  smart: { model: "opus", defaultTimeout: 90000 },
};

const ADVISOR_TIMEOUT_MS = 120000;

const ANTHROPIC_MODEL: Record<InferenceLevel, string> = {
  fast: "claude-haiku-4-5",
  standard: "claude-sonnet-4-6",
  smart: "claude-opus-4-8",
};
const OPENROUTER_MODEL: Record<InferenceLevel, string> = {
  fast: process.env.PAI_INFERENCE_OR_FAST || "anthropic/claude-haiku-4.5",
  standard: process.env.PAI_INFERENCE_OR_STANDARD || "anthropic/claude-sonnet-4.5",
  smart: process.env.PAI_INFERENCE_OR_SMART || "anthropic/claude-opus-4.1",
};

// Env-overridable so tests can point at a local Bun.serve server; real defaults preserved.
function anthropicUrl(): string {
  return process.env.PAI_INFERENCE_ANTHROPIC_URL || "https://api.anthropic.com/v1/messages";
}
function openRouterUrl(): string {
  return process.env.PAI_INFERENCE_OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions";
}

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_OUTPUT_TOKENS = 4096;

// Env-overridable .env path (tests point this at a temp file or a nonexistent path — never the real
// ~/.claude/.env). Keys live there (op-sourced); hooks spawn with a process env that does NOT auto-load
// it, so read it ourselves and prefer process.env when present. Cached after first read.
function envFilePath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return process.env.PAI_INFERENCE_ENV_FILE || join(home, ".claude", ".env");
}

let _dotEnvCache: Record<string, string> | null = null;
function getEnvKey(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  if (_dotEnvCache === null) {
    _dotEnvCache = {};
    const raw = readIfExists(envFilePath()); // fail-soft: missing/unreadable → null, cache stays empty
    if (raw !== null) {
      for (const line of raw.split("\n")) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        _dotEnvCache[m[1]] = v;
      }
    }
  }
  return _dotEnvCache[name];
}

function mediaType(p: string): string {
  const ext = p.toLowerCase().split(".").pop() || "";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}

interface ProviderResult {
  ok: boolean;
  text: string;
  error?: string;
}

/**
 * Primary — Anthropic Messages API via ANTHROPIC_API_KEY (pay-per-use). POST-JSON call → `httpJson`
 * (fail-loud assert-ok+parse), wrapped in try/catch here to preserve this function's own never-throws
 * `ProviderResult` contract (the caller — `inference()` — orchestrates primary+fallback and expects a
 * soft-fail return, not an exception).
 */
async function callAnthropic(
  level: InferenceLevel,
  system: string,
  userPrompt: string,
  imagePaths: string[] | undefined,
  timeout: number,
): Promise<ProviderResult> {
  const apiKey = getEnvKey("ANTHROPIC_API_KEY");
  if (!apiKey) return { ok: false, text: "", error: "ANTHROPIC_API_KEY not set" };

  let content: unknown = userPrompt;
  if (imagePaths && imagePaths.length > 0) {
    const blocks = imagePaths.map((p) => ({
      type: "image",
      source: { type: "base64", media_type: mediaType(p), data: readFileSync(p).toString("base64") },
    }));
    content = [...blocks, { type: "text", text: userPrompt }];
  }

  try {
    const data = await httpJson<{ stop_reason?: string; content?: Array<{ type?: string; text?: string }> }>(
      anthropicUrl(),
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
        body: JSON.stringify({ model: ANTHROPIC_MODEL[level], max_tokens: MAX_OUTPUT_TOKENS, system, messages: [{ role: "user", content }] }),
        timeout,
      },
    );
    if (data?.stop_reason === "refusal") return { ok: false, text: "", error: "Anthropic refusal" };
    const text = Array.isArray(data?.content)
      ? data.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("")
      : "";
    if (!text) return { ok: false, text: "", error: "Anthropic returned no text" };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, text: "", error: `Anthropic error: ${(err as Error).message}` };
  }
}

/** Fallback — OpenRouter (OpenAI-compatible) via OPENROUTER_API_KEY. Same httpJson treatment. */
async function callOpenRouter(
  level: InferenceLevel,
  system: string,
  userPrompt: string,
  imagePaths: string[] | undefined,
  timeout: number,
): Promise<ProviderResult> {
  const apiKey = getEnvKey("OPENROUTER_API_KEY");
  if (!apiKey) return { ok: false, text: "", error: "OPENROUTER_API_KEY not set" };

  let userContent: unknown = userPrompt;
  if (imagePaths && imagePaths.length > 0) {
    const parts = imagePaths.map((p) => ({
      type: "image_url",
      image_url: { url: `data:${mediaType(p)};base64,${readFileSync(p).toString("base64")}` },
    }));
    userContent = [{ type: "text", text: userPrompt }, ...parts];
  }

  try {
    const data = await httpJson<{ choices?: Array<{ message?: { content?: string } }> }>(openRouterUrl(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: OPENROUTER_MODEL[level], max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: "system", content: system }, { role: "user", content: userContent }] }),
      timeout,
    });
    const text = data?.choices?.[0]?.message?.content || "";
    if (!text) return { ok: false, text: "", error: "OpenRouter returned no text" };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, text: "", error: `OpenRouter error: ${(err as Error).message}` };
  }
}

/**
 * Run inference with configurable level. Default provider: Anthropic Messages API (ANTHROPIC_API_KEY).
 * Falls back to OpenRouter (OPENROUTER_API_KEY) on ANY primary failure — missing/invalid key, non-2xx,
 * refusal, timeout, or network error.
 */
export async function inference(options: InferenceOptions): Promise<InferenceResult> {
  const level = options.level || "standard";
  const startTime = Date.now();
  const timeout = options.timeout || LEVEL_CONFIG[level].defaultTimeout;
  const { systemPrompt, userPrompt, imagePaths } = options;

  let result = await callAnthropic(level, systemPrompt, userPrompt, imagePaths, timeout);
  if (!result.ok) {
    const primaryErr = result.error;
    const fb = await callOpenRouter(level, systemPrompt, userPrompt, imagePaths, timeout);
    if (!fb.ok) {
      return { success: false, output: "", error: `primary(${primaryErr}); fallback(${fb.error})`, latencyMs: Date.now() - startTime, level };
    }
    // data→stdout, logs→stderr — keeps the classifier's stdout parse clean.
    console.error(`[Inference] Anthropic primary failed (${primaryErr}); served via OpenRouter fallback.`);
    result = fb;
  }

  const latencyMs = Date.now() - startTime;
  const output = result.text.trim();

  if (options.expectJson) {
    // See SUBSTRATE FINDING #1 at the top of this file — this is the behavior upgrade, not a
    // byte-identical port. `extractJson` orders by first-opening bracket.
    const parsed = extractJson(output);
    if (parsed === null) {
      return { success: false, output, error: "Failed to parse JSON response", latencyMs, level };
    }
    return { success: true, output, parsed, latencyMs, level };
  }

  return { success: true, output, latencyMs, level };
}

// ─── Advisor state auto-synthesis (D4: MEMORY/WORK + MEMORY/STATE paths, env-overridable) ───────────

function workDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return process.env.PAI_INFERENCE_WORK_DIR || join(resolveFrameworkDir(home), "MEMORY", "WORK");
}
function stateFile(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return process.env.PAI_INFERENCE_STATE_FILE || join(resolveFrameworkDir(home), "MEMORY", "STATE", "work.json");
}

/**
 * Synthesize advisor state from the current ISA + recent activity.
 *
 * Closes the state-gaming Flaw identified by RedTeam review of v3.23 doctrine: when the caller writes
 * the state string manually, the same cognitive model that might have missed the problem decides what
 * the reviewer sees. Auto-synthesis reads the ISA directly so the reviewer gets the unfiltered state.
 *
 * NOT byte-identical to the source: the original listed workDir's direct-child DIRECTORIES, stat'd each
 * one, sorted by mtime, then read `<newest-dir>/ISA.md`. This rewrite instead walks for every `ISA.md`
 * file under workDir (`walkFiles`) and picks the one with the newest mtime (`statMtime`) directly — one
 * pass instead of readdir+stat-per-dir+sort, and the same "most recent session" answer for the normal
 * one-ISA.md-per-slug-dir layout. `walkFiles` is fail-soft per directory (an unreadable dir is skipped,
 * never thrown), so the original's separate "unable to locate active ISA" error path collapses into the
 * same "No active ISA found" message a plain empty result gives — a minor message-text change, not a
 * behavior regression.
 */
export async function synthesizeAdvisorState(): Promise<string> {
  const wd = workDir();

  // work.json may name the active session directly.
  const state = loadJson<{ active?: string; current?: string; activeSession?: string }>(stateFile(), {});
  let activeSlug = state.active || state.current || state.activeSession;
  let isaPath: string | undefined;

  if (activeSlug) {
    isaPath = join(wd, activeSlug, "ISA.md");
  } else {
    const isaFiles = walkFiles(wd, (p) => basename(p) === "ISA.md");
    if (isaFiles.length === 0) {
      return "No active ISA found. Advisor state unavailable.";
    }
    isaPath = isaFiles.reduce((newest, f) => (statMtime(f) > statMtime(newest) ? f : newest));
    activeSlug = basename(dirname(isaPath));
  }

  const prdContent = readIfExists(isaPath);
  if (prdContent === null) {
    return `Active session ${activeSlug} has no ISA.md: ${isaPath}`;
  }

  const MAX_LINES = 300;
  const lines = prdContent.split("\n");
  const truncated = lines.length > MAX_LINES
    ? lines.slice(0, MAX_LINES).join("\n") + `\n\n[... ISA truncated at ${MAX_LINES} lines of ${lines.length} total ...]`
    : prdContent;

  return [
    `ISA: ${activeSlug}`,
    `Source: ${isaPath}`,
    ``,
    `--- ISA CONTENT (verbatim, auto-synthesized from disk — not caller-filtered) ---`,
    truncated,
    `--- END ISA CONTENT ---`,
  ].join("\n");
}

/**
 * Advisor escalation. Calls smart tier (Opus) framed as a reviewer. Caller may supply explicit state OR
 * set autoSynthesize: true to have the helper read the current ISA automatically.
 *
 * Rules:
 * - Call at commitment boundaries: before approach, when stuck, before declaring done
 * - Skip for MEASURED short reactive tasks (<4 min wall-clock AND <2 files)
 * - Extended+ ISA phase:complete = mandatory advisor call
 * - On conflict with empirical: re-call surfacing conflict, max 2 re-calls, then escalate
 */
export interface AdvisorOptions {
  task: string;
  state?: string;
  question: string;
  autoSynthesize?: boolean;
  timeout?: number;
}

export async function advisor(options: AdvisorOptions): Promise<InferenceResult> {
  const systemPrompt = [
    "You are an advisor model invoked at a commitment boundary by an executor model.",
    "Review the executor's task, state, and specific question.",
    "Be direct. Flag risks the executor may have missed.",
    "If you see a fatal flaw, say so. If the approach is sound, confirm and say why.",
    "Your output will be weighed against empirical test results — a passing test does NOT invalidate your review.",
  ].join(" ");

  let resolvedState: string;
  if (options.autoSynthesize) {
    resolvedState = await synthesizeAdvisorState();
  } else if (options.state !== undefined) {
    resolvedState = options.state;
  } else {
    return {
      success: false,
      output: "",
      error: "advisor() requires either state or autoSynthesize: true",
      latencyMs: 0,
      level: "smart",
    };
  }

  const userPrompt = [
    `TASK: ${options.task}`,
    ``,
    `STATE:`,
    resolvedState,
    ``,
    `QUESTION: ${options.question}`,
    ``,
    `Advisory response:`,
  ].join("\n");

  return inference({
    systemPrompt,
    userPrompt,
    level: "smart",
    timeout: options.timeout ?? ADVISOR_TIMEOUT_MS,
  });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────────────────────────

export interface ParsedCliArgs {
  expectJson: boolean;
  autoState: boolean;
  timeout?: number;
  level: InferenceLevel;
  mode: "inference" | "advisor";
  positionalArgs: string[];
}

/**
 * Parse the CLI's argv into flags + positionals.
 *
 * `core.positional()` returns only the FIRST non-`--` token in its input — it is "value-flag-blind":
 * given raw argv like `--level fast <system> <user>`, it can't tell that "fast" is `--level`'s VALUE
 * rather than a genuine positional, so calling it directly on unfiltered argv would misidentify "fast"
 * as the first positional. This CLI has several `--flag value` pairs, so every recognized flag (and,
 * for value-flags, the token right after it) is stripped into a residual array containing ONLY genuine
 * positionals, and that residual is drained with `positional()` in a loop (it only ever returns one
 * token per call) to build the full positional list.
 */
// Value-flags recognized by this CLI grammar — each consumes its own token plus the following value
// token when present, so both can be stripped from the residual before positional extraction.
const VALUE_FLAGS = ["mode", "level", "timeout"] as const;
const BOOL_FLAGS = ["json", "auto-state"] as const;

export function parseCliArgs(args: string[]): ParsedCliArgs {
  const expectJson = hasFlag(args, "json");
  const autoState = hasFlag(args, "auto-state");

  const rawMode = flagValue(args, "mode")?.toLowerCase();
  let mode: "inference" | "advisor" = "inference";
  if (rawMode !== undefined) {
    if (rawMode === "advisor" || rawMode === "inference") {
      mode = rawMode;
    } else {
      console.error(`Invalid mode: ${rawMode}. Use inference or advisor.`);
      process.exit(1);
    }
  }

  const rawLevel = flagValue(args, "level")?.toLowerCase();
  let level: InferenceLevel = "standard";
  if (rawLevel !== undefined) {
    if (rawLevel === "fast" || rawLevel === "standard" || rawLevel === "smart") {
      level = rawLevel;
    } else {
      console.error(`Invalid level: ${rawLevel}. Use fast, standard, or smart.`);
      process.exit(1);
    }
  }

  const rawTimeout = flagValue(args, "timeout");
  const timeout = rawTimeout !== undefined ? parseInt(rawTimeout, 10) : undefined;

  // Strip every recognized flag token (and, for value-flags, the token right after it) into a residual
  // array that contains ONLY genuine positionals — see the doc comment above for why this precedes the
  // `positional()` call rather than handing it raw argv.
  const consumed = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, "");
    if ((BOOL_FLAGS as readonly string[]).includes(name)) {
      consumed.add(i);
    } else if ((VALUE_FLAGS as readonly string[]).includes(name)) {
      consumed.add(i);
      if (args[i + 1] !== undefined) consumed.add(i + 1);
    }
  }
  let residual = args.filter((_, i) => !consumed.has(i));

  const positionalArgs: string[] = [];
  while (true) {
    const p = positional(residual);
    if (p === "") break;
    const idx = residual.indexOf(p);
    residual = [...residual.slice(0, idx), ...residual.slice(idx + 1)];
    positionalArgs.push(p);
  }

  return { expectJson, autoState, timeout, level, mode, positionalArgs };
}

async function runAdvisorCli(opts: { positionalArgs: string[]; autoState: boolean; timeout?: number }): Promise<number> {
  const { positionalArgs, autoState, timeout } = opts;
  if (autoState) {
    if (positionalArgs.length < 2) {
      console.error("Usage: bun inference.ts --mode advisor --auto-state [--json] [--timeout <ms>] <task> <question>");
      return 1;
    }
    const [task, question] = positionalArgs;
    const advisoryResult = await advisor({ task, question, autoSynthesize: true, timeout });
    if (advisoryResult.success) {
      console.log(advisoryResult.output);
      return 0;
    }
    console.error(`Advisor error: ${advisoryResult.error}`);
    return 1;
  }
  if (positionalArgs.length < 3) {
    console.error("Usage: bun inference.ts --mode advisor [--json] [--timeout <ms>] <task> <state> <question>");
    console.error("       bun inference.ts --mode advisor --auto-state [--json] [--timeout <ms>] <task> <question>");
    return 1;
  }
  const [task, state, question] = positionalArgs;
  const advisoryResult = await advisor({ task, state, question, timeout });
  if (advisoryResult.success) {
    console.log(advisoryResult.output);
    return 0;
  }
  console.error(`Advisor error: ${advisoryResult.error}`);
  return 1;
}

async function runInferenceCli(opts: { positionalArgs: string[]; expectJson: boolean; timeout?: number; level: InferenceLevel }): Promise<number> {
  const { positionalArgs, expectJson, timeout, level } = opts;
  if (positionalArgs.length < 2) {
    console.error("Usage: bun inference.ts [--level fast|standard|smart] [--json] [--timeout <ms>] <system_prompt> <user_prompt>");
    return 1;
  }
  const [systemPrompt, userPrompt] = positionalArgs;
  const result = await inference({ systemPrompt, userPrompt, level, expectJson, timeout });
  if (result.success) {
    if (expectJson && result.parsed) {
      console.log(JSON.stringify(result.parsed));
    } else {
      console.log(result.output);
    }
    return 0;
  }
  console.error(`Error: ${result.error}`);
  return 1;
}

async function main(): Promise<number> {
  const parsed = parseCliArgs(process.argv.slice(2));
  const { mode, positionalArgs, autoState, timeout, expectJson, level } = parsed;

  // Subcommand switch → `core.dispatchAsync` (the async sibling this file's SUBSTRATE FINDING #2 called
  // for, now promoted in Epic 17). Same `Object.hasOwn` routing, awaited handlers; `onUnknown` keeps the
  // exact prior error text + exit 1. `mode` is already narrowed to a known key by `parseCliArgs`, so the
  // unknown branch is unreachable here — retained byte-identical for contract stability.
  const handlers: Record<string, () => Promise<number>> = {
    advisor: () => runAdvisorCli({ positionalArgs, autoState, timeout }),
    inference: () => runInferenceCli({ positionalArgs, expectJson, timeout, level }),
  };
  return dispatchAsync(mode, handlers, (m) => {
    console.error(`Invalid mode: ${m}. Use inference or advisor.`);
    return 1;
  });
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
