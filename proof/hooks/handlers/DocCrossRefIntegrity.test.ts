// Hermetic tests for the DocCrossRefIntegrity 13.3 rewrite. Handler (invoked by parent, no own stdin /
// no main()) — so NO fire helper; we unit-test the exported pure/injectable fns only, off the fs/network/
// inference path (no real reads, no writes, no Pulse, no Inference call).
//
// No P3 isoOffset assertion here: this file has NO tz-offset swap — the `**Last Updated:**` timestamp stays
// a frozen UTC `new Date().toISOString().split('T')[0]`, injected as a string into applyLastUpdated.

import { test, expect, describe } from 'bun:test';
import {
  extractModifiedFiles,
  driftForHookRefs,
  driftForHandlerRefs,
  driftForLibRefs,
  driftForSystemDocRefs,
  driftForHookCounts,
  extractRelevantSections,
  applySurgicalEdit,
  applyLastUpdated,
  applyHookCount,
} from './DocCrossRefIntegrity';

// ---------------------------------------------------------------------------
// P1 — extractModifiedFiles (parseNdjson swap; per-line field walk caller-local)
// ---------------------------------------------------------------------------
describe('extractModifiedFiles (P1 — parseNdjson)', () => {
  test('flat tool_use format: Write/Edit file_path collected, others ignored', () => {
    const ndjson = [
      JSON.stringify({ type: 'tool_use', name: 'Write', input: { file_path: '/a.md' } }),
      JSON.stringify({ type: 'tool_use', name: 'Edit', input: { file_path: '/b.ts' } }),
      JSON.stringify({ type: 'tool_use', name: 'Read', input: { file_path: '/c.md' } }), // ignored
      JSON.stringify({ type: 'tool_use', name: 'Write', input: {} }), // no path → ignored
    ].join('\n');
    const out = extractModifiedFiles(ndjson);
    expect([...out].sort()).toEqual(['/a.md', '/b.ts']);
  });

  test('nested assistant.message.content blocks are walked', () => {
    const ndjson = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/nested.md' } },
          { type: 'tool_use', name: 'Bash', input: { file_path: '/skip' } },
        ],
      },
    });
    expect([...extractModifiedFiles(ndjson)]).toEqual(['/nested.md']);
  });

  test('malformed + blank + whitespace-only lines are skipped (parseNdjson parity)', () => {
    // The original did split(\n).filter(Boolean) + per-line JSON.parse try/catch. parseNdjson skips
    // !line.trim() and JSON.parse failures. The SET of collected paths must be identical.
    const ndjson = [
      '',                       // blank
      '   ',                    // whitespace-only (orig: JSON.parse throws → skip; parseNdjson: trim-skip)
      '{not json',              // malformed → skip
      JSON.stringify({ type: 'tool_use', name: 'Write', input: { file_path: '/kept.md' } }),
      '0',                      // valid JSON, number → no type match, ignored
    ].join('\n');
    expect([...extractModifiedFiles(ndjson)]).toEqual(['/kept.md']);
  });

  test('empty input → empty set', () => {
    expect(extractModifiedFiles('').size).toBe(0);
  });

  test('duplicate paths deduped via Set', () => {
    const line = JSON.stringify({ type: 'tool_use', name: 'Write', input: { file_path: '/dup.md' } });
    expect([...extractModifiedFiles(`${line}\n${line}`)]).toEqual(['/dup.md']);
  });
});

// ---------------------------------------------------------------------------
// The 5 drift regexes (KEPT) — pure per-content helpers
// ---------------------------------------------------------------------------
describe('driftForHookRefs (Pattern 2 regex)', () => {
  test('flags a .hook.ts ref that is not on disk', () => {
    const drift = driftForHookRefs('see LoadContext.hook.ts and Ghost.hook.ts', 'D.md', new Set(['LoadContext.hook.ts']));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ doc: 'D.md', pattern: 'hook_file_ref', reference: 'Ghost.hook.ts' });
    expect(drift[0].issue).toBe('References "Ghost.hook.ts" but file does not exist on disk');
  });
  test('no drift when all refs exist', () => {
    expect(driftForHookRefs('LoadContext.hook.ts', 'D.md', new Set(['LoadContext.hook.ts']))).toHaveLength(0);
  });
});

