#!/usr/bin/env bun
/**
 * RepeatDetection.hook.ts — UserPromptSubmit hook
 *
 * Detects when the user is repeating a previous request (indicating the AI
 * missed their intent). When triggered, injects a high-priority WARNING into
 * the model's context forcing re-reading of the user's message.
 *
 * Algorithm v3.19.0 Layer 2: Safety net for intent drift.
 *
 * Story 13.8 rewrite (context & prompt lifecycle cluster — WIRED UserPromptSubmit, CAN BLOCK):
 *   - stdin: SYNC readFileSync('/dev/stdin')+JSON.parse (:59) → std/stdio.readStdinJson<HookInput>(1000)
 *     → main() becomes ASYNC (the sync→async migration). 1000 = the std default, passed explicitly (a
 *     UserPromptSubmit hook needs no longer window). POSTURE (AD-9.4 Rule 2 — fail-OPEN): null
 *     (empty/malformed/timeout) → exit 0 (a bad read never blocks a prompt). Cite src/stdio/read.ts:7-12.
 *   - PRESERVED: the DELIBERATE `process.exit(2)` repeat-BLOCK (stderr fed to Claude). AD-9.4 Rule 2
 *     fail-open applies to the NULL READ, NOT to this intentional duplicate-prompt block — it stays.
 *   - DEFER core.tokenize (:26-32) — local filters length>2 + [^\w\s] (keeps underscore); std filters
 *     >1 + [^a-z0-9\s-] (keeps hyphen). Different token sets → different repeat verdicts. Kept caller-local.
 *   - DEFER core.jaccard (:46-54) — jaccardSimilarity(a:Set,b:Set) consumes PRE-BUILT trigram Sets;
 *     core.jaccard(a:string,b:string) tokenizes internally (signature mismatch). Kept caller-local.
 *   - DEFER ngrams/trigrams (:34-44) — 1 consumer → kept caller-local (extends the similarity kit later).
 *   saveCurrentPrompt (state write) + STATE_FILE stay caller-local.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { readStdinJson } from "std/stdio";

const STATE_FILE = join(
  process.env.HOME || "",
  ".claude/PAI/MEMORY/STATE/last-prompt.json",
);

interface HookInput {
  session_id: string;
  message?: { content?: string; role?: string };
  prompt?: string;
}

// DEFERRED (13.8): local noise-filter is length>2 + [^\w\s] (keeps underscore) — NOT core.tokenize
// (>1 + [^a-z0-9\s-], keeps hyphen). Byte-different token sets → kept caller-local.
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

// DEFERRED (13.8): 1 consumer — extends the similarity kit later (D2).
function trigrams(tokens: string[]): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i <= tokens.length - 3; i++) {
    grams.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  // Also add bigrams for shorter messages
  for (let i = 0; i <= tokens.length - 2; i++) {
    grams.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return grams;
}

// DEFERRED (13.8): operates on PRE-BUILT trigram Sets — core.jaccard(a:string,b:string) tokenizes
// raw strings internally (signature mismatch, cannot consume the ngram Sets). Kept caller-local;
// promote a `jaccardSets` only at a 2nd consumer.
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

async function main(): Promise<void> {
  // fail-OPEN (AD-9.4 Rule 2): null (empty/malformed/timeout) → exit 0. A bad read never blocks a
  // prompt. This REPLACES the sync readFileSync('/dev/stdin')+JSON.parse+try/catch. Cite src/stdio/read.ts:7-12.
  const input = await readStdinJson<HookInput>(1000);
  if (!input) process.exit(0);

  const currentPrompt =
    input.prompt ||
    input.message?.content ||
    "";

  // Exempt system-injected background events. A <task-notification> is an
  // automated background-task completion — explicitly "NOT a message from the
  // user" — so a USER-repeat detector must never fire on it. In loops that
  // dispatch one background watchdog per iteration (e.g. Epic-the-Loop's
  // per-story review watchdogs), consecutive notifications are near-identical
  // ("...watchdog for 1.10 review" vs "1.11 review") and would false-trigger,
  // blocking the flow. Skip WITHOUT overwriting the last real user prompt, so
  // genuine user repeats are still compared correctly against the last real one.
  if (currentPrompt.includes("<task-notification>")) {
    process.exit(0);
  }

  // Skip very short messages (ratings, acknowledgments, greetings)
  if (currentPrompt.length < 20) {
    saveCurrentPrompt(currentPrompt, input.session_id);
    process.exit(0);
  }

  // Load previous prompt
  let previousPrompt = "";
  let previousSessionId = "";
  if (existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
      previousPrompt = state.prompt || "";
      previousSessionId = state.session_id || "";
    } catch {
      // Corrupted state file — skip
    }
  }

  // Only compare within the same session
  if (previousSessionId !== input.session_id || !previousPrompt) {
    saveCurrentPrompt(currentPrompt, input.session_id);
    process.exit(0);
  }

  // Compare current to previous
  const currentTokens = tokenize(currentPrompt);
  const previousTokens = tokenize(previousPrompt);

  const currentGrams = trigrams(currentTokens);
  const previousGrams = trigrams(previousTokens);

  const similarity = jaccardSimilarity(currentGrams, previousGrams);

  // Save current prompt as the new "previous"
  saveCurrentPrompt(currentPrompt, input.session_id);

  // Threshold: 0.6 (60%) similarity triggers warning
  if (similarity >= 0.6) {
    // Output warning to stderr — this gets injected into model context
    process.stderr.write(
      `⚠️ REPEAT DETECTION: This message is ${Math.round(similarity * 100)}% similar to the previous message. ` +
      `The user is likely REPEATING a request you missed. ` +
      `STOP. Re-read their message carefully. Do NOT proceed with what you were doing before. ` +
      `Address their ACTUAL request this time.`,
    );
    // Exit 2 = blocking error, stderr fed to Claude. PRESERVED through the sync→async conversion:
    // this is a DELIBERATE duplicate-prompt block, not a null-read posture — it must stay non-zero.
    process.exit(2);
  }

  process.exit(0);
}

function saveCurrentPrompt(prompt: string, sessionId: string): void {
  try {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({
        prompt,
        session_id: sessionId,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {
    // Non-critical — silently fail
  }
}

main();
