/**
 * change-detection.ts - Utilities for detecting PAI system changes
 *
 * Parses transcripts for file modification tool_use blocks and categorizes
 * changes to determine if background integrity maintenance is needed.
 *
 * Story 13.3 rewrite (consumer sweep) — FROZEN FACADE (AD-9.4 Rule 3): the 5-type + 12-fn exported
 * surface is byte-identical (names / signatures / param + return types unchanged — the single same-cluster
 * importer SystemIntegrity.ts binds to it). ONLY three INTERNALS are swapped to tested std slices; the whole
 * categorize / significance / title taxonomy + every path/pattern constant stays caller-local (D4):
 *   - parseToolUseBlocks per-line JSON.parse (orig :119-165)          → core.parseNdjson  (P1)
 *   - readIntegrityState existsSync+readFileSync+JSON.parse (:343-350) → fsx.loadJson      (P2)
 *   - hashChanges djb2 `(h<<5)-h` variant (orig :367-380)             → core.contentHash  (P3)
 *
 * This file supersedes the AC5 proof-only placeholder shim (which carried only the SystemIntegrity-consumed
 * subset with real hashChanges/getCooldownEndTime + inert stubs); it now OWNS the full frozen facade.
 *
 * Behavioral deltas recorded (not silent):
 *   - DIGEST DELTA (P3): core.contentHash (djb2 `h*33 ^ c`, 5381 seed, `>>>0`) ≠ the old `(h<<5)-h` variant,
 *     and it first collapse()+toLowerCase()+slice(0,400)-normalizes the serialized string. So the produced
 *     `last_changes_hash` values differ from the pre-cutover ones → a ONE-TIME cooldown/dedup reset on the
 *     first post-cutover run (acceptable: the hash is only ever compared to itself — isDuplicateRun vs
 *     state.last_changes_hash — never to a persisted foreign digest).
 *   - FS POSTURE (P2): fsx.loadJson's readIfExists re-throws a genuine fs fault (EACCES/ENOTDIR) where the
 *     old try/catch swallowed ALL errors to null. Missing-file and unparseable-JSON still → null (fallback),
 *     identical; only a real permission/type fault now surfaces (std fail-loud posture).
 */

import { readFileSync, existsSync } from 'fs';
import { join, relative, basename } from 'path';
import { getPaiDir } from './paths';
import { parseNdjson, contentHash } from 'std/core';
import { loadJson } from 'std/fsx';

// ============================================================================
// Types
// ============================================================================

export interface FileChange {
  tool: 'Write' | 'Edit' | 'MultiEdit';
  path: string;
  category: ChangeCategory | null;
  isPhilosophical: boolean;
  isStructural: boolean;
}

export type ChangeCategory =
  | 'skill'
  | 'hook'
  | 'workflow'
  | 'config'
  | 'core-system'
  | 'memory-system'
  | 'documentation';

export type SignificanceLabel = 'trivial' | 'minor' | 'moderate' | 'major' | 'critical';

export type ChangeType =
  | 'skill_update'
  | 'structure_change'
  | 'doc_update'
  | 'hook_update'
  | 'workflow_update'
  | 'config_update'
  | 'tool_update'
  | 'multi_area';

export interface IntegrityState {
  last_run: string;
  last_changes_hash: string;
  cooldown_until: string | null;
}

// Minimal shape of a transcript NDJSON line — caller-local (D4), kept so the parseNdjson result is
// field-accessible exactly as the pre-swap `JSON.parse(line)` (`any`) was.
interface TranscriptEntry {
  type?: string;
  message?: { content?: unknown };
}

// ============================================================================
// Path Constants
// ============================================================================

const PAI_DIR = getPaiDir();
const STATE_FILE = join(PAI_DIR, 'MEMORY', 'STATE', 'integrity-state.json');

// Paths that are excluded from integrity checks
const EXCLUDED_PATHS = [
  'MEMORY/WORK/',
  'MEMORY/LEARNING/',
  'MEMORY/STATE/',
  'Plans/',
  'projects/',
  '.git/',
  'node_modules/',
  'ShellSnapshots/',
];

