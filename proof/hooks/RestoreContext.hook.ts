#!/usr/bin/env bun
/**
 * RestoreContext.hook.ts - Re-inject Contextual Knowledge After Compaction (PostCompact)
 *
 * TRIGGER: PostCompact (fires after conversation compaction completes)
 *
 * Counterpart to LoadContext.hook.ts (SessionStart). After compaction, contextual
 * knowledge (projects, identity details) gets compressed away. Constitutional rules
 * live in the system prompt (PAI_SYSTEM_PROMPT.md) which survives compression natively,
 * so this hook only restores contextual files that compaction discards.
 *
 * Tier 1 (MUST restore — contextual knowledge):
 *   - Files listed in settings.json postCompactRestore.fullFiles
 *   - Default: PROJECTS.md — project routing table for context switching
 *
 * Tier 2 (SHOULD restore — identity anchors):
 *   - DA_IDENTITY.md critical sections — first-person voice, pronouns, cussing protocol
 *   - Active ISA (if touched in last 60min)
 *   - TELOS/STATUS.md
 *
 * NOT restored (survives natively):
 *   - Constitutional rules (system prompt) — survives compression automatically
 *   - Steering rules — now in system prompt, not separate files
 *
 * Token budget: ~2K tokens (~0.2% of 1M context — negligible vs contextual value)
 *
 * Story 13.8 rewrite (context & prompt lifecycle cluster — dormant hook, PostCompact, no stdin):
 *   - safeRead → std/fsx.readIfExists, but PRESERVED inside its existing try/catch (validator E3): live
 *     safeRead swallows ALL errors → '', whereas readIfExists RE-THROWS non-ENOENT (src/fsx/index.ts:154).
 *     Keeping the catch means an EACCES at the fullFiles loop still fail-softs to '' as before (no posture
 *     regression on this dormant hook). The maxLines slice stays caller-local.
 *   - final output assembly → std/report.lines() (the array-join line builder; byte-identical output).
 *   - DEFER extractSections (:60-87) — a multi-section, fuzzy `includes()`-match heading collector;
 *     core.extractSection/findSection are single-section exact/level-aware and cannot reproduce the
 *     multi-name substring-contains concatenation → kept caller-local (same defer-class as 13.3's
 *     DocCrossRefIntegrity splitter). loadSettings kept caller-local (raw fs; not in the adopt set).
 *   - FROZEN import: ./lib/paths (13.7). main() stays SYNC — no stdin (PostCompact). Single exit 0.
 */

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { readIfExists } from 'std/fsx';
import { lines } from 'std/report';
import { getPaiDir, getSettingsPath, paiPath } from './lib/paths';

interface PostCompactConfig {
  _docs?: string;
  fullFiles?: string[];
}

interface Settings {
  postCompactRestore?: PostCompactConfig;
  [key: string]: unknown;
}

function safeRead(path: string, maxLines?: number): string {
  // fsx.readIfExists softens ENOENT → null but RE-THROWS a real fs fault (EACCES/…); the surrounding
  // try/catch is PRESERVED (validator E3) so this dormant hook keeps its all-swallowing fail-soft → ''.
  try {
    const content = readIfExists(path);
    if (content === null) return '';
    if (maxLines) {
      return content.split('\n').slice(0, maxLines).join('\n');
    }
    return content;
  } catch {
    return '';
  }
}

/**
 * Extract specific sections from a markdown file by heading.
 * Returns content from each matched ## heading through the next ## heading.
 *
 * DEFERRED (13.8): multi-section, fuzzy `includes()`-match collector — core.extractSection/findSection
 * are single-section, exact/level-aware and cannot reproduce this multi-name substring-contains
 * concatenation. Kept caller-local; un-defer via a `core.splitSectionsBy(content, pred, {...})` variant
 * at a 2nd whole-doc collector (same trigger as 13.3's DocCrossRefIntegrity section-splitter defer).
 */
