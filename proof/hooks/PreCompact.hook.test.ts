// Story 13.7 — PreCompact: hand-rolled Bun.stdin.text() → stdio.readStdinJson (null → {} empty input);
// JSON/text reads → fsx.loadJson/readIfExists; findArtifactPath (13.5) left byte-stable. Hermetic: temp
// PAI_DIR (no state files). Asserts exit 0 + that a populated input yields a handover on stdout.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = `${import.meta.dir}/PreCompact.hook.ts`;
let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'pc-13-7-')); });
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

async function fire(input: string): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(['bun', HOOK], {
    env: { ...process.env, PAI_DIR: tmp, TERM: 'dumb' },
    stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { code, stdout };
}

describe('PreCompact posture', () => {
  test('empty stdin → exit 0, no handover emitted', async () => {
    const { code, stdout } = await fire('');
    expect(code).toBe(0);
    expect(stdout).not.toContain('Pre-Compaction Handover');
  });
  test('cwd + session → exit 0 with a handover on stdout', async () => {
    const { code, stdout } = await fire(JSON.stringify({ session_id: 's1', cwd: '/work/x' }));
    expect(code).toBe(0);
    expect(stdout).toContain('# Pre-Compaction Handover');
    expect(stdout).toContain('/work/x');
    expect(stdout).toContain('ID: s1');
  });
});
