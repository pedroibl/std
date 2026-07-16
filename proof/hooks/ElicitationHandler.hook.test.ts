// Story 13.7 — ElicitationHandler: SYNC main() kept (AC8), sync readFileSync('/dev/stdin') kept,
// append → report.appendJsonlEvent. Hermetic via temp PAI_DIR; no network.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = `${import.meta.dir}/ElicitationHandler.hook.ts`;
let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'eh-13-7-')); });
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

// Find any elicitation-*.jsonl under MEMORY/SECURITY/<year>/<month>/ (the date-keyed path).
function findElicitationLog(): string | null {
  const base = join(tmp, 'MEMORY', 'SECURITY');
  if (!existsSync(base)) return null;
  for (const y of readdirSync(base)) {
    const yd = join(base, y);
    for (const m of readdirSync(yd)) {
      const md = join(yd, m);
      const f = readdirSync(md).find((n) => n.startsWith('elicitation-') && n.endsWith('.jsonl'));
      if (f) return join(md, f);
    }
  }
  return null;
}

describe('malformed / empty stdin → exit 0', () => {
  test('empty stdin exits 0', async () => { expect((await fire('')).code).toBe(0); });
});

describe('valid elicitation → appendJsonlEvent under MEMORY/SECURITY', () => {
  test('logs an elicitation_request event', async () => {
    const { code } = await fire(JSON.stringify({
      mcp_server_name: 'stripe', elicitation_message: 'confirm?', elicitation_schema: { type: 'confirmation' },
    }));
    expect(code).toBe(0);
    const log = findElicitationLog();
    expect(log).not.toBeNull();
    const rec = JSON.parse(readFileSync(log!, 'utf-8').trim().split('\n').pop()!);
    expect(rec.event_type).toBe('elicitation_request');
    expect(rec.server).toBe('stripe');
  });
});
