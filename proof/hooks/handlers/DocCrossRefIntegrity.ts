/**
 * DocCrossRefIntegrity.ts - Hybrid doc integrity checker (deterministic + inference)
 *
 * Two-layer approach:
 * Layer 1 (Deterministic): Grep-based pattern checks for broken refs, counts, timestamps
 * Layer 2 (Inference): AI analysis of semantic drift using TOOLS/Inference.ts fast tier
 *
 * The deterministic layer detects WHAT changed. The inference layer understands
 * HOW docs need updating — generating surgical edit pairs, never full rewrites.
 *
 * TRIGGER: Stop hook (via DocIntegrity.hook.ts). This is a HANDLER (invoked by the parent hook, no own
 * stdin / no main()) — so no shebang, no `import.meta.main`, no fail-open branch (that lives in the parent).
 *
 * Story 13.3 rewrite (consumer sweep) — the re-hand-rolled edge primitives now import tested std slices;
 * behavior preserved byte-for-byte, ONLY the named plumbing swapped (AC5):
 *   - P1 getModifiedFiles per-line JSON.parse loop (orig :110-130) → std/core  parseNdjson
 *          (per-line field extraction — the Write/Edit tool_use walk — stays caller-local, D4)
 *   - P2 dir-inventory listFiles readdirSync (orig :73-82)          → std/fsx   walkFiles + basename + sort
 *          (walkFiles is pruned to ONE level via {prune: () => true} to MATCH the original's NON-recursive
 *           readdirSync — a recursive walk of DOCUMENTATION/ would pull nested .md files and inflate the
 *           inventory + counts; the prune keeps it byte-identical.)
 *   - P2 all existsSync/readFileSync DOC reads                      → std/fsx   readIfExists (+ exists for the
 *          system_doc_ref target-existence probe)
 *   - P3 the 3 non-atomic doc writes (orig :601 / :632 / :654)      → std/fsx   atomicWrite (durability
 *          upgrade on live DOCUMENTATION/ docs — tmp+rename, torn-write-proof; byte content unchanged)
 *   - P4 notifyVoice Pulse fetch (orig :361)                        → std/http  fetchWithTimeout
 *          (URL localhost:31337/notify + mainDAVoiceID stay caller-local, D4; the fail-soft swallow stays
 *           in the caller)
 *
 * KEPT AS-IS (AC5 explicit): inference() (the PAI Inference tool `../../PAI/TOOLS/Inference` — NOT routed
 * through std/http); the 5 drift regexes; the surgical old-text-exact-substring `content.replace` edit; the
 * `**Last Updated:**` (UTC `new Date().toISOString().split('T')[0]`) + `**Status:** N hooks active` byte
 * mutations; every `[DocAutoUpdate]` audit-trail log line; the 3s voice delay.
 *
 * DEFER (recorded — the section splitter is NOT swapped, on purpose):
 *   The `## heading`→next-heading splitter in buildInferenceContext (orig :462-489) is KEPT hand-rolled
 *   (extracted verbatim as `extractRelevantSections`, not routed through core.findSection/extractSection).
 *   findSection/extractSection produce DIFFERENT boundaries and CANNOT reproduce it:
 *     1. It is a WHOLE-DOCUMENT multi-section splitter driven by a RELEVANCE predicate (collects every
 *        section that mentions a changed file), not a single-named-heading lookup. findSection needs the
 *        exact heading string in advance and returns ONE section.
 *     2. It breaks on EVERY `#{1,3} ` heading uniformly (h1/h2/h3 all act as boundaries). findSection's
 *        boundary is LEVEL-AWARE — a `## ` section is NOT ended by a nested `### `. Boundaries differ.
 *     3. It is heading-INCLUSIVE (the heading line is the first line of the section) and does NOT trim;
 *        extractSection is heading-EXCLUSIVE and trims. It also has preamble handling (lines before the
 *        first heading) that findSection has no concept of.
 *   Per the AC's parity caution: ANY edge differs → KEEP the hand-roll, record a DEFER, do NOT change
 *   behavior. Filed in deferred-work.md §13-3.
 *
 * No P (tz-offset) swap here: the timestamp is a FROZEN UTC `new Date().toISOString().split('T')[0]`
 * (the `**Last Updated:**` byte mutation) — preserved, NOT swapped to isoOffset.
 *
 * Caller-local identity (D4), kept IN-FILE, never pushed to std: the SYSTEM/DOCS/HOOKS/HANDLERS/LIB dir
 * layout, the 5 drift regexes, the modified-file scope filters + exclusion lists, the Pulse notify URL +
 * voice-ID, the inference system prompt, the `[DocAutoUpdate]` tag + every log-line format.
 *
 * AUDIT TRAIL: All operations logged to stderr via [DocAutoUpdate] prefix
 *
 * SIDE EFFECTS:
 * - Updates timestamps, counts (deterministic)
 * - Applies surgical text edits (inference-generated)
 */

import { readFileSync } from 'fs';
import { join, basename } from 'path';
import { paiPath, getPaiDir, getClaudeDir } from '../lib/paths';
import { getIdentity } from '../lib/identity';
import { inference } from '../../PAI/TOOLS/Inference';
import type { ParsedTranscript } from '../../PAI/TOOLS/TranscriptParser';
import { parseNdjson } from 'std/core';
import { walkFiles, readIfExists, exists, atomicWrite } from 'std/fsx';
import { fetchWithTimeout } from 'std/http';


