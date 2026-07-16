// Story 13.7 — tab-setter.ts fs → fsx delamination. Hermetic: PAI_DIR is redirected to a temp dir before a
// dynamic import (so the module-level TAB_TITLES_DIR / KITTY_SESSIONS_DIR resolve under it), and the kitty/
// cmux env vars are cleared so the tested paths never shell out. execSync is retained (async swap DEFERRED —
// see the file header + deferred-work §13-7), so these tests exercise the fsx + pure portions only.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mod: typeof import('./tab-setter');
let tmp: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['PAI_DIR', 'KITTY_WINDOW_ID', 'KITTY_LISTEN_ON', 'CMUX_WORKSPACE_ID', 'CMUX_SOCKET_PATH'];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'tab-13-7-'));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.PAI_DIR = tmp;
  delete process.env.KITTY_WINDOW_ID;
  delete process.env.KITTY_LISTEN_ON;
  delete process.env.CMUX_WORKSPACE_ID;
  delete process.env.CMUX_SOCKET_PATH;
  mod = await import('./tab-setter');
});
afterAll(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe('stripPrefix (pure)', () => {
  test('strips working + phase emoji prefixes, leaves plain text', () => {
    expect(mod.stripPrefix('🧠 Fixing auth bug.')).toBe('Fixing auth bug.');
    expect(mod.stripPrefix('✅ Done.')).toBe('Done.');
    expect(mod.stripPrefix('No prefix here')).toBe('No prefix here');
  });
});

describe('getSessionOneWord (fsx.readIfExists + tokenize)', () => {
  test('extracts up to 4 meaningful uppercase words', () => {
    const dir = join(tmp, 'MEMORY', 'STATE');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session-names.json'), JSON.stringify({ s1: 'Surface Filter Bar Redesign' }));
    expect(mod.getSessionOneWord('s1')).toBe('SURFACE FILTER BAR REDESIGN');
  });
  test('unknown session id → null', () => {
    expect(mod.getSessionOneWord('unknown-session')).toBeNull();
  });
});

describe('readTabState (no resolvable window id → null)', () => {
  test('returns null with no kitty window env + no session file', () => {
    expect(mod.readTabState()).toBeNull();
  });
});

describe('persistKittySession / cleanupKittySession (fsx.atomicWrite + unlink)', () => {
  test('persist writes the session file; cleanup removes it', () => {
    mod.persistKittySession('sessX', 'unix:/tmp/kitty-test', '42');
    const f = join(tmp, 'MEMORY', 'STATE', 'kitty-sessions', 'sessX.json');
    expect(existsSync(f)).toBe(true);
    mod.cleanupKittySession('sessX');
    expect(existsSync(f)).toBe(false);
  });
});
