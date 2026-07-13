// Story 13.3 — hermetic unit tests for the observability-transport rewrite.
// Covers the swapped internals: P1 core.parseNdjson (via normalizeEvents), P2/P3 http.fetchWithTimeout
// (via injected stub fetcher), plus the frozen-facade shape. No real fs, no network, no ambient clock.

import { test, expect } from 'bun:test';
import {
  normalizeEvents,
  pruneStaleSessions,
  pushToHTTPTarget,
  pushToCFKV,
  pushEventsToTargets,
  pushStateToTargets,
  type EventSource,
  type Fetcher,
} from './observability-transport';

const NOW = new Date('2026-07-13T15:00:00Z');
const NOW_ISO = NOW.toISOString();

// ── P1: collectEvents per-line JSON.parse → core.parseNdjson (via normalizeEvents) ──

test('normalizeEvents parses NDJSON lines and stamps normalized fields', () => {
  const sources: EventSource[] = [
    {
      source: 'voice',
      count: 50,
      content:
        '{"timestamp":"2026-07-13T10:00:00Z","session_id":"s1","event":"spoke"}\n' +
        '{"timestamp":"2026-07-13T11:00:00Z","session_id":"s2","type":"custom"}',
    },
  ];
  const out = normalizeEvents(sources, NOW);
  expect(out.length).toBe(2);
  // newest-first sort
  expect(out[0].session_id).toBe('s2');
  expect(out[1].session_id).toBe('s1');
  // type derives from `event` then `type` then source
  expect(out[1].type).toBe('spoke');
  expect(out[0].type).toBe('custom');
  expect(out[1].source).toBe('voice');
});

test('normalizeEvents skips malformed lines (parseNdjson graceful-skip), keeps valid ones', () => {
  const sources: EventSource[] = [
    { source: 'tool-failure', count: 50, content: '{not json\n{"session_id":"ok"}\n   \nnope' },
  ];
  const out = normalizeEvents(sources, NOW);
  expect(out.length).toBe(1);
  expect(out[0].session_id).toBe('ok');
  expect(out[0].source).toBe('tool-failure');
});

test('normalizeEvents falls back to injected `now` for a missing timestamp (no ambient clock)', () => {
  const sources: EventSource[] = [{ source: 'subagent', count: 50, content: '{"session_id":"x"}' }];
  const out = normalizeEvents(sources, NOW);
  expect(out[0].timestamp).toBe(NOW_ISO);
});

test('normalizeEvents spreads ...parsed LAST (raw record wins over the source tag) — verbatim behavior', () => {
  const sources: EventSource[] = [
    { source: 'voice', count: 50, content: '{"session_id":"s","source":"overridden"}' },
  ];
  const out = normalizeEvents(sources, NOW);
  // original stamps source:s.source then spreads ...parsed, so parsed.source wins
  expect(out[0].source).toBe('overridden');
});

test('normalizeEvents tails last `count` lines per source and caps output at 200', () => {
  const lines = Array.from({ length: 250 }, (_, i) => `{"session_id":"e${i}","timestamp":"2026-07-13T${String(i % 24).padStart(2, '0')}:00:00Z"}`);
  const sources: EventSource[] = [{ source: 'tool-activity', count: 100, content: lines.join('\n') }];
  const out = normalizeEvents(sources, NOW);
  // 100 tailed lines ≤ 200 cap
  expect(out.length).toBe(100);
});

test('normalizeEvents skips null content sources', () => {
  const sources: EventSource[] = [
    { source: 'voice', count: 50, content: null },
    { source: 'subagent', count: 50, content: '{"session_id":"only"}' },
  ];
  const out = normalizeEvents(sources, NOW);
  expect(out.length).toBe(1);
  expect(out[0].session_id).toBe('only');
});

// ── cleanStaleSessions pure core ──

test('pruneStaleSessions drops native > 30min and any session > 2h, keeps fresh', () => {
  const now = NOW.getTime();
  const registry = {
    sessions: {
      freshNative: { phase: 'native', updatedAt: new Date(now - 10 * 60 * 1000).toISOString() },
      staleNative: { phase: 'native', updatedAt: new Date(now - 40 * 60 * 1000).toISOString() },
      oldComplete: { phase: 'complete', updatedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString() },
      oldActive: { phase: 'active', updatedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString() },
      freshActive: { phase: 'active', updatedAt: new Date(now - 5 * 60 * 1000).toISOString() },
    },
  };
  const cleaned = pruneStaleSessions(registry, now);
  expect(cleaned).toBe(true);
  expect(Object.keys(registry.sessions).sort()).toEqual(['freshActive', 'freshNative']);
});

