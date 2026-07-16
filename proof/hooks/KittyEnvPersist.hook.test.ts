// Story 13.7 — KittyEnvPersist: SYNC top-level kept (AC8); stdin readFileSync(0) kept sync; kitty-env write
// → fsx.atomicWrite. Hermetic: temp PAI_DIR; no KITTY_* env so the persist block is skipped and the tab
// reset resolves no window (no writes / no shell-out). Assert exit 0. Also fires with KITTY_* set to prove
// the atomicWrite path lands the kitty-env.json.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = `${import.meta.dir}/KittyEnvPersist.hook.ts`;
let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'kep-13-7-')); });
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

async function fire(input: string, extraEnv: Record<string, string> = {}): Promise<{ code: number }> {
  const proc = Bun.spawn(['bun', HOOK], {
    env: { ...process.env, PAI_DIR: tmp, KITTY_LISTEN_ON: '', KITTY_WINDOW_ID: '', CMUX_WORKSPACE_ID: '', CMUX_SOCKET_PATH: '', TERM: 'dumb', USER: 'notauser13x', ...extraEnv },
    stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const code = await proc.exited;
  return { code };
}

describe('SessionStart posture', () => {
  test('no kitty env → exit 0, no kitty-env.json written', async () => {
    expect((await fire(JSON.stringify({ session_id: 's1', source: 'startup' }))).code).toBe(0);
    expect(existsSync(join(tmp, 'MEMORY', 'STATE', 'kitty-env.json'))).toBe(false);
  });
  test('KITTY_* present → atomicWrite lands kitty-env.json', async () => {
    const { code } = await fire(JSON.stringify({ session_id: 's2', source: 'startup' }), {
      KITTY_LISTEN_ON: 'unix:/tmp/kitty-test', KITTY_WINDOW_ID: '7',
    });
    expect(code).toBe(0);
    const f = join(tmp, 'MEMORY', 'STATE', 'kitty-env.json');
    expect(existsSync(f)).toBe(true);
    const rec = JSON.parse(readFileSync(f, 'utf-8'));
    expect(rec.KITTY_LISTEN_ON).toBe('unix:/tmp/kitty-test');
    expect(rec.KITTY_WINDOW_ID).toBe('7');
  });
});