// ============================================================================
// Types
// ============================================================================

interface HookInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
}

interface DriftItem {
  doc: string;
  pattern: string;
  reference: string;
  issue: string;
}

/** Permissive transcript-entry shape — parseNdjson is shape-agnostic; the caller-local field walk below
 *  asserts the Write/Edit tool_use structure. */
interface TranscriptEntry {
  type?: string;
  name?: string;
  input?: { file_path?: string };
  message?: { content?: unknown };
}

// ============================================================================
// Constants
// ============================================================================

const SYSTEM_DIR = getPaiDir();
const DOCS_DIR = join(SYSTEM_DIR, 'DOCUMENTATION');
const HOOKS_DIR = join(getClaudeDir(), 'hooks');
const HANDLERS_DIR = join(HOOKS_DIR, 'handlers');
const LIB_DIR = join(HOOKS_DIR, 'lib');
const TAG = '[DocAutoUpdate]';

// ============================================================================
// Filesystem Inventory
// ============================================================================

/**
 * P2: the dir-inventory swap. std/fsx walkFiles pruned to ONE level ({prune: () => true}) reproduces the
 * original's NON-recursive `readdirSync(dir).filter(endsWith).sort()` exactly — full paths mapped back to
 * basenames, suffix-filtered (a filename suffix has no slash, so a full-path endsWith equals a basename
 * endsWith), sorted. A missing/unreadable dir yields [] (walkFiles is fail-soft; matches the original's
 * existsSync-guard + try/catch → []).
 */
function listFiles(dir: string, suffix: string): string[] {
  return walkFiles(dir, (p) => p.endsWith(suffix), { prune: () => true })
    .map((p) => basename(p))
    .sort();
}

function getHookFilesOnDisk(): string[] {
  return listFiles(HOOKS_DIR, '.hook.ts');
}

function getHandlerFilesOnDisk(): string[] {
  return listFiles(HANDLERS_DIR, '.ts');
}

function getLibFilesOnDisk(): string[] {
  return listFiles(LIB_DIR, '.ts');
}

function getSystemDocsOnDisk(): string[] {
  return listFiles(DOCS_DIR, '.md');
}

// ============================================================================
// Transcript Parsing
// ============================================================================

/**
 * P1 pure core: extract the Write/Edit-modified file paths from raw transcript NDJSON. std/core parseNdjson
 * does the split→per-line JSON.parse→skip-malformed (byte-identical set to the original
 * `split('\n').filter(Boolean)` + per-line try/catch — a whitespace-only line is dropped either way: the
 * original's JSON.parse throws on it, parseNdjson's `!line.trim()` pre-skips it). The tool_use field walk
 * stays caller-local (D4). Pure — hermetically testable off the fs.
 */
export function extractModifiedFiles(content: string): Set<string> {
  const modified = new Set<string>();
  for (const entry of parseNdjson<TranscriptEntry>(content)) {
    // Handle both transcript formats
    if (entry.type === 'tool_use' && (entry.name === 'Write' || entry.name === 'Edit')) {
      const path = entry.input?.file_path || '';
      if (path) modified.add(path);
    }
    if (entry.type === 'assistant' && entry.message?.content) {
      const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
      for (const block of blocks) {
        if (block.type === 'tool_use' && (block.name === 'Write' || block.name === 'Edit')) {
          const path = block.input?.file_path || '';
          if (path) modified.add(path);
        }
      }
    }
  }
  return modified;
}

function getModifiedFiles(transcriptPath: string): Set<string> {
  try {
    // The transcript read stays readFileSync (it is NOT a "doc read", and preserving the try/catch keeps the
    // exact `Failed to parse transcript: <error>` audit line). Only the parse LOOP is swapped (→ parseNdjson,
    // via extractModifiedFiles).
    const content = readFileSync(transcriptPath, 'utf-8');
    return extractModifiedFiles(content);
  } catch (error) {
    console.error(`${TAG} Failed to parse transcript:`, error);
    return new Set<string>();
  }
}

function isSystemDocModified(modifiedFiles: Set<string>): boolean {
  for (const path of modifiedFiles) {
    if (path.includes('PAI/') && path.endsWith('.md')) return true;
  }
  return false;
}

function isHookModified(modifiedFiles: Set<string>): boolean {
  for (const path of modifiedFiles) {
    if (path.includes('/hooks/') && path.endsWith('.ts')) return true;
  }
  return false;
}

/**
 * Check if ANY meaningful PAI system file was modified.
 * PAI spans TWO root directories:
 *   - CLAUDE_DIR (~/.claude) — hooks, skills, settings, agents, CLAUDE.md
 *   - PAI_DIR (~/.claude/PAI) — PAI data, Tools, Components, Workflows, SYSTEM docs
 * Excludes MEMORY/WORK, MEMORY/LEARNING, MEMORY/STATE, and other non-system paths.
 */
