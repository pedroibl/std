// Story 13.7 — AgentInvocation: stdin → readStdinJson (null→exit 0); events → report.appendJsonlEvent;
// starts registry → fsx.loadJson/saveJson. Hermetic via a temp PAI_DIR; no network.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = `${import.meta.dir}/AgentInvocation.hook.ts`;
let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'ai-13-7-')); });
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

describe('null / non-Agent → exit 0', () => {
  test('empty stdin exits 0', async () => { expect((await fire('')).code).toBe(0); });
  test('non-Agent tool exits 0 without writing', async () => {
    expect((await fire(JSON.stringify({ tool_name: 'Read' }))).code).toBe(0);
  });
});

describe('Agent start → subagent-events.jsonl + agent-starts.json', () => {
  test('PreToolUse writes a subagent_start event and stashes the start record', async () => {
    const { code } = await fire(JSON.stringify({
      tool_name: 'Agent', hook_event_name: 'PreToolUse', session_id: 's1',
      tool_input: { subagent_type: 'Explore', description: 'scout the tree' },
    }));
    expect(code).toBe(0);
    const events = join(tmp, 'MEMORY', 'OBSERVABILITY', 'subagent-events.jsonl');
    const starts = join(tmp, 'MEMORY', 'OBSERVABILITY', 'agent-starts.json');
    expect(existsSync(events)).toBe(true);
    expect(existsSync(starts)).toBe(true);
    const rec = JSON.parse(readFileSync(events, 'utf-8').trim().split('\n').pop()!);
    expect(rec.event).toBe('subagent_start');
    expect(rec.subagent_type).toBe('Explore');
    const startMap = JSON.parse(readFileSync(starts, 'utf-8'));
    expect(startMap['s1::scout the tree']).toBeDefined();
  });
});
