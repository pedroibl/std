#!/usr/bin/env bun
/**
 * SatisfactionCapture.hook.ts - Implicit & Explicit Satisfaction Rating
 *
 * PURPOSE:
 * Standalone hook that captures user satisfaction with AI responses.
 * Handles both explicit ratings (bare numbers) and implicit sentiment
 * analysis from follow-up behavior.
 *
 * TRIGGER: UserPromptSubmit
 *
 * KEY BEHAVIOR:
 * - Explicit rating (bare "8") → capture directly
 * - Positive praise ("great job") → fast-path rating 8
 * - Neutral follow-up ("now do X") → rating 5 (not skipped)
 * - Happy follow-up ("awesome, now do X") → rating 6-10
 * - Unhappy follow-up ("that's wrong, fix X") → rating 1-4
 * - System text / very short → skip
 *
 * CRITICAL FIX: Previous system returned null for neutral prompts,
 * meaning no rating was recorded. Now EVERY non-system prompt gets a rating.
 * Neutral = 5, not null.
 *
 * ── Story 13.4 rewrite (consumer sweep) — the densest real-win file; two clean swaps, one DEFER:
 *    - P1  readStdinWithTimeout(5000)+JSON.parse (:74-82,323) → std/stdio readStdinJson<HookInput>(5000)
 *    - getRecentContext manual split('\n')+per-line JSON.parse try/catch (:285-308) → std/core parseNdjson
 * POSTURE (AD-9.4 Rule 2): fail-OPEN. The old reader RESOLVED data on timeout (never rejected), and
 *    `JSON.parse('')` threw → caught → exit 0. readStdinJson returns `null` on empty/timeout/malformed →
 *    the rewrite adds an explicit NET-NEW `if (!data) process.exit(0)` VISIBLE branch (input *required*).
 *    Cite src/stdio/read.ts:7-12.
 * DEFERRED — `appendJsonlEvent` NOT adopted for writeRating (validator C1): the load-bearing surrogate-strip
 *    (:164) operates on the POST-JSON.stringify escaped string, but appendJsonlEvent→appendAudit
 *    (src/report/write.ts:119-146) does its OWN internal JSON.stringify with no serializer seam. Stripping
 *    the entry OBJECT first is a no-op (it holds raw code units, not `\u`-escape text), so appendJsonlEvent
 *    would re-introduce the lone surrogate that breaks jq — the exact bug :164 fixes. writeRating stays
 *    hand-rolled (own stringify→strip→appendFileSync). Un-defer: a serializer seam on appendAudit, OR a
 *    JSONL sink with no lone-surrogate exposure. See deferred-work.md §13-4.
 * DEFERRED — date kit (lib/time frozen, 13.7); getLearningCategory (frozen, AC4).
 * FROZEN: ./lib/identity (getIdentity/getPrincipal/getPrincipalName), ./lib/learning-utils
 *    (getLearningCategory), ./lib/time (getISOTimestamp/getPSTComponents), ./lib/isa-utils (addRatingPulse
 *    — 13.5), ../PAI/TOOLS/Inference (a PAI tool, NOT std/http — per 13.3), ../PAI/TOOLS/FailureCapture.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { readStdinJson } from 'std/stdio';
import { parseNdjson } from 'std/core';
import { inference } from '../PAI/TOOLS/Inference';
import { getIdentity, getPrincipal, getPrincipalName } from './lib/identity';
import { getLearningCategory } from './lib/learning-utils';
import { getISOTimestamp, getPSTComponents } from './lib/time';
import { captureFailure } from '../PAI/TOOLS/FailureCapture';
import { addRatingPulse } from './lib/isa-utils';

// ── Types ──

interface HookInput {
  session_id: string;
  prompt?: string;
  user_prompt?: string;
  transcript_path: string;
  hook_event_name: string;
}

interface RatingEntry {
  timestamp: string;
  rating: number;
  session_id: string;
  comment?: string;
  source?: 'implicit' | 'explicit';
  sentiment_summary?: string;
  confidence?: number;
  response_preview?: string;
}

interface SentimentResult {
  rating: number;
  sentiment: 'positive' | 'negative' | 'neutral';
  confidence: number;
  summary: string;
  detailed_context: string;
}

// ── Constants ──

const BASE_DIR = process.env.PAI_DIR || join(process.env.HOME!, '.claude', 'PAI');
const SIGNALS_DIR = join(BASE_DIR, 'MEMORY', 'LEARNING', 'SIGNALS');
const RATINGS_FILE = join(SIGNALS_DIR, 'ratings.jsonl');
const LAST_RESPONSE_CACHE = join(BASE_DIR, 'MEMORY', 'STATE', 'last-response.txt');
const MIN_PROMPT_LENGTH = 3;

// ── Cached Response ──

function getLastResponse(): string {
  try {
    if (existsSync(LAST_RESPONSE_CACHE)) return readFileSync(LAST_RESPONSE_CACHE, 'utf-8');
  } catch {}
  return '';
}

// ── Word-to-Number Map (for "ten", "eight", etc.) ──

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

// ── Explicit Rating Detection ──
//
// An explicit rating is a LONE score — the whole message is just the number
// (modulo trailing punctuation). Anything with a prose tail is conversation,
// not a rating, and must fall through to the context-aware inference path:
//   "1 more thing…", "and 2 please", "3 fixes before Epic 2" were all being
//   force-classified as 1/2/3-out-of-10 and poisoning the learning corpus.
//
// Bare 1–3 are ALSO skipped. They collide with the native Claude Code survey
// ("1:Bad 2:Fine 3:Good", where 3 = good — the inverse of a 1–10 scale) and
// with number-led speech, so a lone 1/2/3 is too ambiguous to treat as a
// deliberate low rating here. The inference path (with its confidence gate)
// judges those from context instead. Genuine ratings are 4–10.
// (Decision 2026-07-16 — the "ambiguous-sentinel" fix.)

const MIN_EXPLICIT_RATING = 4;

function parseExplicitRating(prompt: string): { rating: number; comment?: string } | null {
  // Strip trailing punctuation/whitespace so "8." / "10!" still read as bare.
  const bare = prompt.trim().replace(/[!.?\s]+$/g, '').trim();

  // Word-form ratings ("ten", "Eight") — only when the message IS the word.
  const lower = bare.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(WORD_NUMBERS, lower)) {
    const num = WORD_NUMBERS[lower];
    if (num < MIN_EXPLICIT_RATING) return null; // one/two/three → ambiguous, skip
    return { rating: num };
  }

  // Numeric form — the entire bare message must be exactly the number.
  if (!/^(10|[1-9])$/.test(bare)) return null;
  const rating = parseInt(bare, 10);
  if (rating < MIN_EXPLICIT_RATING || rating > 10) return null; // bare 1–3 → skip

  return { rating };
}

// ── Positive Praise Fast Path ──

const POSITIVE_PRAISE_WORDS = new Set([
  'excellent', 'amazing', 'brilliant', 'fantastic', 'wonderful', 'beautiful',
  'incredible', 'awesome', 'perfect', 'great', 'nice', 'superb', 'outstanding',
  'magnificent', 'stellar', 'phenomenal', 'remarkable', 'terrific', 'splendid',
]);
const POSITIVE_PHRASES = new Set([
  'great job', 'good job', 'nice work', 'well done', 'nice job', 'good work',
  'love it', 'nailed it', 'looks great', 'looks good', 'thats great', 'that works',
]);

// ── System Text Detection ──

const SYSTEM_TEXT_PATTERNS = [
  /^<task-notification>/i,
  /^<system-reminder>/i,
  /^This session is being continued from a previous conversation/i,
  /^Please continue the conversation/i,
  /^Note:.*was read before/i,
];

// ── Rating Writer ──

/** Strip lone UTF-16 surrogates from an ALREADY-`JSON.stringify`-escaped string (e.g. a truncated emoji
 *  at a slice boundary) — they break `jq`. Exported PURE so the DEFER (why writeRating stays hand-rolled
 *  instead of adopting appendJsonlEvent) is testable: the strip MUST run on the post-stringify escape text,
 *  which appendJsonlEvent→appendAudit's own internal stringify would re-introduce the surrogate past. */
