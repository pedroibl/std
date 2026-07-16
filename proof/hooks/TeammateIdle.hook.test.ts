// Story 13.7 — TeammateIdle: stdin → readStdinJson (null→exit 0), append → report.appendJsonlEvent.
// Hermetic: PAI_DIR → temp so the JSONL sink lands under it; no network.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = `${import.meta.dir}/TeammateIdle.hook.ts`;
let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'ti-13-7-')); });
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

async function fire(input: string): Promise<{ code: number }> {
  const proc = Bun.spawn(['bun', HOOK], {
    env: { ...process.env, PAI_DIR: tmp, KITTY_LISTEN_ON: '', KITTY_WINDOW_ID: '', TERM: 'dumb' },
    stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const code = await proc.exited;
  return { code };
}

describe('null → exit 0 (fail-open)', () => {
  test('empty stdin exits 0', async () => {
    expect((await fire('')).code).toBe(0);
  });
  test('malformed stdin exits 0', async () => {
    expect((await fire('not json')).code).toBe(0);
  });
});

describe('valid payload → appendJsonlEvent sink', () => {
  test('writes a teammate_idle event to MEMORY/OBSERVABILITY/teammate-events.jsonl', async () => {
    const { code } = await fire(JSON.stringify({
      session_id: 's1', teammate_name: 'scout', team_name: 'recon',
      transcript_path: '', cwd: '', permission_mode: '', hook_event_name: 'TeammateIdle',
    }));
    expect(code).toBe(0);
    const logPath = join(tmp, 'MEMORY', 'OBSERVABILITY', 'teammate-events.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const rec = JSON.parse(readFileSync(logPath, 'utf-8').trim().split('\n').pop()!);
    expect(rec.event).toBe('teammate_idle');
    expect(rec.session_id).toBe('s1');
    expect(rec.teammate_name).toBe('scout');
    expect(rec.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });
});