// High-priority paths that always warrant documentation
const HIGH_PRIORITY_PATHS = [
  'PAI/',
  'PAISYSTEMARCHITECTURE.md',
  'SKILLSYSTEM.md',
  'MEMORYSYSTEM.md',
  'THEHOOKSYSTEM.md',
  'THEDELEGATIONSYSTEM.md',
  'THENOTIFICATIONSYSTEM.md',
  'settings.json',
];

// Philosophical/architectural patterns in paths
const PHILOSOPHICAL_PATTERNS = [
  /PAI\//i,
  /ARCHITECTURE/i,
  /PRINCIPLES/i,
  /FOUNDING/i,
  /IDENTITY/i,
];

// Structural change patterns
const STRUCTURAL_PATTERNS = [
  /\/SKILL\.md$/i,           // Skill definitions
  /\/Workflows\//i,          // Workflow routing
  /settings\.json$/i,        // Configuration
  /frontmatter/i,            // Metadata changes
];

// ============================================================================
// Transcript Parsing
// ============================================================================

/**
 * Parse tool_use blocks from a transcript that modify files.
 * Extracts Write, Edit, and MultiEdit operations.
 */
export function parseToolUseBlocks(transcriptPath: string): FileChange[] {
  try {
    if (!existsSync(transcriptPath)) {
      console.error('[ChangeDetection] Transcript not found:', transcriptPath);
      return [];
    }

    const content = readFileSync(transcriptPath, 'utf-8');
    // P1: per-line `JSON.parse` in a try/catch (skip malformed) → core.parseNdjson (same split→parse→skip).
    const entries = parseNdjson<TranscriptEntry>(content);
    const changes: FileChange[] = [];
    const seenPaths = new Set<string>();

    for (const entry of entries) {
      // Look for assistant messages with tool_use
      if (entry.type === 'assistant' && entry.message?.content) {
        const contentArray = Array.isArray(entry.message.content)
          ? entry.message.content
          : [];

        for (const block of contentArray) {
          if (block.type !== 'tool_use') continue;

          const toolName = block.name;
          const input = block.input || {};

          // Handle Write, Edit, MultiEdit tools
          if (toolName === 'Write' && input.file_path) {
            const path = normalizeToRelativePath(input.file_path);
            if (!seenPaths.has(path)) {
              seenPaths.add(path);
              changes.push(createFileChange('Write', path));
            }
          } else if (toolName === 'Edit' && input.file_path) {
            const path = normalizeToRelativePath(input.file_path);
            if (!seenPaths.has(path)) {
              seenPaths.add(path);
              changes.push(createFileChange('Edit', path));
            }
          } else if (toolName === 'MultiEdit' && input.edits) {
            for (const edit of input.edits) {
              if (edit.file_path) {
                const path = normalizeToRelativePath(edit.file_path);
                if (!seenPaths.has(path)) {
                  seenPaths.add(path);
                  changes.push(createFileChange('Edit', path));
                }
              }
            }
          }
        }
      }
    }

    return changes;
  } catch (error) {
    console.error('[ChangeDetection] Error parsing transcript:', error);
    return [];
  }
}

/**
 * Normalize an absolute path to relative (to PAI_DIR).
 */
function normalizeToRelativePath(absolutePath: string): string {
  if (absolutePath.startsWith(PAI_DIR)) {
    return relative(PAI_DIR, absolutePath);
  }
  return absolutePath;
}

/**
 * Create a FileChange object with categorization.
 */
function createFileChange(tool: 'Write' | 'Edit', path: string): FileChange {
  return {
    tool,
    path,
    category: categorizeChange(path),
    isPhilosophical: isPhilosophicalPath(path),
    isStructural: isStructuralPath(path),
  };
}

// ============================================================================
// Change Categorization
// ============================================================================

/**
 * Categorize a file path by its location in the PAI system.
 */