export function stripLoneSurrogates(json: string): string {
  return json.replace(/\\ud[89a-f][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})/gi, '');
}

function writeRating(entry: RatingEntry): void {
  if (!existsSync(SIGNALS_DIR)) mkdirSync(SIGNALS_DIR, { recursive: true });
  // Strip lone UTF-16 surrogates that break jq parsing (e.g. truncated emoji at slice boundary).
  // Hand-rolled (NOT appendJsonlEvent) — the strip must run on the post-stringify escaped string (DEFER).
  const json = stripLoneSurrogates(JSON.stringify(entry));
  appendFileSync(RATINGS_FILE, json + '\n', 'utf-8');
  console.error(`[SatisfactionCapture] Wrote ${entry.source} rating ${entry.rating}`);
}

// ── Low Rating Learning Capture ──

function captureLowRatingLearning(
  rating: number,
  summaryOrComment: string,
  detailedContext: string,
  source: 'explicit' | 'implicit'
): void {
  if (rating >= 5) return;
  if (!detailedContext?.trim()) return;

  const { year, month, day, hours, minutes, seconds } = getPSTComponents();
  const yearMonth = `${year}-${month}`;
  const category = getLearningCategory(detailedContext, summaryOrComment);
  const learningsDir = join(BASE_DIR, 'MEMORY', 'LEARNING', category, yearMonth);

  if (!existsSync(learningsDir)) mkdirSync(learningsDir, { recursive: true });

  const label = source === 'explicit' ? `low-rating-${rating}` : `sentiment-rating-${rating}`;
  const filename = `${year}-${month}-${day}-${hours}${minutes}${seconds}_LEARNING_${label}.md`;
  const filepath = join(learningsDir, filename);

  const tags = source === 'explicit'
    ? '[low-rating, improvement-opportunity]'
    : '[sentiment-detected, implicit-rating, improvement-opportunity]';

  const content = `---
capture_type: LEARNING
timestamp: ${year}-${month}-${day} ${hours}:${minutes}:${seconds} PST
rating: ${rating}
source: ${source}
auto_captured: true
tags: ${tags}
---

# ${source === 'explicit' ? 'Low Rating' : 'Implicit Low Rating'} Captured: ${rating}/10

**Date:** ${year}-${month}-${day}
**Rating:** ${rating}/10
**Detection Method:** ${source === 'explicit' ? 'Explicit Rating' : 'Sentiment Analysis'}
${summaryOrComment ? `**Feedback:** ${summaryOrComment}` : ''}

---

## Context

${detailedContext || 'No context available'}

---

## Improvement Notes

This response was rated ${rating}/10 by ${getPrincipalName()}. Use this as an improvement opportunity.

---
`;

  writeFileSync(filepath, content, 'utf-8');
  console.error(`[SatisfactionCapture] Captured low ${source} rating learning`);
}

