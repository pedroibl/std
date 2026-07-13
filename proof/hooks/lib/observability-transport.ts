// observability-transport.ts -- Transport module for PAI observability pipeline
//
// Story 13.3 rewrite onto the std substrate (authored in the std-public proof/ mirror; the DEPLOYED
// lib imports the REAL sibling shims by their identical relative strings). This is a CONSUMER SWEEP:
// re-hand-rolled primitives swapped for tested std slices, ALL behavior + the frozen facade preserved
// byte-for-byte.
//
// FROZEN FACADE (AD-9.4 Rule 3 / AC7): the two exports below have identical signatures — ToolActivityTracker
// + 2 other cross-cluster importers depend on them:
//   pushStateToTargets(): Promise<void>
//   pushEventsToTargets(): Promise<void>
//
// PRIMITIVE SWAPS:
//   P1  collectEvents per-line JSON.parse (src :132-136) → core.parseNdjson (via normalizeEvents)
//   P2  pushToHTTPTarget fetch + AbortSignal.timeout(5000) (src :164-178) → http.fetchWithTimeout, MINUS envelope
//   P3  pushToCFKV fetch + manual AbortController/setTimeout(8000) (src :185-217) → http.fetchWithTimeout, MINUS envelope
//
// CALLER-LOCAL (D4): the CF-KV URL, `Bearer` token, account/namespace ids, the 5s/8s timeouts, the 4
// source paths + per-source counts, the event-normalization shape, and cleanStaleSessions' thresholds all
// stay in this consumer — only the timeout-envelope + per-line-parse mechanics move to std.
//
// DEFER (AC10): readEnvOrPaiEnv's dotenv `KEY=val` parse (src :27-33) stays hand-rolled — 1 consumer, so
// no core.parseDotenv is promoted yet.
//
// BEHAVIORAL DELTAS: (1) the HTTP + CF-KV pushes now time out via fetchWithTimeout's own
// AbortController+setTimeout envelope instead of `AbortSignal.timeout` / a hand-rolled controller — same
// abort semantics, same 5s/8s bounds. (2) collectEvents' `new Date().toISOString()` fallback clock is now
// injected as `now` into the pure normalizeEvents (main() passes `new Date()`), so tests are hermetic.

import { getObservabilityConfig } from './identity';
import { readRegistry, writeRegistry, WORK_JSON } from './isa-utils';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { ObservabilityTarget } from './identity';
import { getEnvPath } from './paths';
import { parseNdjson } from 'std/core';
import { fetchWithTimeout } from 'std/http';
import type { FetchOpts } from 'std/http';

// A raw-Response fetcher, injectable so the push helpers are testable with no network. Defaults to the
// std timeout envelope (the real edge); tests pass a stub. Matches http.fetchWithTimeout's signature.
export type Fetcher = (url: string, opts?: FetchOpts) => Promise<Response>;

function readEnvOrPaiEnv(keys: readonly string[]): string {
  for (const k of keys) {
    const v = process.env[k];
    if (v) return v;
  }

  try {
    // DEFER (AC10): hand-rolled dotenv KEY=val parse — 1 consumer, no core.parseDotenv promoted.
    const envPath = getEnvPath();
    const envContent = readFileSync(envPath, 'utf-8');
    const env: Record<string, string> = {};
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
    for (const k of keys) {
      if (env[k]) return env[k];
    }
  } catch {}

  return '';
}

/**
 * Resolve Cloudflare API token.
 * Tries CLOUDFLARE_API_TOKEN_WORKERS_EDIT first, then falls back to
 * CLOUDFLARE_API_TOKEN (the one main token). Checks env vars, then ~/.claude/.env.
 */
function getCFToken(): string {
  const KEYS = ['CLOUDFLARE_API_TOKEN_WORKERS_EDIT', 'CLOUDFLARE_API_TOKEN'] as const;
  return readEnvOrPaiEnv(KEYS);
}

function getCFAccountId(): string {
  const value = readEnvOrPaiEnv(['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID'] as const);
  if (value) return value;

  process.stderr.write(
    '[observability-transport] CLOUDFLARE_ACCOUNT_ID / CF_ACCOUNT_ID missing; CF KV transport will be skipped\n'
  );
  return '';
}

function getCFNamespaceId(): string {
  const value = readEnvOrPaiEnv(['CLOUDFLARE_KV_NAMESPACE_ID', 'CF_KV_NAMESPACE_ID'] as const);
  if (value) return value;

  process.stderr.write(
    '[observability-transport] CLOUDFLARE_KV_NAMESPACE_ID / CF_KV_NAMESPACE_ID missing; CF KV transport will be skipped\n'
  );
  return '';
}