export function categorizeChange(path: string): ChangeCategory | null {
  // Check exclusions first
  for (const excluded of EXCLUDED_PATHS) {
    if (path.includes(excluded)) {
      return null;
    }
  }

  // Check if path is within PAI directory
  const absolutePath = path.startsWith('/') ? path : join(PAI_DIR, path);
  if (!absolutePath.startsWith(PAI_DIR)) {
    return null;
  }

  // Categorize by path pattern
  if (path.includes('skills/')) {
    // Exclude personal/private skills (prefixed with _ by convention)
    const skillMatch = path.match(/skills\/(_[^/]+)/);
    if (skillMatch) return null;
    if (path.includes('/Workflows/')) return 'workflow';
    if (path.match(/PAI\/(?:DOCUMENTATION\/)?(?:PAISYSTEM|THEHOOKSYSTEM|THEDELEGATION|MEMORYSYSTEM)/)) return 'core-system';
    return 'skill';
  }

  if (path.includes('hooks/')) return 'hook';
  if (path.includes('MEMORY/PAISYSTEMUPDATES/')) return 'documentation';
  if (path.includes('MEMORY/')) return 'memory-system';
  if (path.endsWith('settings.json')) return 'config';
  if (path.endsWith('.md') && !path.includes('WORK/')) return 'documentation';

  return null;
}

/**
 * Check if a path represents philosophical/architectural content.
 */
function isPhilosophicalPath(path: string): boolean {
  for (const pattern of PHILOSOPHICAL_PATTERNS) {
    if (pattern.test(path)) return true;
  }
  for (const highPriority of HIGH_PRIORITY_PATHS) {
    if (path.includes(highPriority)) return true;
  }
  return false;
}

/**
 * Check if a path represents structural content (SKILL.md, workflows, config).
 */
function isStructuralPath(path: string): boolean {
  for (const pattern of STRUCTURAL_PATTERNS) {
    if (pattern.test(path)) return true;
  }
  return false;
}

// ============================================================================
// Significance Detection
// ============================================================================

/**
 * Determine if changes are significant enough to warrant background integrity check.
 */
export function isSignificantChange(changes: FileChange[]): boolean {
  // Filter to only PAI system changes
  const systemChanges = changes.filter(c => c.category !== null);

  if (systemChanges.length === 0) return false;

  // Always significant if philosophical or structural changes
  if (systemChanges.some(c => c.isPhilosophical || c.isStructural)) {
    return true;
  }

  // Significant if multiple files in same domain
  const categories = new Set(systemChanges.map(c => c.category));
  if (categories.size >= 1 && systemChanges.length >= 2) {
    return true;
  }

  // Significant if any skill, hook, or core-system change
  const importantCategories: ChangeCategory[] = ['skill', 'hook', 'core-system', 'workflow'];
  if (systemChanges.some(c => importantCategories.includes(c.category!))) {
    return true;
  }

  return false;
}

/**
 * Check if changes warrant documentation.
 * UPDATED: Lower thresholds for more granular, frequent documentation.
 * Philosophy: File system is cheap, more signal is valuable.
 */
export function shouldDocumentChanges(changes: FileChange[]): boolean {
  const systemChanges = changes.filter(c => c.category !== null);

  // No changes to document
  if (systemChanges.length === 0) return false;

  // Always document philosophical or structural changes
  if (systemChanges.some(c => c.isPhilosophical || c.isStructural)) {
    return true;
  }

  // Document ANY skill, hook, workflow, core-system, or config change
  const importantCategories: ChangeCategory[] = ['skill', 'hook', 'workflow', 'core-system', 'config'];
  if (systemChanges.some(c => c.category && importantCategories.includes(c.category))) {
    return true;
  }

  // Document if 2+ files changed (lowered from 3+)
  if (systemChanges.length >= 2) {
    return true;
  }

  // Document new file creation in system areas
  const newFiles = systemChanges.filter(c => c.tool === 'Write');
  if (newFiles.length > 0) return true;

  // Document any tool file changes (.ts in Tools/)
  if (systemChanges.some(c => c.path.includes('/Tools/') && c.path.endsWith('.ts'))) {
    return true;
  }

  return false;
}

// ============================================================================
// Throttling
// ============================================================================

// Reduced from 5 to 2 minutes for more frequent documentation updates
const COOLDOWN_MINUTES = 2;

/**
 * Read the current integrity state.
 */
export function readIntegrityState(): IntegrityState | null {
  // P2: existsSync + readFileSync + JSON.parse (swallow-all → null) → fsx.loadJson with a null fallback.
  // Missing-file and unparseable-JSON still resolve to null; a genuine fs fault now surfaces (fail-loud).
  return loadJson<IntegrityState | null>(STATE_FILE, null);
}

/**
 * Check if we're within the cooldown period.
 */