// ── Inference Prompt ──

const PRINCIPAL_NAME = getPrincipal().name;
const ASSISTANT_NAME = getIdentity().name;

function buildSatisfactionPrompt(): string {
  return `You analyze ${PRINCIPAL_NAME}'s satisfaction with ${ASSISTANT_NAME}'s previous response.

Given the user's current message and the AI's last response, determine how satisfied ${PRINCIPAL_NAME} is.

RATING SCALE:
- 1: Extremely frustrated, angry, "you completely failed"
- 2: Strong frustration, major miss, "this is completely wrong"
- 3: Clear dissatisfaction, corrections needed, "that's not what I said"
- 4: Mild frustration, minor miss, "no, I meant..."
- 5: Neutral — just asking for more work, no emotional indicator either way
- 6: Slight satisfaction, building on work, "now also add..."
- 7: Clear approval, trust signals, "go ahead", "fix all of it"
- 8: Strong approval, short praise, "great", "nice work"
- 9: Very impressed, enthusiastic praise, "this is amazing"
- 10: Extraordinary enthusiasm, exceeded expectations

CRITICAL RULES:
- ALWAYS return a numeric rating (1-10). NEVER return null.
- Default to 5 for neutral task-focused messages with no emotional indicator.
- Profanity can mean frustration OR excitement — read the full context.
- Short follow-up requests with no complaint = 5-6 (satisfied enough to continue).
- A short NEW task, switching topics, asking "what's next", or running a command/skill = 5 (neutral). This is NOT a terse redirect.
- Rate BELOW 5 ONLY when the words carry an explicit complaint, correction, or frustration. Absence of praise is NOT dissatisfaction — when unsure, return 5. Do not infer a complaint from a neutral task-switch.
- Terse redirect that explicitly rejects or re-does the output = 3-4.
- Repeated request because the AI ignored the first ask = 2-3.
- A complaint-laden correction ("no, that's wrong", "you misread me") = 3-4. But a CALM informational correction or clarification ("actually it's X, not Y", "that's for Z, not W") with no complaint about the AI = 5 — corrections are how ${PRINCIPAL_NAME} steers, not how he grumbles.
- ${PRINCIPAL_NAME} is constitutionally direct, terse, and matter-of-fact — that is his normal voice. NEVER lower a rating for brevity, directness, or tone. Tone alone is never evidence of dissatisfaction; require complaint words.
- Building on work enthusiastically = 7-8.
- Simple "ok" or "thanks" = 6.

OUTPUT FORMAT (JSON only):
{
  "rating": <1-10, REQUIRED, never null>,
  "sentiment": "positive" | "negative" | "neutral",
  "confidence": <0.0-1.0>,
  "summary": "<10 words max describing the satisfaction signal>",
  "detailed_context": "<50-150 words: what happened, why this rating, what to learn>"
}`;
}

