// Story 13.7 — VoiceNotification: dual-sink JSONL → report.appendJsonlEvent (TWO calls); voice-server POST
// → http.fetchWithTimeout (injected fetcher seam here). Hermetic: PAI_DIR → temp BEFORE the dynamic import
// (module-level paiPath consts resolve under it); the injected fetcher means no real network / no voice.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mod: typeof import('./VoiceNotification');
let tmp: string;
const savedPaiDir = process.env.PAI_DIR;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'vn-13-7-'));
  process.env.PAI_DIR = tmp;
  mod = await import('./VoiceNotification');
});
afterAll(() => {
  if (savedPaiDir === undefined) delete process.env.PAI_DIR; else process.env.PAI_DIR = savedPaiDir;
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const VOICE_LOG = () => join(tmp, 'MEMORY', 'VOICE', 'voice-events.jsonl');

describe('handleVoice → appendJsonlEvent (injected fetcher, no network)', () => {
  test('a sent notification logs event_type "sent" to MEMORY/VOICE/voice-events.jsonl', async () => {
    const calls: string[] = [];
    await mod.handleVoice({ voiceCompletion: 'Wired the substrate cleanly today.' } as any, 'sess1', {
      fetcher: async (url) => { calls.push(url); return { ok: true, status: 200, statusText: 'OK' }; },
    });
    expect(calls).toEqual(['http://localhost:31337/notify']);
    expect(existsSync(VOICE_LOG())).toBe(true);
    const rec = JSON.parse(readFileSync(VOICE_LOG(), 'utf-8').trim().split('\n').pop()!);
    expect(rec.event_type).toBe('sent');
    expect(rec.session_id).toBe('sess1');
    expect(rec.status_code).toBe(200);
  });

  test('a non-ok response logs event_type "failed"', async () => {
    await mod.handleVoice({ voiceCompletion: 'Another valid completion sentence.' } as any, 'sess2', {
      fetcher: async () => ({ ok: false, status: 503, statusText: 'Unavailable' }),
    });
    const rec = JSON.parse(readFileSync(VOICE_LOG(), 'utf-8').trim().split('\n').pop()!);
    expect(rec.event_type).toBe('failed');
    expect(rec.status_code).toBe(503);
  });

  test('a too-short completion is skipped (no crash, invalid → fallback → skip)', async () => {
    let called = false;
    await mod.handleVoice({ voiceCompletion: 'hi' } as any, 'sess3', {
      fetcher: async () => { called = true; return { ok: true, status: 200, statusText: 'OK' }; },
    });
    expect(called).toBe(false); // invalid completion → getVoiceFallback('') → skipped before fetch
  });
});
