// Hermetic tests for the SystemIntegrity handler (Story 13.3).
//
// SystemIntegrity is a HANDLER (invoked by IntegrityCheck.hook.ts, no own stdin / no main()), so there
// is no fire-test — we unit-test the exported PURE, INJECTABLE helper `buildIntegrityState` off the fs
// path. That covers the two things this story must not break: the byte-critical integrity-state.json
// record SHAPE (read back by change-detection) and the write BYTES (atomicWrite must be byte-identical
// to the original writeFileSync — no trailing newline). The detached spawn is DEFERRED/untouched and is
// not exercised (it would fork a real bun process), matching the AC.

import { describe, expect, test } from 'bun:test';
import { buildIntegrityState } from './SystemIntegrity';
import { hashChanges, type FileChange } from '../lib/change-detection';

const CHANGES: FileChange[] = [
  { tool: 'Edit', path: 'PAI/skills/Foo/SKILL.md', category: 'skill', isPhilosophical: false, isStructural: false },
  { tool: 'Write', path: 'PAI/hooks/Bar.hook.ts', category: 'hook', isPhilosophical: false, isStructural: true },
];

const NOW = new Date('2026-07-13T15:00:00Z');
const COOLDOWN = '2026-07-13T15:05:00.000Z';

describe('buildIntegrityState — shape preserved byte-for-byte', () => {
  test('exact key set — no extra, no missing (change-detection reads this back)', () => {
    const state = buildIntegrityState(CHANGES, NOW, COOLDOWN);
    expect(Object.keys(state).sort()).toEqual(['cooldown_until', 'last_changes_hash', 'last_run']);
  });

  test('last_run is the INJECTED now as UTC ISO (no isoOffset swap this story)', () => {
    const state = buildIntegrityState(CHANGES, NOW, COOLDOWN);
    expect(state.last_run).toBe('2026-07-13T15:00:00.000Z');
    expect(state.last_run.endsWith('Z')).toBe(true); // UTC, not a tz-offset
  });

  test('cooldown_until is the INJECTED value verbatim (no ambient clock)', () => {
    const state = buildIntegrityState(CHANGES, NOW, COOLDOWN);
    expect(state.cooldown_until).toBe(COOLDOWN);
  });

  test('last_changes_hash comes from change-detection.hashChanges (deterministic)', () => {
    const state = buildIntegrityState(CHANGES, NOW, COOLDOWN);
    expect(state.last_changes_hash).toBe(hashChanges(CHANGES));
    // determinism: same change set → same hash on a second build
    expect(buildIntegrityState(CHANGES, NOW, COOLDOWN).last_changes_hash).toBe(state.last_changes_hash);
  });

  test('injecting now/cooldown is pure — no ambient state bleeds across calls', () => {
    const a = buildIntegrityState(CHANGES, new Date('2020-01-01T00:00:00Z'), 'c1');
    const b = buildIntegrityState(CHANGES, new Date('2030-01-01T00:00:00Z'), 'c2');
    expect(a.last_run).toBe('2020-01-01T00:00:00.000Z');
    expect(a.cooldown_until).toBe('c1');
    expect(b.last_run).toBe('2030-01-01T00:00:00.000Z');
    expect(b.cooldown_until).toBe('c2');
  });
});

describe('serialized bytes match the original writeFileSync exactly', () => {
  test('JSON.stringify(state, null, 2) has NO trailing newline (atomicWrite, not saveJson)', () => {
    const state = buildIntegrityState(CHANGES, NOW, COOLDOWN);
    const bytes = JSON.stringify(state, null, 2);
    expect(bytes.endsWith('\n')).toBe(false);
    // exact serialized form the deployed handler writes to integrity-state.json
    expect(bytes).toBe(
      [
        '{',
        `  "last_run": "2026-07-13T15:00:00.000Z",`,
        `  "last_changes_hash": "${hashChanges(CHANGES)}",`,
        `  "cooldown_until": "2026-07-13T15:05:00.000Z"`,
        '}',
      ].join('\n'),
    );
  });

  test('empty change set still yields a valid, parseable record', () => {
    const state = buildIntegrityState([], NOW, COOLDOWN);
    const round = JSON.parse(JSON.stringify(state, null, 2));
    expect(round.last_changes_hash).toBe(hashChanges([]));
    expect(round.last_run).toBe('2026-07-13T15:00:00.000Z');
  });
});