// ── Recent Transcript Context ──

interface TranscriptEntry {
  type?: string;
  message?: { content?: string | Array<{ type?: string; text?: string }> };
}

/** Build the compact recent-turns context from raw NDJSON transcript text. Exported PURE (the std/core
 *  parseNdjson consumer) so the swap is hermetically testable off the fs path. parseNdjson replaces the
 *  manual `content.trim().split('\n')` + per-line JSON.parse try/catch — same skip-blank/skip-malformed
 *  contract. The user/assistant filtering + 200/150 caps + SUMMARY extraction are preserved caller-local. */
export function extractTurns(content: string, maxTurns: number = 4): string {
  const entries = parseNdjson<TranscriptEntry>(content);
  const turns: { role: string; text: string }[] = [];

  for (const entry of entries) {
    if (entry.type === 'user' && entry.message?.content) {
      let text = '';
      if (typeof entry.message.content === 'string') text = entry.message.content;
      else if (Array.isArray(entry.message.content))
        text = entry.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ');
      if (text.trim()) turns.push({ role: 'User', text: text.slice(0, 200) });
    }
    if (entry.type === 'assistant' && entry.message?.content) {
      const text = typeof entry.message.content === 'string'
        ? entry.message.content
        : Array.isArray(entry.message.content)
          ? entry.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ')
          : '';
      if (text) {
        const summaryMatch = text.match(/SUMMARY:\s*([^\n]+)/i);
        turns.push({ role: 'Assistant', text: summaryMatch ? summaryMatch[1] : text.slice(0, 150) });
      }
    }
  }

  const recent = turns.slice(-maxTurns);
  return recent.length > 0 ? recent.map(t => `${t.role}: ${t.text}`).join('\n') : '';
}

function getRecentContext(transcriptPath: string, maxTurns: number = 4): string {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return '';
    const content = readFileSync(transcriptPath, 'utf-8');
    return extractTurns(content, maxTurns);
  } catch { return ''; }
}

// ══════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════