function isSystemFileModified(modifiedFiles: Set<string>): boolean {
  const PAI_DIR = getPaiDir();
  const CLAUDE_DIR = getClaudeDir();
  const PAI_EXCLUDED = ['MEMORY/WORK/', 'MEMORY/LEARNING/', 'MEMORY/STATE/', 'Plans/', '.git/', 'node_modules/', 'ShellSnapshots/', 'MEMORY/VOICE/', 'MEMORY/RELATIONSHIP/', 'history.jsonl', '.quote-cache'];
  const CLAUDE_EXCLUDED = ['projects/', '.git/', 'node_modules/', 'history.jsonl'];

  for (const filePath of modifiedFiles) {
    // --- Check ~/.claude/ paths ---
    if (filePath.startsWith(CLAUDE_DIR + '/')) {
      const relPath = filePath.slice(CLAUDE_DIR.length + 1);
      if (CLAUDE_EXCLUDED.some(ex => relPath.includes(ex))) continue;

      if (relPath.startsWith('hooks/') && (relPath.endsWith('.ts') || relPath.endsWith('.sh'))) return true;
      if (relPath.startsWith('skills/') && (relPath.endsWith('.md') || relPath.endsWith('.ts') || relPath.endsWith('.yaml') || relPath.endsWith('.yml'))) return true;
      if (relPath === 'settings.json') return true;
      if (relPath === 'CLAUDE.md') return true;
      if (relPath.startsWith('agents/') && relPath.endsWith('.md')) return true;
      if (relPath.startsWith('custom-agents/') && relPath.endsWith('.md')) return true;
      if (relPath.startsWith('commands/') && relPath.endsWith('.md')) return true;
      continue;
    }

    // --- Check ~/.claude/PAI/ paths ---
    if (filePath.startsWith(PAI_DIR + '/')) {
      const relPath = filePath.slice(PAI_DIR.length + 1);
      if (PAI_EXCLUDED.some(ex => relPath.includes(ex))) continue;

      if ((relPath.startsWith('PAI/') || relPath.includes('skills/')) && (relPath.endsWith('.md') || relPath.endsWith('.ts') || relPath.endsWith('.yaml') || relPath.endsWith('.yml'))) return true;
      if (relPath.includes('/Tools/') && relPath.endsWith('.ts')) return true;
      if (relPath.includes('/Workflows/') && relPath.endsWith('.md')) return true;
      continue;
    }
  }
  return false;
}

// ============================================================================
// Pattern Checkers
// ============================================================================
// Each checker is split into a PURE per-content drift helper (exported, hermetically testable — the 5 drift
// regexes live here) and a thin fs wrapper that reads each doc via readIfExists (P2) and delegates.

/** Pure — Check Pattern 2: Hook file references in a doc vs actual files on disk. */
export function driftForHookRefs(content: string, docFile: string, hooksOnDisk: Set<string>): DriftItem[] {
  const drift: DriftItem[] = [];
  const hookRefRegex = /(\w+)\.hook\.ts/g;
  let match: RegExpExecArray | null;

  while ((match = hookRefRegex.exec(content)) !== null) {
    const hookName = match[0]; // e.g., "LoadContext.hook.ts"
    if (!hooksOnDisk.has(hookName)) {
      drift.push({
        doc: docFile,
        pattern: 'hook_file_ref',
        reference: hookName,
        issue: `References "${hookName}" but file does not exist on disk`,
      });
    }
  }

  return drift;
}

function checkHookFileRefs(docsToCheck: string[], hooksOnDisk: Set<string>): DriftItem[] {
  const drift: DriftItem[] = [];
  for (const docFile of docsToCheck) {
    const content = readIfExists(join(DOCS_DIR, docFile));
    if (content === null) continue;
    drift.push(...driftForHookRefs(content, docFile, hooksOnDisk));
  }
  return drift;
}

/** Pure — Check Pattern 3: Handler file references in a doc vs actual files on disk. */
export function driftForHandlerRefs(content: string, docFile: string, handlersOnDisk: Set<string>): DriftItem[] {
  const drift: DriftItem[] = [];
  const handlerRefRegex = /handlers\/(\w+)\.ts/g;
  let match: RegExpExecArray | null;

  while ((match = handlerRefRegex.exec(content)) !== null) {
    const handlerFilename = `${match[1]}.ts`;
    if (!handlersOnDisk.has(handlerFilename)) {
      drift.push({
        doc: docFile,
        pattern: 'handler_file_ref',
        reference: match[0],
        issue: `References "${match[0]}" but "${handlerFilename}" does not exist in handlers/`,
      });
    }
  }

  return drift;
}

function checkHandlerFileRefs(docsToCheck: string[], handlersOnDisk: Set<string>): DriftItem[] {
  const drift: DriftItem[] = [];
  for (const docFile of docsToCheck) {
    const content = readIfExists(join(DOCS_DIR, docFile));
    if (content === null) continue;
    drift.push(...driftForHandlerRefs(content, docFile, handlersOnDisk));
  }
  return drift;
}

