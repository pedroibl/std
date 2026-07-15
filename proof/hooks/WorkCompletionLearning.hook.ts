#!/usr/bin/env bun
/**
 * WorkCompletionLearning.hook.ts - Extract Learnings from Completed Work (SessionEnd)
 *
 * PURPOSE:
 * Bridges the WORK/ system to the LEARNING/ system. When a session ends with
 * significant work completed, this hook captures the work metadata (files changed,
 * tools used, ideal state criteria) and creates a learning file for future reference.
 * This ensures insights compound over time rather than being lost.
 *
 * TRIGGER: SessionEnd
 *
 * INPUT:
 * - stdin: Hook input JSON (session_id, transcript_path)
 * - Files: MEMORY/STATE/current-work.json, MEMORY/WORK/<dir>/ISA.md (or legacy PRD.md / META.yaml)
 *
 * OUTPUT:
 * - stdout: None
 * - stderr: Status messages
 * - exit(0): Always (non-blocking)
 *
 * SIDE EFFECTS:
 * - Creates: MEMORY/LEARNING/<category>/<YYYY-MM>/<datetime>_work_<slug>.md
 * - Reads: Current work state and work directory metadata
 *
 * INTER-HOOK RELATIONSHIPS:
 * - COORDINATES WITH: SessionCleanup (both run at SessionEnd)
 * - MUST RUN BEFORE: SessionCleanup (captures before state is cleared)
 * - MUST RUN AFTER: Stop handlers (captures completed work)
 *
 * SIGNIFICANT WORK CRITERIA:
 * A learning is only captured if:
 * - Files were changed, OR
 * - Multiple items exist in work directory, OR
 * - Work was manually created (source: MANUAL)
 *
 * LEARNING CATEGORIES:
 * - ALGORITHM: Insights about process/approach improvement
 * - SYSTEM: Technical system improvements
 * (Determined by getLearningCategory utility)
 *
 * ERROR HANDLING:
 * - No active work: Silent exit
 * - Missing META.yaml: Silent exit
 * - Write failures: Logged to stderr, silent exit
 *
 * PERFORMANCE:
 * - Non-blocking: Yes (fire-and-forget at session end)
 * - Typical execution: <100ms
 *
 * ── Story 13.4 rewrite (consumer sweep) — three real wins; the rest DEFER:
 *    - P1  Promise.race([Bun.stdin.text(),timeout 3000])+JSON.parse (:264-275) → std/stdio
 *          readStdinJson<{session_id?}>(3000)
 *    - slugify hand-roll (:194-197 toLowerCase/replace/slice)                  → std/core slugify(title,30)
 *    - ISC regex `## IDEAL STATE CRITERIA[\s\S]*?(?=\n## |$)` (:331)           → std/core extractSection(·,'## IDEAL STATE CRITERIA')
 * POSTURE (AD-9.4 Rule 2): fail-OPEN, but UNIQUE null action — NOT exit 0. WCL reads work-state from
 *    DISK regardless of stdin; on `null` it must PROCEED with `sessionId = undefined` (→ findStateFile's
 *    legacy current-work.json fallback) or SessionEnd learning capture silently drops whenever stdin is
 *    slow/empty. The VISIBLE branch is the `const sessionId = data?.session_id` assignment, not an exit.
 *    Cite src/stdio/read.ts:7-12.
 * DISCLOSED DELTAS (see deferred-work.md §13-4, not silent):
 *    - slugify is NOT verbatim-equivalent: it trims leading/trailing `-`, drops non-[a-z0-9\s-], and drops
 *      the `.` in `13.3` → `133` (hand-roll kept a leading `-` and mapped `.`→`-`). Emoji-led `13.N` titles
 *      get a cleaner but DIFFERENT LEARNING filename. Tested below (emoji + trailing-punctuation title).
 *    - extractSection stops at the next SAME-OR-SHALLOWER heading (also an intervening `# ` H1), vs the old
 *      regex's H2-only `\n## `. Live ISAs are H2-only (verified: no intervening H1 between IDEAL STATE
 *      CRITERIA and the next H2), so the checkbox count is unchanged; tested both ways.
 * DEFERRED (map over-claims): parseYaml stays caller-local (parses NESTED lineage block-arrays — flat
 *    core.parseFrontmatter cannot model them); date kit DEFERs to 13.7 (lib/time frozen — adopting flips the
 *    LEARNING path host-local→Melbourne, a tz decision that must live in one place); checkboxProgress local.
 * FROZEN: ./lib/time (getISOTimestamp/getPSTDate — 13.7), ./lib/learning-utils (getLearningCategory — its
 *    collapse is default-keep-caller-local, AC4), ./lib/isa-utils (findArtifactPath — 13.5).
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { readStdinJson } from 'std/stdio';
import { slugify, extractSection } from 'std/core';
import { getISOTimestamp, getPSTDate } from './lib/time';
import { getLearningCategory } from './lib/learning-utils';
import { findArtifactPath } from './lib/isa-utils';

const BASE_DIR = process.env.PAI_DIR || join(process.env.HOME!, '.claude', 'PAI');
const MEMORY_DIR = join(BASE_DIR, 'MEMORY');
const STATE_DIR = join(MEMORY_DIR, 'STATE');
const WORK_DIR = join(MEMORY_DIR, 'WORK');
const LEARNING_DIR = join(MEMORY_DIR, 'LEARNING');

// Session-scoped state file lookup with legacy fallback
function findStateFile(sessionId?: string): string | null {
  if (sessionId) {
    const scoped = join(STATE_DIR, `current-work-${sessionId}.json`);
    if (existsSync(scoped)) return scoped;
  }
  const legacy = join(STATE_DIR, 'current-work.json');
  if (existsSync(legacy)) return legacy;
  return null;
}

interface CurrentWork {
  session_id: string;
  session_dir: string;
  created_at: string;
  /** Path to the session's Ideal State Artifact (ISA.md, or legacy PRD.md). */
  isa_path?: string;
  /** @deprecated use isa_path. Kept so older state files still parse. */
  prd_path?: string;
  // Legacy fields (backward compat)
  current_task?: string;
  task_title?: string;
  task_count?: number;
}