function extractSections(filePath: string, sectionNames: string[]): string {
  const content = safeRead(filePath);
  if (!content) return '';

  const lines = content.split('\n');
  const extracted: string[] = [];
  let capturing = false;
  let currentSection = '';

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      const heading = headingMatch[1].trim();
      capturing = sectionNames.some(name =>
        heading.toLowerCase().includes(name.toLowerCase())
      );
      if (capturing) {
        currentSection = line;
        extracted.push('');
        extracted.push(line);
      }
    } else if (capturing) {
      extracted.push(line);
    }
  }

  return extracted.join('\n').trim();
}

function loadSettings(): Settings {
  const settingsPath = getSettingsPath();
  if (existsSync(settingsPath)) {
    try {
      return JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

function main() {
  const paiDir = getPaiDir();
  const settings = loadSettings();
  const parts: string[] = [];

  // --- Tier 1: Contextual knowledge (full file restore) ---
  // Constitutional rules are in the system prompt and survive compression natively.
  // Only contextual files (projects, etc.) need post-compact restoration.

  const defaultFullFiles = [
    'USER/PROJECTS/PROJECTS.md',
  ];

  const fullFiles = settings.postCompactRestore?.fullFiles ?? defaultFullFiles;
  let restoredCount = 0;

  for (const relPath of fullFiles) {
    const fullPath = join(paiDir, relPath);
    const content = safeRead(fullPath);
    if (content) {
      parts.push(content.trim());
      restoredCount++;
      console.error(`🔄 Restored: ${relPath} (${content.length} chars)`);
    } else {
      console.error(`⚠️ Not found: ${relPath}`);
    }
  }

  // --- Tier 2: Identity anchors (critical sections only) ---

  const identityPath = paiPath('USER', 'DA_IDENTITY.md');
  const identitySections = extractSections(identityPath, [
    'My Identity',
    'First-Person Voice',
    'Core Values',
    'Personality & Behavior',
    'Cussing & Frustration Protocol',
    'Relationship Model',
    'Pronoun Convention',
  ]);

  if (identitySections) {
    parts.push('# DA Identity (Critical Sections)\n');
    parts.push(identitySections);
    restoredCount++;
    console.error(`🔄 Restored: DA_IDENTITY critical sections (${identitySections.length} chars)`);
  }

  // Current work status
  const status = safeRead(paiPath('USER', 'TELOS', 'STATUS.md'), 20);
  if (status) {
    parts.push('## Current Status');
    parts.push(status);
  }

  // Active ISA if one exists in current session.
  // We look for ISA.md first (v4.1+ canonical) and fall back to PRD.md (legacy).
  try {
    const workDir = paiPath('MEMORY', 'WORK');
    const probe = (filename: string): string =>
      execSync(
        `fd -t f -n "${filename}" --changed-within 60min "${workDir}" 2>/dev/null | head -1`,
        { encoding: 'utf-8', timeout: 3000 }
      ).trim();
    const latestIsa = probe('ISA.md') || probe('PRD.md');
    if (latestIsa) {
      const isaContent = safeRead(latestIsa, 30);
      if (isaContent) {
        parts.push('## Active ISA (last 60min)');
        parts.push(isaContent);
      }
    }
  } catch {
    // Silent — fd not available or no recent artifacts
  }

  // --- Output ---

  if (parts.length > 0) {
    // report.lines(): the push-then-join builder. Byte-identical to the prior
    // ['--- … ---', '', ...parts, '', '---'].join('\n').
    const out = lines();
    out.p('--- PostCompact Context Restoration ---');
    out.p('');
    for (const part of parts) out.p(part);
    out.p('');
    out.p('---');
    const output = out.toString();

    console.log(output);
    console.error(`✅ PostCompact: restored ${restoredCount} context sources (${output.length} chars)`);
  }

  process.exit(0);
}

main();
