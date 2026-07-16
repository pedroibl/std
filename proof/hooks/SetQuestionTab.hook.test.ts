// Story 13.7 — SetQuestionTab: hand-rolled reader → stdio.readStdinJson (visible null branch → fallback
// title, non-blocking). Hermetic: terminal env neutralized so tab-setter shells nothing + writes no state
// (no window id resolvable). We assert the non-blocking exit-0 posture on empty AND valid stdin.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = `${import.meta.dir}/SetQuestionTab.hook.ts`;
let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'sqt-13-7-')); });
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
  test('empty stdin (null → fallback title) exits 0', async () => { expect((await fire('')).code).toBe(0); });
  test('valid AskUserQuestion payload exits 0', async () => {
    expect((await fire(JSON.stringify({ session_id: 's1', tool_input: { questions: [{ header: 'Auth' }] } }))).code).toBe(0);
  });
});
