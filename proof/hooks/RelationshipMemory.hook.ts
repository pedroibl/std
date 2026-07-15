#!/usr/bin/env bun
/**
 * RelationshipMemory.hook.ts - Extract relationship notes from sessions
 *
 * PURPOSE:
 * Analyzes session transcripts to extract relationship-relevant learnings
 * and appends them to the daily relationship log. This builds the memory
 * that makes our relationship feel like it's growing.
 *
 * TRIGGER: Stop (session end)
 *
 * INPUT:
 * - session_id: Current session identifier
 * - transcript_path: Path to conversation transcript
 *
 * OUTPUT:
 * - Writes to: MEMORY/RELATIONSHIP/YYYY-MM/YYYY-MM-DD.md
 * - May update: PAI/USER/PRINCIPAL_IDENTITY.md (significant learnings)
 *
 * RELATIONSHIP NOTE TYPES:
 * - W (World): Objective facts about the principal's situation
 * - B (Biographical): What happened this session (first-person DA)
 * - O (Opinion): Preference/belief with confidence
 *
 * EXAMPLES:
 * - W @Principal: Currently focused on PAI infrastructure improvements
 * - B @DA: Successfully debugged voice notifications after 5 attempts
 * - O(c=0.85) @Principal: Appreciates when I admit mistakes early
 *
 * ── Story 13.4 rewrite (consumer sweep) — the SINGLE real win here is P1; everything else DEFERs:
 *    - P1  readStdinWithTimeout(5000)+JSON.parse (:59-67,238) → std/stdio readStdinJson<HookInput>(5000)
 * POSTURE (AD-9.4 Rule 2): fail-OPEN, but the null branch is NET-NEW and MANDATORY. The old reader
 *    REJECTED on timeout and `JSON.parse('')` THREW on empty → both caught → exit 0 (input was *required*).
 *    readStdinJson returns `null` on empty/timeout/malformed and never throws, so the rewrite adds an
 *    explicit `if (!data) process.exit(0)` VISIBLE branch (cite src/stdio/read.ts:7-12). No functional
 *    regression — both paths still exit 0 on bad input; the branch just makes the posture explicit.
 * DEFERRED (map over-claims — see deferred-work.md §13-4): `analyzeForRelationship` is NOT `scoreRules`
 *    (multi-label membership with snippet-payload retention, not a single max-score winner); the daily
 *    `.md` append is NOT `appendJsonlEvent` (formatted markdown, not a JSONL record). Both kept caller-local.
 * FROZEN: ./lib/paths (getPaiDir), ./lib/time (getPSTComponents), ./lib/identity (getDAName/
 *    getPrincipalName) — all owned by 13.7; ../PAI/TOOLS/TranscriptParser (parseTranscript, a PAI tool).
 */

import { writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { readStdinJson } from 'std/stdio';
import { getPaiDir } from './lib/paths';
import { getPSTComponents } from './lib/time';
import { getDAName, getPrincipalName } from './lib/identity';
import { parseTranscript } from '../PAI/TOOLS/TranscriptParser';

interface HookInput {
  session_id: string;
  transcript_path?: string;
  last_assistant_message?: string;  // v2.1.47+ — final response text
}

interface RelationshipNote {
  type: 'W' | 'B' | 'O';
  entities: string[];
  content: string;
  confidence?: number;
}

interface TranscriptEntry {
  type: 'user' | 'assistant';
  text: string;
}

/**
 * Read transcript using shared TranscriptParser
 */
function readTranscriptEntries(path: string): TranscriptEntry[] {
  if (!path || !existsSync(path)) return [];

  try {
    const parsed = parseTranscript(path);
    const entries: TranscriptEntry[] = [];
    if (parsed.lastMessage) {
      entries.push({ type: 'assistant', text: parsed.lastMessage });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Analyze transcript for relationship-relevant content.
 * Exported PURE (no fs / no clock) so the multi-label classifier — the DEFERRED-from-scoreRules logic —
 * is hermetically testable; main() and the tests both call this same function.
 */
export function analyzeForRelationship(entries: TranscriptEntry[]): RelationshipNote[] {
  const notes: RelationshipNote[] = [];

  // Patterns that indicate relationship-relevant content
  const patterns = {
    preference: /(?:prefer|like|want|appreciate|enjoy|love|hate|dislike)\s+(?:when|that|to)/i,
    frustration: /(?:frustrat|annoy|bother|irritat)/i,
    positive: /(?:great|awesome|perfect|excellent|good job|well done|nice)/i,
    learning: /(?:learn|discover|realize|understand|figure out)/i,
    milestone: /(?:first time|finally|breakthrough|success|accomplish)/i,
  };

  // Track what happened this session
  let sessionSummary: string[] = [];
  let userPreferences: string[] = [];
  let frustrations: string[] = [];
  let positives: string[] = [];

  for (const entry of entries) {
    const text = entry.text;
    if (!text || text.length < 10) continue;

    // User messages might reveal preferences
    if (entry.type === 'user') {
      if (patterns.preference.test(text)) {
        // Extract preference (simplified - would benefit from LLM analysis)
        const snippet = text.slice(0, 200);
        userPreferences.push(snippet);
      }

      if (patterns.frustration.test(text)) {
        frustrations.push(text.slice(0, 150));
      }

      if (patterns.positive.test(text)) {
        positives.push(text.slice(0, 150));
      }
    }

    // Assistant messages with SUMMARY tags indicate completed work
    if (entry.type === 'assistant') {
      const summaryMatch = text.match(/SUMMARY:\s*([^\n]+)/i);
      if (summaryMatch) {
        sessionSummary.push(summaryMatch[1].trim());
      }

      // Check for milestones
      if (patterns.milestone.test(text)) {
        const snippet = text.match(/[^.]*(?:first time|finally|breakthrough|success)[^.]*/i)?.[0];
        if (snippet) {
          sessionSummary.push(snippet.trim());
        }
      }
    }
  }

  // Generate relationship notes from analysis

  // B (Biographical) - What the DA did this session
  if (sessionSummary.length > 0) {
    const uniqueSummaries = [...new Set(sessionSummary)].slice(0, 3);
    for (const summary of uniqueSummaries) {
      notes.push({
        type: 'B',
        entities: [`@${getDAName()}`],
        content: summary
      });
    }
  }

  // O (Opinion) - Inferred preferences
  if (positives.length >= 2) {
    notes.push({
      type: 'O',
      entities: [`@${getPrincipalName()}`],
      content: 'Responded positively to this session\'s approach',
      confidence: 0.70
    });
  }

  if (frustrations.length >= 2) {
    notes.push({
      type: 'O',
      entities: [`@${getPrincipalName()}`],
      content: 'Experienced frustration during this session (likely tooling-related)',
      confidence: 0.75
    });
  }

  return notes;
}

/**
 * Format notes for markdown
 */
function formatNotes(notes: RelationshipNote[]): string {
  if (notes.length === 0) return '';

  const lines: string[] = [];
  const { hours, minutes } = getPSTComponents();

  lines.push(`\n## ${hours}:${minutes} PST\n`);

  for (const note of notes) {
    const entities = note.entities.join(' ');
    const confidence = note.confidence ? `(c=${note.confidence.toFixed(2)})` : '';
    lines.push(`- ${note.type}${confidence} ${entities}: ${note.content}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Ensure relationship memory directory exists
 */
function ensureRelationshipDir(paiDir: string): string {
  const { year, month, day } = getPSTComponents();
  const monthDir = join(paiDir, 'MEMORY', 'RELATIONSHIP', `${year}-${month}`);

  if (!existsSync(monthDir)) {
    mkdirSync(monthDir, { recursive: true });
  }

  return join(monthDir, `${year}-${month}-${day}.md`);
}

/**
 * Initialize daily relationship file if needed
 */
function initDailyFile(filepath: string): void {
  if (existsSync(filepath)) return;

  const { year, month, day } = getPSTComponents();
  const header = `# Relationship Notes: ${year}-${month}-${day}

*Auto-captured from sessions. Manual additions welcome.*

---
`;

  writeFileSync(filepath, header, 'utf-8');
}

async function main() {
  try {
    console.error('[RelationshipMemory] Hook started');

    // P1 (AD-9.4 Rule 2): posture-neutral read. RM *requires* input, so this hook is fail-OPEN via an
    // explicit null → exit 0 (the old reader rejected on timeout / threw on empty JSON.parse — same
    // outcome, now a visible branch not a caught throw). Cite src/stdio/read.ts:7-12.
    const data = await readStdinJson<HookInput>(5000);
    if (!data) { process.exit(0); }

    if (!data.transcript_path) {
      console.error('[RelationshipMemory] No transcript path, exiting');
      process.exit(0);
    }

    // Read and analyze transcript — prefer last_assistant_message over full parse
    const entries = readTranscriptEntries(data.transcript_path);
    if (data.last_assistant_message) {
      entries.push({ type: 'assistant', text: data.last_assistant_message });
    }
    if (entries.length === 0) {
      console.error('[RelationshipMemory] No transcript entries, exiting');
      process.exit(0);
    }

    console.error(`[RelationshipMemory] Analyzing ${entries.length} transcript entries`);

    const notes = analyzeForRelationship(entries);
    if (notes.length === 0) {
      console.error('[RelationshipMemory] No relationship notes to capture');
      process.exit(0);
    }

    // Write to daily relationship file
    const paiDir = getPaiDir();
    const filepath = ensureRelationshipDir(paiDir);
    initDailyFile(filepath);

    const formatted = formatNotes(notes);
    appendFileSync(filepath, formatted, 'utf-8');

    console.error(`[RelationshipMemory] Captured ${notes.length} notes to ${filepath}`);
    process.exit(0);

  } catch (err) {
    console.error(`[RelationshipMemory] Error: ${err}`);
    process.exit(0); // Don't fail the session end
  }
}

// Entrypoint guard (matches the 13.3 hook idiom): run main() only when invoked as the harness entry —
// `bun RelationshipMemory.hook.ts` → import.meta.main true → runs identically. Importing the module (the
// hermetic tests do, for analyzeForRelationship) does NOT execute main. Zero production behavior change.
if (import.meta.main) { main(); }