describe('driftForHandlerRefs (Pattern 3 regex)', () => {
  test('flags a handlers/X.ts ref missing on disk; message uses full match', () => {
    const drift = driftForHandlerRefs('handlers/Missing.ts', 'D.md', new Set<string>());
    expect(drift[0]).toMatchObject({ pattern: 'handler_file_ref', reference: 'handlers/Missing.ts' });
    expect(drift[0].issue).toBe('References "handlers/Missing.ts" but "Missing.ts" does not exist in handlers/');
  });
  test('present handler → no drift', () => {
    expect(driftForHandlerRefs('handlers/Here.ts', 'D.md', new Set(['Here.ts']))).toHaveLength(0);
  });
});

describe('driftForLibRefs (Pattern 4 regex — hyphenated names)', () => {
  test('flags hooks/lib/some-lib.ts when absent', () => {
    const drift = driftForLibRefs('hooks/lib/change-detection.ts', 'D.md', new Set<string>());
    expect(drift[0]).toMatchObject({ pattern: 'lib_file_ref', reference: 'hooks/lib/change-detection.ts' });
    expect(drift[0].issue).toContain('"change-detection.ts" does not exist in hooks/lib/');
  });
});

describe('driftForSystemDocRefs (Pattern 1 regex — injected existence probe)', () => {
  const content = 'refs `PAI/DOCUMENTATION/Foo.md` and `PAI/Bar/Baz.md` here';
  test('flags only the targets the probe says are absent', () => {
    const drift = driftForSystemDocRefs(content, 'D.md', (t) => t === 'DOCUMENTATION/Foo.md');
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ pattern: 'system_doc_ref', reference: 'PAI/Bar/Baz.md' });
    expect(drift[0].issue).toBe('References "PAI/Bar/Baz.md" but file does not exist');
  });
  test('all present → no drift', () => {
    expect(driftForSystemDocRefs(content, 'D.md', () => true)).toHaveLength(0);
  });
});