interface WorkMeta {
  id: string;
  title: string;
  created_at: string;
  completed_at: string | null;
  source: string;
  status: string;
  session_id: string;
  lineage: {
    tools_used: string[];
    files_changed: string[];
    agents_spawned: string[];
  };
}

function parseYaml(content: string): WorkMeta {
  // Simple YAML parser for our specific format
  const meta: any = {};
  const lines = content.split('\n');
  let currentKey = '';
  let inArray = false;
  let arrayKey = '';
  let lineageSubKey = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Handle array items
    if (trimmed.startsWith('- ') && inArray) {
      const value = trimmed.slice(2).replace(/^["']|["']$/g, '');
      if (arrayKey === 'lineage') {
        // Nested array in lineage — use tracked sub-key
        if (lineageSubKey) meta.lineage[lineageSubKey].push(value);
      } else {
        meta[arrayKey].push(value);
      }
      continue;
    }

    // Handle key: value pairs
    const match = trimmed.match(/^([a-z_]+):\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      currentKey = key;

      if (key === 'lineage') {
        meta.lineage = { tools_used: [], files_changed: [], agents_spawned: [] };
        inArray = false;
        continue;
      }

      if (value === '[]') {
        if (meta.lineage) {
          meta.lineage[key] = [];
        } else {
          meta[key] = [];
        }
        inArray = false;
      } else if (value === '') {
        if (meta.lineage && ['tools_used', 'files_changed', 'agents_spawned'].includes(key)) {
          meta.lineage[key] = [];
          arrayKey = 'lineage';
          lineageSubKey = key;
          inArray = true;
        } else {
          meta[key] = [];
          arrayKey = key;
          inArray = true;
        }
      } else {
        const cleanValue = value.replace(/^["']|["']$/g, '');
        if (meta.lineage && ['tools_used', 'files_changed', 'agents_spawned'].includes(key)) {
          meta.lineage[key] = cleanValue === 'null' ? [] : [cleanValue];
        } else {
          meta[key] = cleanValue === 'null' ? null : cleanValue;
        }
        inArray = false;
      }
    }
  }

  return meta as WorkMeta;
}

/** The LEARNING-filename title slug. Exported PURE so the slugify DELTA (emoji-led / `13.N` titles) is
 *  tested intentionally. std/core slugify: drops non-[a-z0-9\s-], trims leading/trailing `-`, caps to 30. */
export function titleSlug(title: string): string {
  return slugify(title, 30);
}

/** Extract the ISC summary line from an ISA body. Exported PURE so the extractSection boundary caveat
 *  (H2-only regex → same-or-shallower-heading primitive) is tested both ways. Returns '' when absent or
 *  when the section has no checkboxes — identical to the old inline logic. */
export function iscSummary(isaContent: string): string {
  const iscBody = extractSection(isaContent, '## IDEAL STATE CRITERIA');
  if (!iscBody) return '';
  const checked = (iscBody.match(/- \[x\]/g) || []).length;
  const unchecked = (iscBody.match(/- \[ \]/g) || []).length;
  const total = checked + unchecked;
  return total > 0 ? `**ISC:** ${checked}/${total} criteria passing` : '';
}

function getMonthDir(category: 'SYSTEM' | 'ALGORITHM'): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');

  const monthDir = join(LEARNING_DIR, category, `${year}-${month}`);

  if (!existsSync(monthDir)) {
    mkdirSync(monthDir, { recursive: true });
  }

  return monthDir;
}

function writeLearning(workMeta: WorkMeta, idealContent: string): void {
  const category = getLearningCategory(workMeta.title);
  const monthDir = getMonthDir(category);

  const dateStr = getPSTDate();
  const timeStr = new Date().toISOString().split('T')[1].slice(0, 5).replace(':', '');
  const slug = titleSlug(workMeta.title);

  const filename = `${dateStr}_${timeStr}_work_${slug}.md`;
  const filepath = join(monthDir, filename);

  // Don't overwrite existing learnings
  if (existsSync(filepath)) {
    console.error(`[WorkCompletionLearning] Learning already exists: ${filename}`);
    return;
  }

  // Calculate session duration
  let duration = 'Unknown';
  if (workMeta.created_at && workMeta.completed_at) {
    const start = new Date(workMeta.created_at);
    const end = new Date(workMeta.completed_at);
    const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
    if (minutes < 60) {
      duration = `${minutes} minutes`;
    } else {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      duration = `${hours}h ${mins}m`;
    }
  }

  const content = `# Work Completion Learning

**Title:** ${workMeta.title}
**Duration:** ${duration}
**Category:** ${category}
**Session:** ${workMeta.session_id}

---

## Ideal State Criteria

${idealContent || 'Not specified'}

## What Was Done

- **Files Changed:** ${workMeta.lineage?.files_changed?.length || 0}
- **Tools Used:** ${workMeta.lineage?.tools_used?.join(', ') || 'None tracked'}
- **Agents Spawned:** ${workMeta.lineage?.agents_spawned?.length || 0}

## Insights

*This work session completed successfully. Consider what made it effective:*

- Was the approach straightforward or did it require iteration?
- Were there any blockers or surprises?
- What patterns from this work apply to future tasks?

---

*Auto-captured by WorkCompletionLearning hook at session end*
`;

  writeFileSync(filepath, content);
  console.error(`[WorkCompletionLearning] Created learning: ${filename}`);
}

async function main() {
  try {
    // P1 (AD-9.4 Rule 2): posture-neutral read. SessionEnd hooks may receive empty/slow stdin. This hook
    // is fail-OPEN but its null action is UNIQUE — NOT exit 0: work-state is read from DISK regardless of
    // stdin, so on `null` we PROCEED with sessionId = undefined (→ findStateFile's legacy fallback). An
    // exit 0 here would silently drop learning capture whenever stdin is slow/empty. The VISIBLE null
    // branch is this assignment (data?.session_id → undefined). Cite src/stdio/read.ts:7-12.
    const data = await readStdinJson<{ session_id?: string }>(3000);
    const sessionId = data?.session_id;

    // Check if there's an active work session (session-scoped with legacy fallback)
    const stateFile = findStateFile(sessionId);
    if (!stateFile) {
      console.error('[WorkCompletionLearning] No active work session');
      process.exit(0);
    }

    // Read current work state
    const currentWork: CurrentWork = JSON.parse(readFileSync(stateFile, 'utf-8'));

    // Guard: don't process another session's state
    if (sessionId && currentWork.session_id !== sessionId) {
      console.error('[WorkCompletionLearning] State file belongs to different session, skipping');
      process.exit(0);
    }

    if (!currentWork.session_dir) {
      console.error('[WorkCompletionLearning] No work directory in current session');
      process.exit(0);
    }

    // Read work directory metadata — from ISA.md frontmatter (v4.1+),
    // legacy PRD.md frontmatter (v4.0), or META.yaml (pre-v4.0)
    const workPath = join(WORK_DIR, currentWork.session_dir);
    const isaPath = findArtifactPath(currentWork.session_dir);
    const metaPath = join(workPath, 'META.yaml');

    let workMeta: any = {};
    if (isaPath) {
      // v4.0+: Read from ISA.md / PRD.md frontmatter
      const isaContent = readFileSync(isaPath, 'utf-8');
      const fmMatch = isaContent.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        workMeta = parseYaml(fmMatch[1]);
      }
    } else if (existsSync(metaPath)) {
      // Legacy: Read from META.yaml
      const metaContent = readFileSync(metaPath, 'utf-8');
      workMeta = parseYaml(metaContent);
    } else {
      console.error('[WorkCompletionLearning] No ISA.md / PRD.md / META.yaml found');
      process.exit(0);
    }

    // Update completed_at if not set
    if (!workMeta.completed_at) {
      workMeta.completed_at = getISOTimestamp();
    }

    // Extract ISC from ISA.md / PRD.md ISC section (v4.0+) or ISC.json (legacy)
    let idealContent = '';
    if (isaPath) {
      try {
        const isaContent = readFileSync(isaPath, 'utf-8');
        idealContent = iscSummary(isaContent);
      } catch { /* ignore */ }
    } else {
      const iscPath = join(workPath, 'ISC.json');
      if (existsSync(iscPath)) {
        try {
          const iscData = JSON.parse(readFileSync(iscPath, 'utf-8'));
          if (iscData.current?.criteria?.length > 0) {
            idealContent = '**Criteria:**\n' + iscData.current.criteria.map((c: string) => `- ${c}`).join('\n');
          }
          if (iscData.satisfaction) {
            const s = iscData.satisfaction;
            idealContent += `\n\n**Satisfaction:** ${s.satisfied}/${s.total} satisfied, ${s.partial} partial, ${s.failed} failed`;
          }
        } catch { /* ignore */ }
      }
    }

    // Check if this was significant work (has files changed or was manually created)
    const hasSignificantWork = (
      (workMeta.lineage?.files_changed?.length || 0) > 0 ||
      (currentWork.task_count ?? 0) > 1 ||
      workMeta.source === 'MANUAL'
    );

    if (hasSignificantWork) {
      writeLearning(workMeta, idealContent);
    } else {
      console.error('[WorkCompletionLearning] Trivial work session, skipping learning capture');
    }

    process.exit(0);
  } catch (error) {
    // Silent failure - don't disrupt workflow
    console.error(`[WorkCompletionLearning] Error: ${error}`);
    process.exit(0);
  }
}

// Entrypoint guard (matches the 13.3 hook idiom): run main() only when invoked as the harness entry —
// `bun WorkCompletionLearning.hook.ts` → import.meta.main true → runs identically. Importing the module
// (the hermetic tests do, for titleSlug/iscSummary) does NOT execute main. Zero production behavior change.
if (import.meta.main) { main(); }
