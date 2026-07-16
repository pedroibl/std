// Story 13.7 — notifications.ts split: session-timing on fsx, sendPush on http.fetchWithTimeout.
// Hermetic via the injection seams (a temp `file` path; injected config + fetcher) — no real network,
// no clobbering of the real /tmp/pai-session-start.txt.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessionDurationMinutes, recordSessionStart, sendPush, type NtfyConfig } from './notifications';

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'notif-13-7-')); });
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

describe('session timing (fsx atomicWrite / readIfExists round-trip)', () => {
  test('record → duration is ~0 for a just-written file', () => {
    const f = join(tmp, 'start.txt');
    recordSessionStart(f);
    const mins = getSessionDurationMinutes(f);
    expect(mins).toBeGreaterThanOrEqual(0);
    expect(mins).toBeLessThan(1);
  });
  test('missing file → 0 (fail-soft)', () => {
    expect(getSessionDurationMinutes(join(tmp, 'nope.txt'))).toBe(0);
  });
});

describe('sendPush (injected config + fetcher — no network)', () => {
  const enabled: NtfyConfig = { enabled: true, topic: 'pai', server: 'ntfy.sh' };

  test('disabled config → false, fetcher never called', async () => {
    let called = false;
    const r = await sendPush('hi', {}, {
      loadConfig: () => ({ enabled: false, topic: '', server: 'ntfy.sh' }),
      fetcher: async () => { called = true; return { ok: true }; },
    });
    expect(r).toBe(false);
    expect(called).toBe(false);
  });

  test('enabled → POSTs https://server/topic with mapped headers, returns .ok', async () => {
    let url = '';
    let init: any;
    const r = await sendPush('hello', { title: 'T', priority: 'high', tags: ['a', 'b'] }, {
      loadConfig: () => enabled,
      fetcher: async (u, i) => { url = u; init = i; return { ok: true }; },
    });
    expect(r).toBe(true);
    expect(url).toBe('https://ntfy.sh/pai');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('hello');
    expect(init.headers.Title).toBe('T');
    expect(init.headers.Priority).toBe('4'); // high → 4
    expect(init.headers.Tags).toBe('a,b');
    expect(init.timeout).toBe(5000);
  });

  test('a non-ok Response returns false', async () => {
    const r = await sendPush('x', {}, { loadConfig: () => enabled, fetcher: async () => ({ ok: false }) });
    expect(r).toBe(false);
  });

  test('fetcher throwing → false (fail-soft)', async () => {
    const r = await sendPush('x', {}, { loadConfig: () => enabled, fetcher: async () => { throw new Error('net'); } });
    expect(r).toBe(false);
  });
});