export function isInCooldown(): boolean {
  const state = readIntegrityState();
  if (!state?.cooldown_until) return false;

  const cooldownUntil = new Date(state.cooldown_until);
  return new Date() < cooldownUntil;
}

/**
 * Generate a hash of changes for deduplication.
 */
export function hashChanges(changes: FileChange[]): string {
  // Canonical serialization stays caller-local (D4).
  const sorted = changes
    .map(c => `${c.tool}:${c.path}`)
    .sort()
    .join('|');

  // P3: djb2 `(h<<5)-h` variant → core.contentHash. Digest values differ from the old variant (see header
  // DIGEST DELTA); the hash is only ever compared to itself, so a one-time dedup reset is the only effect.
  // Pass the full length so the ENTIRE sorted change-list is hashed (matching the old djb2's full-string
  // hash) — contentHash defaults to a 400-char slice, which would risk false-duplicates on long change
  // lists (the hash is only ever compared to itself, but truncation would suppress a legitimate re-run).
  return contentHash(sorted, sorted.length);
}

/**
 * Check if changes are duplicates of the last run.
 */
export function isDuplicateRun(changes: FileChange[]): boolean {
  const state = readIntegrityState();
  if (!state?.last_changes_hash) return false;

  const currentHash = hashChanges(changes);
  return currentHash === state.last_changes_hash;
}

/**
 * Get the cooldown end time.
 */
export function getCooldownEndTime(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() + COOLDOWN_MINUTES);
  return now.toISOString();
}

// ============================================================================
// Significance and Change Type Determination
// ============================================================================

/**
 * Determine the significance label based on change characteristics.
 */
export function determineSignificance(changes: FileChange[]): SignificanceLabel {
  const count = changes.length;
  const hasStructural = changes.some(c => c.isStructural);
  const hasPhilosophical = changes.some(c => c.isPhilosophical);
  const hasNewFiles = changes.some(c => c.tool === 'Write');

  const categories = new Set(changes.map(c => c.category).filter(Boolean));
  const hasCoreSystem = changes.some(c => c.category === 'core-system');
  const hasHooks = changes.some(c => c.category === 'hook');
  const hasSkills = changes.some(c => c.category === 'skill');

  // Critical: breaking changes, major restructuring
  if (hasStructural && hasPhilosophical && count >= 5) {
    return 'critical';
  }

  // Major: new skills/workflows, architectural decisions
  if (hasNewFiles && (hasStructural || hasPhilosophical)) {
    return 'major';
  }
  if (hasCoreSystem || (categories.size >= 3)) {
    return 'major';
  }
  if (hasHooks && count >= 3) {
    return 'major';
  }

  // Moderate: multi-file updates, small features
  if (count >= 3 || categories.size >= 2) {
    return 'moderate';
  }
  if (hasSkills && count >= 2) {
    return 'moderate';
  }

  // Minor: single file doc updates
  if (count === 1 && !hasStructural && !hasPhilosophical) {
    return 'minor';
  }

  // Trivial: only if very small doc changes
  if (count === 1 && changes[0].category === 'documentation') {
    return 'trivial';
  }

  return 'minor';
}

/**
 * Determine the change type based on affected files.
 */
export function inferChangeType(changes: FileChange[]): ChangeType {
  const categories = changes.map(c => c.category).filter(Boolean);
  const uniqueCategories = new Set(categories);

  // Multi-area if touching 3+ categories
  if (uniqueCategories.size >= 3) {
    return 'multi_area';
  }

  // Single category cases
  if (uniqueCategories.size === 1) {
    const cat = [...uniqueCategories][0];
    switch (cat) {
      case 'skill': return changes.some(c => c.isStructural) ? 'structure_change' : 'skill_update';
      case 'hook': return 'hook_update';
      case 'workflow': return 'workflow_update';
      case 'config': return 'config_update';
      case 'core-system': return 'structure_change';
      case 'documentation': return 'doc_update';
      default: return 'skill_update';
    }
  }

  // Two categories - pick the more significant one
  if (uniqueCategories.has('hook')) return 'hook_update';
  if (uniqueCategories.has('skill')) return 'skill_update';
  if (uniqueCategories.has('workflow')) return 'workflow_update';
  if (uniqueCategories.has('config')) return 'config_update';

  return 'multi_area';
}