/**
 * Clean stale sessions from a registry (pure/injectable core).
 * Age is measured against the newer of `lastToolActivity` and `updatedAt` so an idle tab (no tool calls)
 * is recognized as stale even if prompts keep bumping `updatedAt`.
 * - Native/starting sessions older than 30 min
 * - Any session (including complete) older than 2 hours
 * Mutates `registry` in place, returns true if any session was removed. `now` injected for hermetic tests.
 */
export function pruneStaleSessions(registry: { sessions: Record<string, any> }, now: number): boolean {
  const THIRTY_MIN = 30 * 60 * 1000;
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  let cleaned = false;

  for (const [slug, session] of Object.entries(registry.sessions) as [string, any][]) {
    const updatedMs = new Date(session.updatedAt || session.started || 0).getTime();
    const toolMs = session.lastToolActivity ? new Date(session.lastToolActivity).getTime() : 0;
    const lastAlive = Math.max(updatedMs, toolMs);
    const age = now - lastAlive;
    const phase = (session.phase || '').toLowerCase();

    if ((phase === 'native' || phase === 'starting') && age > THIRTY_MIN) {
      delete registry.sessions[slug];
      cleaned = true;
    } else if (phase === 'complete' && age > TWO_HOURS) {
      delete registry.sessions[slug];
      cleaned = true;
    } else if (age > TWO_HOURS) {
      delete registry.sessions[slug];
      cleaned = true;
    }
  }

  return cleaned;
}

/**
 * Clean stale sessions from the registry (impure shell over pruneStaleSessions).
 * Reads the registry via isa-utils, prunes against the wall clock, writes back if anything was cleaned.
 * Returns true if cleaned.
 */
function cleanStaleSessions(): boolean {
  const registry = readRegistry();
  const cleaned = pruneStaleSessions(registry, Date.now());
  if (cleaned) writeRegistry(registry);
  return cleaned;
}

/** One JSONL event source: its logical `source` tag, the per-source tail `count`, and its raw file content
 *  (null when the file is absent/unreadable). The path→content read is done by the impure collectEvents. */
export interface EventSource {
  source: string;
  count: number;
  content: string | null;
}

/**
 * Normalize recent events from JSONL source contents (pure/injectable core).
 * For each source: takes the last `count` non-blank lines, parses them with core.parseNdjson (malformed
 * lines skipped, P1 swap), stamps normalized fields (spreading `...parsed` LAST so the raw record wins —
 * preserved verbatim from the original). Sorts newest-first, keeps the first 200. `now` injected for the
 * timestamp fallback so there is no ambient clock.
 */
export function normalizeEvents(sources: readonly EventSource[], now: Date): any[] {
  const nowIso = now.toISOString();
  const allEvents: any[] = [];

  for (const s of sources) {
    if (!s.content) continue;
    const lines = s.content.trim().split('\n').filter(l => l.trim());
    const recent = lines.slice(-s.count);
    // P1: per-line JSON.parse (src :134-136) → core.parseNdjson over the already-tailed lines.
    for (const parsed of parseNdjson<Record<string, any>>(recent.join('\n'))) {
      allEvents.push({
        timestamp: parsed.timestamp || nowIso,
        session_id: parsed.session_id || '',
        source: s.source,
        type: parsed.event || parsed.type || s.source,
        ...parsed,
      });
    }
  }

  // Sort newest first (matches Observability/observability.ts), keep first 200
  allEvents.sort((a, b) => {
    const ta = new Date(a.timestamp).getTime() || 0;
    const tb = new Date(b.timestamp).getTime() || 0;
    return tb - ta;
  });

  return allEvents.slice(0, 200);
}

/** Best-effort read of one JSONL source: null when absent or unreadable (matches the original per-source
 *  try/catch that skips missing/erroring files). */