describe('driftForHookCounts (Pattern 5 regex)', () => {
  test('flags a mismatched "N hooks active" count', () => {
    const drift = driftForHookCounts('**Status:** Production - 21 hooks active', 'H.md', 23);
    expect(drift[0]).toMatchObject({ pattern: 'hook_count' });
    expect(drift[0].issue).toBe('States "21 hooks active" but actual count on disk is 23');
  });
  test('matching count → no drift', () => {
    expect(driftForHookCounts('**Status:** Production - 23 hooks active', 'H.md', 23)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractRelevantSections — the KEPT hand-rolled splitter (DEFER).
// These assertions PIN the behaviors that core.findSection/extractSection do NOT reproduce.
// ---------------------------------------------------------------------------
describe('extractRelevantSections (DEFER — kept hand-roll)', () => {
  const doc = [
    '## Alpha',       // 0
    'talks about Foo', // relevant (mentions Foo)
    '### Nested',     // h3 — a NEW section boundary under the hand-roll (findSection would NOT break here)
    'more Foo detail',
    '## Beta',        // 4
    'unrelated bar',  // NOT relevant
    '## Gamma',
    'again Foo',      // relevant
  ].join('\n');

  test('collects MULTIPLE sections filtered by the relevance predicate', () => {
    const sections = extractRelevantSections(doc, ['Foo']);
    // Alpha (mentions Foo), the Nested h3 (mentions Foo), and Gamma (mentions Foo) — Beta excluded.
    expect(sections.length).toBe(3);
    expect(sections[0]).toContain('## Alpha');
    expect(sections.some((s) => s.startsWith('## Gamma'))).toBe(true);
    expect(sections.some((s) => s.startsWith('## Beta'))).toBe(false);
  });

  test('breaks on EVERY #{1,3} heading uniformly (h3 ends the section) — differs from findSection', () => {
    const sections = extractRelevantSections(doc, ['Foo']);
    // The '### Nested' block is its OWN section, not folded into '## Alpha' — proving uniform-break
    // semantics that a level-aware findSection('## Alpha') would violate (it would swallow the ### block).
    expect(sections.some((s) => s.startsWith('### Nested'))).toBe(true);
    expect(sections[0]).not.toContain('### Nested');
  });

  test('sections are heading-INCLUSIVE and NOT trimmed', () => {
    const sections = extractRelevantSections('## H\nmentions Foo\n', ['Foo']);
    expect(sections[0]).toBe('## H\nmentions Foo\n'); // heading kept, trailing newline preserved
  });

  test('preamble (before the first heading) can be collected when relevant', () => {
    const sections = extractRelevantSections('preamble mentions Foo\n## Later\nnothing', ['Foo']);
    expect(sections[0]).toBe('preamble mentions Foo');
  });

  test('no relevant names → no sections', () => {
    expect(extractRelevantSections(doc, ['Nope'])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applySurgicalEdit — KEPT literal FIRST-occurrence replace
// ---------------------------------------------------------------------------
describe('applySurgicalEdit (KEPT surgical edit)', () => {
  test('replaces only the FIRST occurrence, literally', () => {
    expect(applySurgicalEdit('foo foo foo', 'foo', 'bar')).toBe('bar foo foo');
  });
  test('old_text is treated literally, not as a regex', () => {
    expect(applySurgicalEdit('a.(b) here', 'a.(b)', 'X')).toBe('X here');
  });
  test('absent old_text → null', () => {
    expect(applySurgicalEdit('hello', 'nope', 'x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyLastUpdated — KEPT **Last Updated:** byte mutation (injected UTC `today`)
// ---------------------------------------------------------------------------
describe('applyLastUpdated (KEPT byte mutation)', () => {
  test('rewrites the date and reports the summary', () => {
    const res = applyLastUpdated('**Last Updated:** 2025-01-01\nbody', 'Doc.md', '2026-07-13');
    expect(res).not.toBeNull();
    expect(res!.updated).toContain('**Last Updated:** 2026-07-13');
    expect(res!.summary).toBe('Updated "Last Updated" in Doc.md: **Last Updated:** 2025-01-01 -> **Last Updated:** 2026-07-13');
  });
  test('already current → null (no-op)', () => {
    expect(applyLastUpdated('**Last Updated:** 2026-07-13', 'Doc.md', '2026-07-13')).toBeNull();
  });
  test('no timestamp field → null', () => {
    expect(applyLastUpdated('no field here', 'Doc.md', '2026-07-13')).toBeNull();
  });
  test('the impure wrapper default today is the frozen UTC shape (no isoOffset)', () => {
    // Sanity: the injected shape matches new Date().toISOString().split("T")[0] — YYYY-MM-DD, UTC.
    const today = new Date().toISOString().split('T')[0];
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// applyHookCount — KEPT **Status:** N hooks active byte mutation
// ---------------------------------------------------------------------------
describe('applyHookCount (KEPT byte mutation)', () => {
  test('rewrites the count and reports old -> new', () => {
    const res = applyHookCount('**Status:** Production - 21 hooks active', 25);
    expect(res).not.toBeNull();
    expect(res!.updated).toBe('**Status:** Production - 25 hooks active');
    expect(res!.summary).toBe('Updated hook count in THEHOOKSYSTEM.md: 21 -> 25');
  });
  test('singular "hook active" also matches', () => {
    const res = applyHookCount('**Status:** Production - 1 hook active', 4);
    expect(res!.updated).toBe('**Status:** Production - 4 hook active');
  });
  test('count already correct → null', () => {
    expect(applyHookCount('**Status:** Production - 25 hooks active', 25)).toBeNull();
  });
  test('no status line → null', () => {
    expect(applyHookCount('nothing here', 25)).toBeNull();
  });
});