/** Pure — Check Pattern 4: Shared lib file references in a doc vs actual files on disk. */
export function driftForLibRefs(content: string, docFile: string, libsOnDisk: Set<string>): DriftItem[] {
  const drift: DriftItem[] = [];
  const libRefRegex = /hooks\/lib\/([\w-]+)\.ts/g;
  let match: RegExpExecArray | null;

  while ((match = libRefRegex.exec(content)) !== null) {
    const libFilename = `${match[1]}.ts`;
    if (!libsOnDisk.has(libFilename)) {
      drift.push({
        doc: docFile,
        pattern: 'lib_file_ref',
        reference: match[0],
        issue: `References "${match[0]}" but "${libFilename}" does not exist in hooks/lib/`,
      });
    }
  }

  return drift;
}

function checkLibFileRefs(docsToCheck: string[], libsOnDisk: Set<string>): DriftItem[] {
  const drift: DriftItem[] = [];
  for (const docFile of docsToCheck) {
    const content = readIfExists(join(DOCS_DIR, docFile));
    if (content === null) continue;
    drift.push(...driftForLibRefs(content, docFile, libsOnDisk));
  }
  return drift;
}

/**
 * Pure — Check Pattern 1: SYSTEM doc cross-references validate target files exist. The target-existence
 * probe is INJECTED (`targetExists`) so this is hermetically testable; the fs wrapper supplies the real
 * `exists(SYSTEM_DIR/t) || exists(DOCS_DIR/t)` probe.
 */
export function driftForSystemDocRefs(
  content: string,
  docFile: string,
  targetExists: (refTarget: string) => boolean,
): DriftItem[] {
  const drift: DriftItem[] = [];
  // Match backtick-wrapped or plain doc references in PAI/ (both old skills/PAI/ and new PAI/ paths)
  const sysDocRefRegex = /(?:`|'|")(?:~\/\.(?:claude|config\/PAI)\/)?(?:skills\/)?PAI\/([\w/]+\.md)(?:`|'|")/g;
  let match: RegExpExecArray | null;

  while ((match = sysDocRefRegex.exec(content)) !== null) {
    const refTarget = match[1]; // e.g., "DOCUMENTATION/PAISystemArchitecture.md" or "PAISECURITYSYSTEM/ARCHITECTURE.md"
    const targetBasename = basename(refTarget);
    // Check SYSTEM_DIR first (for nested paths like PAISECURITYSYSTEM/ARCHITECTURE.md),
    // then DOCS_DIR (for bare basenames that refer to files relocated under DOCUMENTATION/).
    if (!targetExists(refTarget)) {
      drift.push({
        doc: docFile,
        pattern: 'system_doc_ref',
        reference: `PAI/${refTarget}`,
        issue: `References "PAI/${refTarget}" but file does not exist`,
      });
    }
  }

  return drift;
}

function checkSystemDocRefs(docsToCheck: string[], systemDocsOnDisk: Set<string>): DriftItem[] {
  const drift: DriftItem[] = [];
  const targetExists = (refTarget: string): boolean =>
    exists(join(SYSTEM_DIR, refTarget)) || exists(join(DOCS_DIR, refTarget));
  for (const docFile of docsToCheck) {
    const content = readIfExists(join(SYSTEM_DIR, docFile));
    if (content === null) continue;
    drift.push(...driftForSystemDocRefs(content, docFile, targetExists));
  }
  return drift;
}

/** Pure — Check Pattern 5: Numeric hook counts in a doc vs actual count on disk. */
export function driftForHookCounts(content: string, docFile: string, actualCount: number): DriftItem[] {
  const drift: DriftItem[] = [];
  // Match "N hooks active" or "N hooks running" patterns, NOT in example/anti-pattern contexts
  const countRegex = /\*\*Status:\*\*.*?(\d+) hooks? active/g;
  let match: RegExpExecArray | null;

  while ((match = countRegex.exec(content)) !== null) {
    const docCount = parseInt(match[1], 10);
    if (docCount !== actualCount) {
      drift.push({
        doc: docFile,
        pattern: 'hook_count',
        reference: match[0],
        issue: `States "${docCount} hooks active" but actual count on disk is ${actualCount}`,
      });
    }
  }

  return drift;
}

function checkHookCounts(docsToCheck: string[], actualCount: number): DriftItem[] {
  const drift: DriftItem[] = [];
  for (const docFile of docsToCheck) {
    const content = readIfExists(join(DOCS_DIR, docFile));
    if (content === null) continue;
    drift.push(...driftForHookCounts(content, docFile, actualCount));
  }
  return drift;
}

// ============================================================================
// Voice Notification (fire-and-forget)
// ============================================================================

async function notifyVoice(message: string): Promise<void> {
  try {
    // P4: std/http fetchWithTimeout (raw Response, reads no body — same as the original). URL + voice_id
    // stay caller-local (D4). The fail-soft swallow stays here (no fail-soft http variant).
    await fetchWithTimeout('http://localhost:31337/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 3000,
      body: JSON.stringify({ message, voice_id: getIdentity().mainDAVoiceID }),
    });
  } catch {
    // Voice server may not be running — silent fail
  }
}

// ============================================================================
// Inference-Powered Semantic Analysis
// ============================================================================

interface InferenceEdit {
  doc: string;
  old_text: string;
  new_text: string;
  reason: string;
}