function readSource(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Collect recent events from JSONL sources (impure shell over normalizeEvents).
 * Reads voice-events.jsonl / tool-failures.jsonl / tool-activity.jsonl / subagent-events.jsonl (the 4
 * caller-local source paths + per-source counts), then normalizes against the wall clock.
 */
function collectEvents(): any[] {
  const HOME = process.env.HOME || '';
  // Per-source counts match Observability/observability.ts handleEventsRecentApi()
  const sources = [
    { path: join(HOME, '.claude', 'PAI', 'MEMORY', 'VOICE', 'voice-events.jsonl'), source: 'voice', count: 50 },
    { path: join(HOME, '.claude', 'PAI', 'MEMORY', 'OBSERVABILITY', 'tool-failures.jsonl'), source: 'tool-failure', count: 50 },
    { path: join(HOME, '.claude', 'PAI', 'MEMORY', 'OBSERVABILITY', 'tool-activity.jsonl'), source: 'tool-activity', count: 100 },
    { path: join(HOME, '.claude', 'PAI', 'MEMORY', 'OBSERVABILITY', 'subagent-events.jsonl'), source: 'subagent', count: 50 },
  ];

  const withContent: EventSource[] = sources.map(s => ({
    source: s.source,
    count: s.count,
    content: readSource(s.path),
  }));

  return normalizeEvents(withContent, new Date());
}

/**
 * Push payload to an HTTP target.
 * POST to target.url + endpoint with JSON body, 5s timeout. Includes target.headers if present.
 * P2: the raw `fetch` + `AbortSignal.timeout(5000)` envelope → http.fetchWithTimeout (`timeout: 5000`
 * caller-local). `fetcher` injectable for hermetic tests (defaults to the real std edge).
 */
export async function pushToHTTPTarget(
  target: ObservabilityTarget,
  endpoint: string,
  body: string,
  fetcher: Fetcher = fetchWithTimeout,
): Promise<void> {
  if (!target.url) return;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(target.headers || {}),
  };

  await fetcher(`${target.url}${endpoint}`, {
    method: 'POST',
    headers,
    body,
    timeout: 5000,
  });
}

/** Resolved CF-KV credentials — caller-local (D4). Optional override lets tests inject creds without env. */
export interface CFKVCreds {
  accountId: string;
  namespaceId: string;
  token: string;
}

/**
 * Push payload to Cloudflare KV.
 * PUT to the CF KV API with bearer token, 8s timeout. Silently returns if account/namespace/token missing.
 * P3: the hand-rolled AbortController + setTimeout(8000) + clearTimeout envelope → http.fetchWithTimeout
 * (`timeout: 8000` caller-local). The CF-KV URL, `Bearer` token, account/namespace ids all stay here.
 * `fetcher`/`creds` injectable for hermetic tests (default to the real std edge + env-resolved creds).
 */
export async function pushToCFKV(
  key: string,
  body: string,
  fetcher: Fetcher = fetchWithTimeout,
  creds?: CFKVCreds,
): Promise<void> {
  const accountId = creds?.accountId ?? getCFAccountId();
  const namespaceId = creds?.namespaceId ?? getCFNamespaceId();
  if (!accountId || !namespaceId) return;

  const token = creds?.token ?? getCFToken();
  if (!token) {
    process.stderr.write(
      `[pushToCFKV] ${key}: no CF token resolved (set CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_TOKEN_WORKERS_EDIT in ~/.claude/.env)\n`
    );
    return;
  }

  await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
      timeout: 8000,
    }
  );
}

/**
 * Push work state to all configured observability targets.
 * Cleans stale sessions first, reads work.json, then fans out via Promise.allSettled.
 */
export async function pushStateToTargets(): Promise<void> {
  try {
    cleanStaleSessions();

    if (!existsSync(WORK_JSON)) return;
    const workData = readFileSync(WORK_JSON, 'utf-8');

    const config = getObservabilityConfig();
    const promises = config.targets.map(async (target) => {
      try {
        if (target.type === 'cloudflare-kv') {
          await pushToCFKV('sync:work_state', workData);
        } else if (target.type === 'http') {
          await pushToHTTPTarget(target, '/api/observability/state', workData);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[pushStateToTargets] ${target.name}: ${msg}\n`);
      }
    });

    await Promise.allSettled(promises);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[pushStateToTargets] Failed: ${msg}\n`);
  }
}

/**
 * Push collected events to all configured observability targets.
 * Collects recent events from JSONL sources, then fans out via Promise.allSettled.
 */
export async function pushEventsToTargets(): Promise<void> {
  try {
    const events = collectEvents();
    const eventsJson = JSON.stringify(events);

    const config = getObservabilityConfig();
    const promises = config.targets.map(async (target) => {
      try {
        if (target.type === 'cloudflare-kv') {
          await pushToCFKV('sync:events', eventsJson);
        } else if (target.type === 'http') {
          await pushToHTTPTarget(target, '/api/observability/events', eventsJson);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[pushEventsToTargets] ${target.name}: ${msg}\n`);
      }
    });

    await Promise.allSettled(promises);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[pushEventsToTargets] Failed: ${msg}\n`);
  }
}