/**
 * Generate a descriptive 4-8 word title based on the changes.
 */
export function generateDescriptiveTitle(changes: FileChange[]): string {
  const paths = changes.map(c => c.path);

  // Extract skill names
  const skillNames = new Set<string>();
  for (const p of paths) {
    const match = p.match(/skills\/([^/]+)\//);
    if (match && match[1] !== 'PAI') skillNames.add(match[1]);
  }

  // Detect file types
  const hasSkillMd = paths.some(p => p.endsWith('SKILL.md'));
  const hasWorkflows = paths.some(p => p.includes('/Workflows/'));
  const hasTools = paths.some(p => p.includes('/Tools/') && p.endsWith('.ts'));
  const hasHooks = paths.some(p => p.includes('hooks/'));
  const hasConfig = paths.some(p => p.endsWith('settings.json'));
  const hasCoreSystem = paths.some(p => p.match(/PAI\/(?:DOCUMENTATION\/)?(?:PAISYSTEM|THEHOOKSYSTEM|THEDELEGATION|MEMORYSYSTEM)/));
  const hasCoreUser = paths.some(p => p.includes('PAI/USER/'));

  let title = '';

  // Single skill update
  if (skillNames.size === 1) {
    const skill = [...skillNames][0];
    if (hasSkillMd) {
      title = `${skill} Skill Definition Update`;
    } else if (hasWorkflows) {
      const workflowNames = paths
        .filter(p => p.includes('/Workflows/'))
        .map(p => basename(p, '.md'));
      if (workflowNames.length === 1) {
        title = `${skill} ${workflowNames[0]} Workflow Update`;
      } else {
        title = `${skill} Workflows Updated`;
      }
    } else if (hasTools) {
      const toolNames = paths
        .filter(p => p.includes('/Tools/'))
        .map(p => basename(p, '.ts'));
      if (toolNames.length === 1) {
        title = `${skill} ${toolNames[0]} Tool Update`;
      } else {
        title = `${skill} Tools Updated`;
      }
    } else {
      title = `${skill} Skill Files Updated`;
    }
  }
  // Multiple skills
  else if (skillNames.size > 1 && skillNames.size <= 3) {
    const skills = [...skillNames].slice(0, 3).join(' and ');
    title = `${skills} Skills Updated`;
  }
  // Hook changes
  else if (hasHooks) {
    const hookNames = paths
      .filter(p => p.includes('hooks/'))
      .map(p => basename(p, '.ts').replace('.hook', ''));
    if (hookNames.length === 1) {
      title = `${hookNames[0]} Hook Updated`;
    } else if (hookNames.length <= 3) {
      title = `${hookNames.slice(0, 3).join(', ')} Hooks Updated`;
    } else {
      title = `Hook System Updates`;
    }
  }
  // Config changes
  else if (hasConfig) {
    title = 'System Configuration Updated';
  }
  // Core system changes
  else if (hasCoreSystem) {
    const docNames = paths
      .filter(p => p.match(/PAI\/(?:DOCUMENTATION\/)?(?:PAISYSTEM|THEHOOKSYSTEM|THEDELEGATION|MEMORYSYSTEM)/))
      .map(p => basename(p, '.md'));
    if (docNames.length === 1) {
      title = `${docNames[0]} Documentation Updated`;
    } else {
      title = 'PAI System Documentation Updated';
    }
  }
  // Core user changes
  else if (hasCoreUser) {
    const docNames = paths
      .filter(p => p.includes('PAI/USER/'))
      .map(p => basename(p, '.md'));
    if (docNames.length === 1) {
      title = `${docNames[0]} User Config Updated`;
    } else {
      title = 'User Configuration Updated';
    }
  }
  // Fallback
  else {
    const categories = new Set(changes.map(c => c.category).filter(Boolean));
    if (categories.size === 1) {
      const cat = [...categories][0];
      title = `${capitalize(cat || 'System')} Updates Applied`;
    } else {
      title = 'Multi-Area System Updates Applied';
    }
  }

  // Ensure 4-8 words
  const words = title.split(/\s+/);
  if (words.length < 4) {
    title = `PAI ${title}`;
  } else if (words.length > 8) {
    title = words.slice(0, 8).join(' ');
  }

  return title;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
