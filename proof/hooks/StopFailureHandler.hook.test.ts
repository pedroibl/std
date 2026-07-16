// Story 13.7 — StopFailureHandler: sync readFileSync('/dev/stdin') kept, append → report.appendJsonlEvent,
// Pulse /notify fetch DEFERRED (already 3000ms-bounded). We assert only the fail-open posture: on empty /
// malformed stdin the hook exits 0 BEFORE reaching the fetch, so the test never touches localhost:31337 (a
// valid payload would fire a real voice notification — avoided deliberately). The appendJsonlEvent path is
// byte-identical to ElicitationHandler's, which is covered end-to-end.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = `${import.meta.dir}/StopFailureHandler.hook.ts`;
let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'sf-13-7-')); });
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

async function fire(input: string): Promise<{ code: number }> {
  const proc = Bun.spawn(['bun', HOOK], {
    env: { ...process.env, PAI_DIR: tmp, TERM: 'dumb' },
    stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const code = await proc.exited;
  return { code };
}

describe('fail-open posture (exit 0 before the fetch)', () => {
  test('empty stdin exits 0', async () => { expect((await fire('')).code).toBe(0); });
  test('malformed stdin exits 0', async () => { expect((await fire('{bad')).code).toBe(0); });
});