test('pruneStaleSessions uses newer of updatedAt/lastToolActivity (idle-tab detection)', () => {
  const now = NOW.getTime();
  const registry = {
    sessions: {
      // updatedAt keeps getting bumped but no tool activity for >2h — still alive via updatedAt
      chatty: {
        phase: 'active',
        updatedAt: new Date(now - 1 * 60 * 1000).toISOString(),
        lastToolActivity: new Date(now - 5 * 60 * 60 * 1000).toISOString(),
      },
    },
  };
  const cleaned = pruneStaleSessions(registry, now);
  expect(cleaned).toBe(false);
  expect(Object.keys(registry.sessions)).toEqual(['chatty']);
});

// ── P2/P3: fetch → http.fetchWithTimeout, envelope caller-local (injected stub fetcher) ──

function stubFetcher(): { fetcher: Fetcher; calls: Array<{ url: string; opts: any }> } {
  const calls: Array<{ url: string; opts: any }> = [];
  const fetcher: Fetcher = async (url, opts) => {
    calls.push({ url, opts });
    return new Response('ok', { status: 200 });
  };
  return { fetcher, calls };
}

test('pushToHTTPTarget POSTs to url+endpoint with 5s timeout + JSON content-type (P2)', async () => {
  const { fetcher, calls } = stubFetcher();
  await pushToHTTPTarget(
    { name: 'local', type: 'http', url: 'http://localhost:31337' },
    '/api/observability/state',
    '{"work":true}',
    fetcher,
  );
  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe('http://localhost:31337/api/observability/state');
  expect(calls[0].opts.method).toBe('POST');
  expect(calls[0].opts.body).toBe('{"work":true}');
  expect(calls[0].opts.timeout).toBe(5000);
  expect(calls[0].opts.headers['Content-Type']).toBe('application/json');
});

test('pushToHTTPTarget merges target.headers and no-ops without a url', async () => {
  const { fetcher, calls } = stubFetcher();
  await pushToHTTPTarget(
    { name: 'auth', type: 'http', url: 'https://x', headers: { 'X-Token': 'abc' } },
    '/e',
    'b',
    fetcher,
  );
  expect(calls[0].opts.headers['X-Token']).toBe('abc');

  await pushToHTTPTarget({ name: 'no-url', type: 'http' }, '/e', 'b', fetcher);
  expect(calls.length).toBe(1); // still 1 — no-url returned early
});

test('pushToCFKV PUTs to the CF-KV URL with Bearer token + 8s timeout, creds caller-local (P3)', async () => {
  const { fetcher, calls } = stubFetcher();
  await pushToCFKV('sync:events', '[]', fetcher, {
    accountId: 'acc123',
    namespaceId: 'ns456',
    token: 'tok789',
  });
  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe(
    'https://api.cloudflare.com/client/v4/accounts/acc123/storage/kv/namespaces/ns456/values/sync:events',
  );
  expect(calls[0].opts.method).toBe('PUT');
  expect(calls[0].opts.timeout).toBe(8000);
  expect(calls[0].opts.headers['Authorization']).toBe('Bearer tok789');
  expect(calls[0].opts.body).toBe('[]');
});

test('pushToCFKV returns early (no fetch) when account/namespace missing', async () => {
  const { fetcher, calls } = stubFetcher();
  await pushToCFKV('k', 'b', fetcher, { accountId: '', namespaceId: '', token: 't' });
  expect(calls.length).toBe(0);
});

test('pushToCFKV returns early (no fetch) when token missing', async () => {
  const { fetcher, calls } = stubFetcher();
  await pushToCFKV('k', 'b', fetcher, { accountId: 'a', namespaceId: 'n', token: '' });
  expect(calls.length).toBe(0);
});

// ── frozen facade: the two exports resolve their std imports + never throw ──

test('pushEventsToTargets + pushStateToTargets are async no-throw (facade intact, std imports resolved)', async () => {
  // No CF creds in env + local HTTP target unreachable → both fan-outs swallow per-target errors
  // (Promise.allSettled) and resolve. This also proves `parseNdjson`/`fetchWithTimeout` imports load.
  expect(await pushEventsToTargets()).toBeUndefined();
  expect(await pushStateToTargets()).toBeUndefined();
});