const INFERENCE_SYSTEM_PROMPT = `You are a documentation accuracy checker. You receive:
1. A list of source files that were modified (with their current content)
2. Documentation sections that reference those files

Your job: identify where documentation is now FACTUALLY INCORRECT given the source changes.

OUTPUT FORMAT: Return a JSON array of surgical edits:
[{"doc": "filename.md", "old_text": "exact text to replace", "new_text": "corrected text", "reason": "brief explanation"}]

RULES (CRITICAL):
- Update anything that is NOW FACTUALLY WRONG because of the source changes
- This includes: file names, descriptions of behavior, counts, paths, handler lists, process descriptions
- If a system was fundamentally redesigned, update the doc sections that describe it to match the new reality
- old_text must be an EXACT substring from the doc (copy-paste precision)
- new_text should change ONLY the parts affected by the source change — preserve everything else exactly
- The user's original INTENT and PHILOSOPHY must be preserved — update facts, never change the "why" or design rationale unless it was explicitly invalidated by the change
- Writing style, tone, and voice must stay exactly as-is
- DO NOT "improve" or "clean up" text that wasn't affected by the change
- DO NOT add commentary, opinions, or explanations beyond what was already there
- If nothing is factually wrong given the changes, return an empty array: []
- Maximum 10 edits per response

Return ONLY the JSON array, no other text.`;

/**
 * Pure — the KEPT hand-rolled section splitter (DEFER; see the header). Walks the WHOLE document splitting on
 * every `#{1,3} ` heading, collecting each section that mentions one of `relevantNames`. Heading-inclusive,
 * no trim, with preamble handling — semantics core.findSection/extractSection cannot reproduce, so it stays
 * hand-rolled. Extracted (not behavior-changed) so it is hermetically testable; `relevantNames` is the
 * caller's precomputed `basename(f,'.ts').replace('.hook','')` list.
 */
