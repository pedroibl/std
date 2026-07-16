// Story 13.7 — QuestionAnswered: hand-rolled Bun.stdin.text() race → stdio.readStdinJson (null → undefined
// session id, continue). Hermetic: terminal env neutralized (tab-setter shells nothing). Assert exit 0.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = `${import.meta.dir}/QuestionAnswered.hook.ts`;
let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'qa-13-7-')); });
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

async function fire(input: string): Promise<{ code: number }> {
  const proc = Bun.spawn(['bun', HOOK], {
    env: { ...process.env, PAI_DIR: tmp, KITTY_LISTEN_ON: '', KITTY_WINDOW_ID: '', CMUX_WORKSPACE_ID: '', CMUX_SOCKET_PATH: '', TERM: 'dumb', USER: 'notauser13x' },
    stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const code = await proc.exited;
  return { code };
}

describe('non-blocking exit 0', () => {
  test('empty stdin exits 0', async () => { expect((await fire('')).code).toBe(0); });
  test('valid payload exits 0', async () => {
    expect((await fire(JSON.stringify({ session_id: 's1' }))).code).toBe(0);
  });
});