async function main() {
  try {
    console.error('[SatisfactionCapture] Hook started');
    // P1 (AD-9.4 Rule 2): posture-neutral read. fail-OPEN via an explicit NET-NEW null → exit 0 (the old
    // reader resolved data on timeout and JSON.parse('') threw on empty → both exited 0; now a visible
    // branch not a caught throw). Cite src/stdio/read.ts:7-12.
    const data = await readStdinJson<HookInput>(5000);
    if (!data) { process.exit(0); }
    const prompt = data.prompt || data.user_prompt || '';
    const sessionId = data.session_id;

    if (!prompt || !sessionId) { process.exit(0); }

    // ── SKIP: System text ──
    if (SYSTEM_TEXT_PATTERNS.some(re => re.test(prompt.trim()))) {
      console.error('[SatisfactionCapture] System text, skipping');
      process.exit(0);
    }

    // NOTE: the "prompt too short" gate runs AFTER the explicit fast-path below,
    // so a lone "8" / "10" rating (which is legitimately short) still registers.

    // ── SKIP: slash-command / skill / local-command invocation ──
    // These are workflow ACTIONS, not reactions to a response. Rating them as
    // (dis)satisfaction is the "síndrome de perseguição" — a neutral task-switch
    // read as a complaint. Never rate them.
    const trimmedPrompt = prompt.trim();
    if (/^\//.test(trimmedPrompt)
        || /<command-(name|message|args)>/.test(prompt)
        || /<bash-(input|stdout|stderr)>/.test(prompt)
        || /<local-command-/.test(prompt)) {
      console.error('[SatisfactionCapture] Command/workflow invocation, skipping (not a reaction)');
      process.exit(0);
    }

    // ── FAST PATH: Explicit rating ──
    const explicitResult = parseExplicitRating(prompt);
    if (explicitResult) {
      console.error(`[SatisfactionCapture] Explicit rating: ${explicitResult.rating}`);
      const lastResponse = getLastResponse();
      const entry: RatingEntry = {
        timestamp: getISOTimestamp(),
        rating: explicitResult.rating,
        session_id: sessionId,
        source: 'explicit',
      };
      if (explicitResult.comment) entry.comment = explicitResult.comment;
      if (lastResponse) entry.response_preview = lastResponse.slice(0, 500);
      writeRating(entry);

      addRatingPulse(sessionId, {
        value: explicitResult.rating,
        timestamp: Date.now(),
        message: explicitResult.comment?.slice(0, 32),
      });

      if (explicitResult.rating < 5) {
        captureLowRatingLearning(explicitResult.rating, explicitResult.comment || '', lastResponse, 'explicit');
        if (explicitResult.rating <= 3) {
          await captureFailure({
            transcriptPath: data.transcript_path,
            rating: explicitResult.rating,
            sentimentSummary: explicitResult.comment || `Explicit low rating: ${explicitResult.rating}/10`,
            detailedContext: lastResponse,
            sessionId,
          }).catch((err) => console.error(`[SatisfactionCapture] Failure capture error: ${err}`));
        }
      }
      process.exit(0);
    }

    // ── SKIP: too short to analyze (runs after the explicit fast-path, so a
    //          lone-number rating above is never lost to this gate) ──
    if (prompt.length < MIN_PROMPT_LENGTH) {
      console.error('[SatisfactionCapture] Prompt too short, skipping');
      process.exit(0);
    }

    // ── FAST PATH: Positive praise ──
    const normalizedPrompt = prompt.trim().toLowerCase().replace(/[.!?,'"]/g, '');
    const promptWords = normalizedPrompt.split(/\s+/);
    if (promptWords.length <= 2) {
      if (POSITIVE_PRAISE_WORDS.has(normalizedPrompt) || POSITIVE_PHRASES.has(normalizedPrompt)
          || (promptWords.length === 2 && promptWords.every(w => POSITIVE_PRAISE_WORDS.has(w)))) {
        console.error(`[SatisfactionCapture] Positive praise fast-path: "${prompt.trim()}" → rating 8`);
        const cachedResponse = getLastResponse();
        writeRating({
          timestamp: getISOTimestamp(),
          rating: 8,
          session_id: sessionId,
          source: 'implicit',
          sentiment_summary: `Direct praise: "${prompt.trim()}"`,
          confidence: 0.95,
          ...(cachedResponse ? { response_preview: cachedResponse.slice(0, 500) } : {}),
        });

        addRatingPulse(sessionId, {
          value: 8,
          timestamp: Date.now(),
          message: prompt.trim().slice(0, 32),
        });

        process.exit(0);
      }
    }

    // ── INFERENCE PATH: Implicit satisfaction analysis ──
    // Stagger 2s to avoid racing SessionAnalysis for the same claude --print slot
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.error('[SatisfactionCapture] Running satisfaction inference...');

    const cleanPrompt = prompt.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
    const lastResponse = getLastResponse();
    const context = getRecentContext(data.transcript_path, 4);

    let userPrompt = '';
    if (lastResponse) {
      userPrompt += `PREVIOUS AI RESPONSE (what the user is reacting to):\n${lastResponse.slice(0, 500)}\n\n`;
    }
    if (context) {
      userPrompt += `RECENT CONVERSATION:\n${context}\n\n`;
    }
    userPrompt += `CURRENT USER MESSAGE:\n${cleanPrompt}`;

    try {
      const result = await inference({
        systemPrompt: buildSatisfactionPrompt(),
        userPrompt,
        expectJson: true,
        timeout: 15000,
        level: 'fast',
      });

      if (result.success && result.parsed) {
        const r = result.parsed as SentimentResult;
        // Clamp rating to 1-10, default 5 if missing
        let rating = (r.rating != null && r.rating >= 1 && r.rating <= 10) ? r.rating : 5;
        const confidence = r.confidence || 0.5;

        // Anti-persecution gate: a NEGATIVE read must be confident. When unsure, stay neutral —
        // never manufacture a complaint (and a poisoning LEARNING artifact) from a low-confidence vibe.
        if (rating < 5 && confidence < 0.8) {
          console.error(`[SatisfactionCapture] Negative ${rating}@${confidence} below confidence gate → neutral 5`);
          rating = 5;
        }

        console.error(`[SatisfactionCapture] Implicit: ${rating}/10 (${confidence}) - ${r.summary || 'no summary'}`);

        const cachedResponse = getLastResponse();
        writeRating({
          timestamp: getISOTimestamp(),
          rating,
          session_id: sessionId,
          source: 'implicit',
          sentiment_summary: r.summary || 'Inferred from follow-up behavior',
          confidence,
          ...(cachedResponse ? { response_preview: cachedResponse.slice(0, 500) } : {}),
        });

        addRatingPulse(sessionId, {
          value: rating,
          timestamp: Date.now(),
          message: (r.summary || cleanPrompt).slice(0, 32),
        });

        if (rating < 5) {
          captureLowRatingLearning(rating, r.summary || '', r.detailed_context || '', 'implicit');
          if (rating <= 3) {
            await captureFailure({
              transcriptPath: data.transcript_path,
              rating,
              sentimentSummary: r.summary || '',
              detailedContext: r.detailed_context || '',
              sessionId,
            }).catch((err) => console.error(`[SatisfactionCapture] Failure capture error: ${err}`));
          }
        }
      } else {
        // Inference failed — default to 5 (neutral)
        const errorReason = result.error || 'unknown';
        console.error(`[SatisfactionCapture] Inference failed: ${errorReason} — defaulting to 5`);
        writeRating({
          timestamp: getISOTimestamp(),
          rating: 5,
          session_id: sessionId,
          source: 'implicit',
          sentiment_summary: `Inference failed: ${errorReason.slice(0, 80)}`,
          confidence: 0.3,
        });
      }
    } catch (err) {
      // Inference errored — default to 5 (neutral)
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[SatisfactionCapture] Inference error: ${errMsg} — defaulting to 5`);
      writeRating({
        timestamp: getISOTimestamp(),
        rating: 5,
        session_id: sessionId,
        source: 'implicit',
        sentiment_summary: `Inference error: ${errMsg.slice(0, 80)}`,
        confidence: 0.3,
      });
    }

    process.exit(0);
  } catch (err) {
    console.error(`[SatisfactionCapture] Fatal error: ${err}`);
    process.exit(0);
  }
}

// Entrypoint guard (matches the 13.3 hook idiom): run main() only when invoked as the harness entry —
// `bun SatisfactionCapture.hook.ts` → import.meta.main true → runs identically. Importing the module (the
// hermetic tests do, for extractTurns/stripLoneSurrogates) does NOT execute main. Zero production behavior change.
if (import.meta.main) { main(); }