export function extractRelevantSections(content: string, relevantNames: string[]): string[] {
  const lines = content.split('\n');
  const sections: string[] = [];
  let currentSection: string[] = [];
  let currentSectionRelevant = false;

  for (let i = 0; i < lines.length; i++) {
    const isHeading = lines[i].match(/^#{1,3} /);

    if (isHeading && currentSection.length > 0) {
      // End of section — include if it referenced a changed file
      if (currentSectionRelevant) {
        sections.push(currentSection.join('\n'));
      }
      currentSection = [lines[i]];
      currentSectionRelevant = false;
    } else {
      currentSection.push(lines[i]);
    }

    // Check if this line references any modified file
    if (!currentSectionRelevant) {
      currentSectionRelevant = relevantNames.some((name) => lines[i].includes(name));
    }
  }
  // Don't forget the last section
  if (currentSectionRelevant && currentSection.length > 0) {
    sections.push(currentSection.join('\n'));
  }

  return sections;
}

/**
 * Build context for inference: what changed and what docs say about it.
 * Keeps context small for fast inference (~500ms target).
 */
function buildInferenceContext(
  modifiedFiles: Set<string>,
  docsToCheck: string[],
): string {
  const parts: string[] = [];

  // Collect modified system files with their content — must match isSystemFileModified scope
  const relevantFiles = Array.from(modifiedFiles).filter(f =>
    f.includes('/hooks/') ||
    f.includes('/PAI/') ||
    f.includes('skills/') ||
    f.endsWith('settings.json') ||
    f.includes('/agents/') ||
    f.includes('/custom-agents/') ||
    f.endsWith('CLAUDE.md'),
  );

  // Precompute the changed-file "names" the splitter + reference check both scan for (derivation unchanged).
  const relevantNames = relevantFiles.map((f) => basename(f, '.ts').replace('.hook', ''));

  for (const filePath of relevantFiles.slice(0, 5)) { // Cap at 5 files
    try {
      const content = readIfExists(filePath);
      if (content === null) continue;
      const lines = content.split('\n');
      // Take the doc comment header + enough code to understand behavior
      const snippet = lines.slice(0, 60).join('\n');
      parts.push(`=== SOURCE FILE: ${basename(filePath)} ===\n${snippet}\n`);
    } catch {
      // Skip unreadable
    }
  }

  // Collect doc sections that reference modified files
  // For each affected doc, extract the FULL section (## heading to next ## heading)
  // so inference has enough context to make quality corrections
  for (const docFile of docsToCheck) {
    const docPath = join(SYSTEM_DIR, docFile);

    try {
      const content = readIfExists(docPath);
      if (content === null) continue;
      // Check if this doc references any modified file
      const referencesModified = relevantNames.some((name) => content.includes(name));

      if (referencesModified) {
        // Extract full sections that reference changed files (KEPT hand-rolled splitter — DEFER)
        const sections = extractRelevantSections(content, relevantNames);

        if (sections.length > 0) {
          // Cap total doc context to prevent token explosion
          const docContext = sections.join('\n\n---\n\n').slice(0, 4000);
          parts.push(`=== DOC: ${docFile} (affected sections) ===\n${docContext}\n`);
        }
      }
    } catch {
      // Skip unreadable
    }
  }

  return parts.join('\n');
}

/**
 * Run inference to detect semantic drift and generate surgical edits.
 * Uses Inference.ts fast tier (Haiku, ~500ms).
 */
async function runInferenceAnalysis(
  modifiedFiles: Set<string>,
  docsToCheck: string[],
): Promise<InferenceEdit[]> {
  const startTime = Date.now();

  const context = buildInferenceContext(modifiedFiles, docsToCheck);
  if (!context.trim()) {
    console.error(`${TAG} [INFERENCE] No relevant context for inference, skipping`);
    return [];
  }

  console.error(`${TAG} [INFERENCE] Running semantic analysis (fast tier)...`);
  console.error(`${TAG} [INFERENCE] Context size: ${context.length} chars`);

  try {
    // KEPT AS-IS (AC5): the PAI Inference tool — NOT routed through std/http.
    const result = await inference({
      systemPrompt: INFERENCE_SYSTEM_PROMPT,
      userPrompt: `Analyze these source file changes and documentation sections for factual inaccuracies:\n\n${context}`,
      level: 'standard',
      expectJson: true,
      timeout: 15000, // Sonnet needs more time but produces better quality
    });

    const elapsed = Date.now() - startTime;
    console.error(`${TAG} [INFERENCE] Completed in ${elapsed}ms (success: ${result.success})`);

    if (!result.success) {
      console.error(`${TAG} [INFERENCE] Failed: ${result.error}`);
      return [];
    }

    // Parse and validate edits
    const rawEdits = result.parsed as InferenceEdit[] | undefined;
    if (!Array.isArray(rawEdits)) {
      console.error(`${TAG} [INFERENCE] Response was not a JSON array, skipping`);
      return [];
    }

    // Validate each edit has required fields and old_text actually exists in doc
    const validEdits: InferenceEdit[] = [];
    for (const edit of rawEdits.slice(0, 10)) { // Max 10 edits
      if (!edit.doc || !edit.old_text || !edit.new_text || !edit.reason) {
        console.error(`${TAG} [INFERENCE] Skipping malformed edit: ${JSON.stringify(edit)}`);
        continue;
      }

      // Verify old_text exists in the doc (P2: existsSync+readFileSync → readIfExists)
      const docPath = join(SYSTEM_DIR, edit.doc);
      const docContent = readIfExists(docPath);
      if (docContent === null) {
        console.error(`${TAG} [INFERENCE] Doc not found: ${edit.doc}, skipping edit`);
        continue;
      }

      if (!docContent.includes(edit.old_text)) {
        console.error(`${TAG} [INFERENCE] old_text not found in ${edit.doc}, skipping: "${edit.old_text.slice(0, 60)}..."`);
        continue;
      }

      // Reject no-ops
      if (edit.old_text === edit.new_text) {
        continue;
      }

      validEdits.push(edit);
    }

    console.error(`${TAG} [INFERENCE] ${validEdits.length} valid edits from ${rawEdits.length} raw`);
    return validEdits;
  } catch (error) {
    console.error(`${TAG} [INFERENCE] Error: ${error}`);
    return [];
  }
}

/**
 * Pure — the surgical find-and-replace: literal FIRST-occurrence `content.replace(oldText, newText)`
 * (oldText is a string, not a regex — preserved exactly). Returns the updated content, or `null` when
 * oldText is absent. The KEPT surgical-edit semantics; hermetically testable.
 */
export function applySurgicalEdit(content: string, oldText: string, newText: string): string | null {
  if (!content.includes(oldText)) return null;
  return content.replace(oldText, newText);
}

/**
 * Apply inference-generated edits to documentation files.
 * Each edit is a surgical find-and-replace with full audit logging.
 */
function applyInferenceEdits(edits: InferenceEdit[]): string[] {
  const applied: string[] = [];

  for (const edit of edits) {
    const docPath = join(SYSTEM_DIR, edit.doc);
    try {
      const content = readIfExists(docPath); // P2
      if (content === null) {
        console.error(`${TAG} [INFERENCE-APPLY] Failed on ${edit.doc}: file not found`);
        continue;
      }
      const updated = applySurgicalEdit(content, edit.old_text, edit.new_text);
      if (updated === null) {
        console.error(`${TAG} [INFERENCE-APPLY] old_text no longer found in ${edit.doc}, skipping`);
        continue;
      }

      atomicWrite(docPath, updated); // P3: writeFileSync → atomicWrite (durability upgrade)

      const summary = `[INFERENCE] ${edit.doc}: ${edit.reason} ("${edit.old_text.slice(0, 40)}..." → "${edit.new_text.slice(0, 40)}...")`;
      console.error(`${TAG} [UPDATED] ${summary}`);
      applied.push(summary);
    } catch (error) {
      console.error(`${TAG} [INFERENCE-APPLY] Failed on ${edit.doc}: ${error}`);
    }
  }

  return applied;
}

// ============================================================================
// Deterministic Updates (safe auto-fixes)
// ============================================================================

/**
 * Pure — Update Pattern 6: the `**Last Updated:**` byte mutation. Injectable `today` (UTC date string) for
 * hermetic tests. Returns the updated content + audit summary, or `null` when there is no change. The KEPT
 * timestamp regex + `$1${today}` replacement — behavior preserved.
 */
export function applyLastUpdated(
  content: string,
  docFile: string,
  today: string,
): { updated: string; summary: string } | null {
  const timestampRegex = /(\*\*Last Updated:\*\* )\d{4}-\d{2}-\d{2}/;

  const match = content.match(timestampRegex);
  if (match && !content.includes(`**Last Updated:** ${today}`)) {
    const updated = content.replace(timestampRegex, `$1${today}`);
    return {
      updated,
      summary: `Updated "Last Updated" in ${docFile}: ${match[0]} -> **Last Updated:** ${today}`,
    };
  }

  return null;
}

/**
 * Update Pattern 6: Last Updated timestamps in modified docs.
 */
function updateLastUpdatedTimestamp(
  docFile: string,
  today: string = new Date().toISOString().split('T')[0], // KEPT: UTC, ambient-clock — the frozen byte mutation
): string | null {
  const content = readIfExists(join(DOCS_DIR, docFile)); // P2
  if (content === null) return null;

  const result = applyLastUpdated(content, docFile, today);
  if (!result) return null;

  atomicWrite(join(DOCS_DIR, docFile), result.updated); // P3
  return result.summary;
}

/**
 * Pure — Update Pattern 5: the `**Status:** ... N hooks active` byte mutation. Returns updated content +
 * audit summary, or `null` when no change. The KEPT count regex + `$1${actualCount}$2` replacement.
 */
export function applyHookCount(
  content: string,
  actualCount: number,
): { updated: string; summary: string } | null {
  const countRegex = /(\*\*Status:\*\* Production - )\d+( hooks? active)/;

  const match = content.match(countRegex);
  if (match) {
    const oldCount = parseInt(content.match(/\*\*Status:\*\* Production - (\d+)/)?.[1] || '0', 10);
    if (oldCount !== actualCount) {
      const updated = content.replace(countRegex, `$1${actualCount}$2`);
      return {
        updated,
        summary: `Updated hook count in THEHOOKSYSTEM.md: ${oldCount} -> ${actualCount}`,
      };
    }
  }

  return null;
}

/**
 * Update Pattern 5: Hook count in DOCUMENTATION/Hooks/HookSystem.md.
 */
function updateHookCount(actualCount: number): string | null {
  const docPath = join(DOCS_DIR, 'THEHOOKSYSTEM.md');
  const content = readIfExists(docPath); // P2
  if (content === null) return null;

  const result = applyHookCount(content, actualCount);
  if (!result) return null;

  atomicWrite(docPath, result.updated); // P3
  return result.summary;
}

// ============================================================================
// Main Handler
// ============================================================================

export async function handleDocCrossRefIntegrity(
  parsed: ParsedTranscript,
  hookInput: HookInput
): Promise<void> {
  const handlerStart = Date.now();
  console.error(`${TAG} === Starting hybrid doc integrity check (deterministic + inference) ===`);

  // Step 1: Parse transcript for modified files
  const modifiedFiles = getModifiedFiles(hookInput.transcript_path);
  console.error(`${TAG} Modified files in session: ${modifiedFiles.size}`);

  // Run if ANY meaningful PAI system file was modified (skills, hooks, tools, config, components, workflows, SYSTEM docs)
  const hasDocChanges = isSystemDocModified(modifiedFiles);
  const hasHookChanges = isHookModified(modifiedFiles);
  const hasAnySystemChange = isSystemFileModified(modifiedFiles);

  if (!hasAnySystemChange) {
    console.error(`${TAG} No meaningful system files modified, skipping`);
    return;
  }

  console.error(`${TAG} System docs modified: ${hasDocChanges}`);
  console.error(`${TAG} Hook files modified: ${hasHookChanges}`);
  console.error(`${TAG} System file change detected: ${hasAnySystemChange}`);

  // Step 2: Build filesystem inventory
  const hooksOnDisk = new Set(getHookFilesOnDisk());
  const handlersOnDisk = new Set(getHandlerFilesOnDisk());
  const libsOnDisk = new Set(getLibFilesOnDisk());
  const systemDocsOnDisk = new Set(getSystemDocsOnDisk());

  console.error(`${TAG} Inventory: ${hooksOnDisk.size} hooks, ${handlersOnDisk.size} handlers, ${libsOnDisk.size} libs, ${systemDocsOnDisk.size} system docs`);

  // Step 3: Determine which docs to check
  // Check all SYSTEM docs that reference hooks/handlers/libs
  const docsToCheck = Array.from(systemDocsOnDisk);
  console.error(`${TAG} Checking ${docsToCheck.length} SYSTEM docs for cross-reference drift`);

  // Step 4: Run all pattern checks
  const allDrift: DriftItem[] = [];

  // Pattern 2: Hook file references
  const hookDrift = checkHookFileRefs(docsToCheck, hooksOnDisk);
  if (hookDrift.length > 0) {
    console.error(`${TAG} [DRIFT] Hook file references: ${hookDrift.length} broken refs found`);
    for (const item of hookDrift) {
      console.error(`${TAG}   - ${item.doc}: ${item.issue}`);
    }
    allDrift.push(...hookDrift);
  } else {
    console.error(`${TAG} [OK] Hook file references: all valid`);
  }

  // Pattern 3: Handler file references
  const handlerDrift = checkHandlerFileRefs(docsToCheck, handlersOnDisk);
  if (handlerDrift.length > 0) {
    console.error(`${TAG} [DRIFT] Handler file references: ${handlerDrift.length} broken refs found`);
    for (const item of handlerDrift) {
      console.error(`${TAG}   - ${item.doc}: ${item.issue}`);
    }
    allDrift.push(...handlerDrift);
  } else {
    console.error(`${TAG} [OK] Handler file references: all valid`);
  }

  // Pattern 4: Lib file references
  const libDrift = checkLibFileRefs(docsToCheck, libsOnDisk);
  if (libDrift.length > 0) {
    console.error(`${TAG} [DRIFT] Lib file references: ${libDrift.length} broken refs found`);
    for (const item of libDrift) {
      console.error(`${TAG}   - ${item.doc}: ${item.issue}`);
    }
    allDrift.push(...libDrift);
  } else {
    console.error(`${TAG} [OK] Lib file references: all valid`);
  }

  // Pattern 1: System doc cross-references
  const sysDocDrift = checkSystemDocRefs(docsToCheck, systemDocsOnDisk);
  if (sysDocDrift.length > 0) {
    console.error(`${TAG} [DRIFT] System doc references: ${sysDocDrift.length} broken refs found`);
    for (const item of sysDocDrift) {
      console.error(`${TAG}   - ${item.doc}: ${item.issue}`);
    }
    allDrift.push(...sysDocDrift);
  } else {
    console.error(`${TAG} [OK] System doc references: all valid`);
  }

  // Pattern 5: Hook counts
  const hookCountDrift = checkHookCounts(docsToCheck, hooksOnDisk.size);
  if (hookCountDrift.length > 0) {
    console.error(`${TAG} [DRIFT] Hook counts: ${hookCountDrift.length} mismatches found`);
    for (const item of hookCountDrift) {
      console.error(`${TAG}   - ${item.doc}: ${item.issue}`);
    }
    allDrift.push(...hookCountDrift);
  } else {
    console.error(`${TAG} [OK] Hook counts: accurate`);
  }

  // Step 5: Apply safe deterministic updates
  const updatesApplied: string[] = [];

  // Update Last Updated timestamps for modified SYSTEM docs
  for (const path of modifiedFiles) {
    if (path.includes('PAI/') && path.endsWith('.md')) {
      const docFile = basename(path);
      const result = updateLastUpdatedTimestamp(docFile);
      if (result) {
        console.error(`${TAG} [UPDATED] ${result}`);
        updatesApplied.push(result);
      }
    }
  }

  // Auto-fix hook count if drifted
  if (hasHookChanges) {
    const countResult = updateHookCount(hooksOnDisk.size);
    if (countResult) {
      console.error(`${TAG} [UPDATED] ${countResult}`);
      updatesApplied.push(countResult);
    }
  }

  // Step 6: Inference-powered semantic analysis
  // Run inference to catch what grep can't: semantic drift in descriptions.
  // Always runs when system files are modified — deterministic checks only catch
  // broken refs/counts, not semantic drift (e.g., "this hook does X" when it now does Y).
  console.error(`${TAG} === Running inference analysis ===`);
  const inferenceEdits = await runInferenceAnalysis(modifiedFiles, docsToCheck);
  if (inferenceEdits.length > 0) {
    const inferenceApplied = applyInferenceEdits(inferenceEdits);
    updatesApplied.push(...inferenceApplied);
  } else {
    console.error(`${TAG} [INFERENCE] No semantic corrections needed`);
  }

  // Step 7: Summary
  const totalElapsed = Date.now() - handlerStart;
  console.error(`${TAG} === Summary (${totalElapsed}ms) ===`);
  console.error(`${TAG} Docs checked: ${docsToCheck.length}`);
  console.error(`${TAG} Drift items found: ${allDrift.length}`);
  console.error(`${TAG} Updates applied: ${updatesApplied.length}`);
  if (allDrift.length > 0) {
    console.error(`${TAG} WARNING: ${allDrift.length} cross-reference drift items need manual attention`);
  } else {
    console.error(`${TAG} All cross-references valid`);
  }
  console.error(`${TAG} Wall time: ${totalElapsed}ms`);
  console.error(`${TAG} === Check complete ===`);

  // Step 10: Voice notification — ONLY when actual documentation edits were applied
  // No voice for "queued for review" or "in sync" — that's noise
  if (updatesApplied.length > 0) {
    // Delay 3s so the main 🗣️ {{DA_NAME}} voice line plays first
    await new Promise(resolve => setTimeout(resolve, 3000));

    const affectedDocs = new Set<string>();
    for (const update of updatesApplied) {
      const docMatch = update.match(/(?:in |] )(\w+\.md)/);
      if (docMatch) affectedDocs.add(docMatch[1].replace('.md', ''));
    }

    const docNames = Array.from(affectedDocs).slice(0, 3).join(', ') || 'system';
    const reason = hasHookChanges ? 'hook system changes' : hasDocChanges ? 'system documentation changes' : 'system file changes';
    await notifyVoice(`Updated ${docNames} documentation after detecting ${reason}.`);
  }
}
