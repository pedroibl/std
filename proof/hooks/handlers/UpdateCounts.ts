#!/usr/bin/env bun
/**
 * UpdateCounts.ts - Update settings.json with fresh system counts (SessionEnd handler)
 *
 * Invoked by UpdateCounts.hook.ts:18 via handleUpdateCounts(). At session end it recounts the system,
 * writes settings.counts, and refreshes the usage cache. Banner + statusline then read settings.json
 * instantly (no execution at session start).
 *
 * Story 13.3 rewrite (consumer sweep) — the re-hand-rolled edge primitives now import tested std slices,
 * behavior preserved byte-for-byte, ONLY the plumbing swapped:
 *   - the two recursive count walks (orig countFilesRecursive :43-60 / countWorkflowFiles :65-82)
 *                                                        → std/fsx  walkFiles(root, pred)   (P-walk)
 *   - countHooks settings read (orig :118 JSON.parse(readFileSync)) → std/fsx  loadJson     (P-read)
 *   - the usage-cache write (orig :261 writeFileSync)     → std/fsx  atomicWrite            (P-write)
 *   - the two anthropic fetches (orig :208 OAuth usage / :227 cost report)
 *                                                        → std/http fetchWithTimeout        (P-http)
 *   - the macOS Keychain execSync (orig :195)            → std/proc spawnCapture            (P-proc)
 *
 * SETTINGS-SoT WRITE (:293, banner/statusline source of truth — a torn write is high-impact):
 *   the write is the durability upgrade — std/fsx saveJson (= atomicWrite, tmp+rename, torn-write-proof).
 *   The :283 settings READ deliberately uses readIfExists + explicit JSON.parse (NOT loadJson) to PRESERVE
 *   the live no-clobber semantics: a present-but-corrupt settings.json must throw into the outer catch and
 *   skip the write, never be replaced by a counts-only stub (loadJson's soft {}-fallback would risk exactly
 *   that clobber — worse than the torn write we're guarding). readIfExists IS a std/fsx primitive; this is
 *   behavior-preservation, recorded below.
 *
 * Behavioral deltas recorded (not silent), filed in deferred-work.md §13-3:
 *   - :283 settings read: live threw on a MISSING settings.json (readFileSync ENOENT → outer catch → skip).
 *     The rewrite treats absent → seed `{ counts }` (the import.meta.main "seed initial counts" intent).
 *     In production settings.json is always present + valid (it is where THIS hook is wired), so this only
 *     affects a fresh-tree seed. A present-but-corrupt file still fail-loud-skips (no clobber) as live did.
 *   - Keychain: execSync threw on non-zero exit; spawnCapture never rejects, so a non-zero `code` is
 *     re-raised as an explicit throw inside the same best-effort try (identical silent-return outcome).
 *
 * Caller-local identity (D4), kept IN-FILE, never pushed to std: the anthropic URLs, the `Bearer` OAuth
 * token + `x-api-key` admin key (ANTHROPIC_ADMIN_API_KEY), the anthropic-beta/anthropic-version headers,
 * the Keychain service name, every MEMORY source path + count rule, the summary line format.
 *
 * No P3 tz-offset swap here: `updatedAt` is a FROZEN `new Date().toISOString()` (UTC) — preserved as-is.
 */

import { readdirSync, existsSync, statSync, readFileSync, lstatSync } from 'fs';
import { join } from 'path';
import { getPaiDir, getSettingsPath, getClaudeDir } from '../lib/paths';
import { walkFiles, loadJson, saveJson, atomicWrite, readIfExists } from 'std/fsx';
import { fetchWithTimeout } from 'std/http';
import { spawnCapture } from 'std/proc';

interface Counts {
  skills: number;
  skillsPublic: number;
  skillsPrivate: number;
  workflows: number;
  hooks: number;
  signals: number;
  files: number;
  work: number;
  sessions: number;
  research: number;
  ratings: number;
  updatedAt: string;
}

/** The pre-assembled raw parts — the pure count rules, injectable for hermetic testing. */
interface CountParts {
  skills: { total: number; pub: number; priv: number };
  workflows: number;
  hooks: number;
  signals: number;
  files: number;
  work: number;
  sessions: number;
  research: number;
  ratings: number;
}

/** A depth-1 entry of the skills dir, reduced to the fields the classification rule needs (pure input). */
interface SkillEntry {
  name: string;
  isDir: boolean;
  hasSkillMd: boolean;
}

// ── Pure, injectable count rules (no fs/http/keychain) — the load-bearing semantics live HERE ───────────

/**
 * NO-FOLLOW-SYMLINKS guard — the ORIGINAL count walks used `readdirSync` + `entry.isDirectory()`/
 * `entry.isFile()`, which return FALSE for a symlink (a symlink-to-dir/file is `isSymbolicLink()`), so the
 * recursion never descended a symlinked dir nor counted a symlinked file. `walkFiles` stats with `statSync`
 * (FOLLOWS symlinks), so we re-impose the original semantics: prune symlinked dirs, reject symlinked files.
 * Without this, `~/.claude/skills/_CreateStdTool` (a symlink → std-customisations) would leak +3
 * `Workflows/*.md` into the workflows count (187 → 190), silently changing `settings.json` — the
 * banner/statusline SoT. Filed in deferred-work §13-3 as a substrate gap (walkFiles wants a
 * `followSymlinks:false` option; until then the caller guards).
 */
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
const NO_FOLLOW = { prune: (d: string) => isSymlink(d) };

/**
 * Count files matching criteria recursively — P-walk: std/fsx walkFiles is recursive by default, a faithful
 * drop-in for the orig countFilesRecursive once the no-follow-symlinks guard (above) reimposes the original
 * `readdirSync` semantics. A missing/unreadable dir → walkFiles yields [] → 0 (matches the orig try/catch→0).
 */
function countFilesRecursive(dir: string, extension?: string): number {
  return walkFiles(dir, (p) => (!extension || p.endsWith(extension)) && !isSymlink(p), NO_FOLLOW).length;
}

/**
 * PRESERVED count rule (workflows): a file counts iff its name ends with `.md` AND it lives under a
 * directory named `workflows` (case-insensitive) at ANY depth. This matches the orig two-function walk
 * (once inside a `Workflows` dir it counted every `.md` recursively beneath it, exactly once). Pure.
 */
export function isWorkflowMd(path: string): boolean {
  if (!path.endsWith('.md')) return false;
  const segments = path.split('/').slice(0, -1); // directory segments only, drop the filename
  return segments.some((s) => s.toLowerCase() === 'workflows');
}

/** Count `.md` files under any Workflows/ dir — P-walk over the recursive walk (orig countWorkflowFiles).
 *  NO_FOLLOW guard (see isSymlink above) preserves the orig 187 count: a symlinked skill dir
 *  (`_CreateStdTool`) is pruned, not descended, so its Workflows/*.md do not leak in.
 *  Exported for the no-follow-symlinks regression test (the different-LLM-review-flagged 187→190 defect). */
export function countWorkflowFiles(dir: string): number {
  return walkFiles(dir, (p) => isWorkflowMd(p) && !isSymlink(p), NO_FOLLOW).length;
}

/**
 * PRESERVED count rule (skills, `_`-prefix = private): an entry counts iff it is a directory (or a symlink
 * to one) AND contains a SKILL.md; a leading `_` makes it private, else public. total = pub + priv. Pure —
 * the impure depth-1 dir read is in readSkillEntries.
 */
export function classifySkills(entries: SkillEntry[]): { total: number; pub: number; priv: number } {
  let pub = 0;
  let priv = 0;
  for (const e of entries) {
    if (e.isDir && e.hasSkillMd) {
      if (e.name.startsWith('_')) priv++;
      else pub++;
    }
  }
  return { total: pub + priv, pub, priv };
}

/**
 * PRESERVED count rule (hooks = UNIQUE WIRED COMMANDS, byte-for-byte). Counts the distinct non-empty
 * `command` strings registered under `settings.hooks.<event>[].hooks[].command` — NOT `.hook.ts` files on
 * disk. Dormant hooks not wired to any event do not count; a command wired under multiple events counts
 * once (Set dedupe). Malformed/non-array shapes are skipped. `{}` / no hooks → 0.
 */
export function countHooks(settings: unknown): number {
  const events = (settings as { hooks?: unknown })?.hooks ?? {};
  const unique = new Set<string>();
  for (const matchers of Object.values(events as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const list = (matcher as { hooks?: unknown }).hooks;
      if (!Array.isArray(list)) continue;
      for (const h of list) {
        const cmd = (h as { command?: unknown }).command;
        if (typeof cmd === 'string' && cmd.length > 0) unique.add(cmd);
      }
    }
  }
  return unique.size;
}

/**
 * Stitch the raw parts into the frozen Counts shape. Pure — `now` injected, so `updatedAt` is hermetically
 * testable. `updatedAt` is the FROZEN `now.toISOString()` (UTC) — NOT isoOffset.
 */
export function assembleCounts(parts: CountParts, now: Date): Counts {
  return {
    skills: parts.skills.total,
    skillsPublic: parts.skills.pub,
    skillsPrivate: parts.skills.priv,
    workflows: parts.workflows,
    hooks: parts.hooks,
    signals: parts.signals,
    files: parts.files,
    work: parts.work,
    sessions: parts.sessions,
    research: parts.research,
    ratings: parts.ratings,
    updatedAt: now.toISOString(),
  };
}

/** PRESERVED summary stderr line (:294) — extracted pure so the byte-exact format is testable. */
export function formatSummary(c: Counts): string {
  return `[UpdateCounts] Updated: SK:${c.skillsPublic}pu/${c.skillsPrivate}pv WF:${c.workflows} HK:${c.hooks} SIG:${c.signals} F:${c.files} W:${c.work} SESS:${c.sessions} RES:${c.research} RAT:${c.ratings}`;
}

// ── Impure readers (kept faithful; count rules delegated to the pure fns above) ─────────────────────────

/** Read the depth-1 skills dir into SkillEntry[] (preserves the symlink-to-dir + SKILL.md probe). */
function readSkillEntries(skillsDir: string): SkillEntry[] {
  const out: SkillEntry[] = [];
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      const isDir =
        entry.isDirectory() ||
        (entry.isSymbolicLink() && statSync(join(skillsDir, entry.name)).isDirectory());
      out.push({
        name: entry.name,
        isDir,
        hasSkillMd: existsSync(join(skillsDir, entry.name, 'SKILL.md')),
      });
    }
  } catch {
    // skills directory doesn't exist
  }
  return out;
}

/** Count non-empty lines in a JSONL file (signals = rating entries). Preserved verbatim. */
function countRatingsLines(filePath: string): number {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return 0;
    return readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/** Count immediate subdirectories (depth 1). Preserved verbatim. */
function countSubdirs(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

/**
 * Get all counts. Impure walks/reads, but the count RULES are delegated to the pure fns; `now` injected.
 * PRESERVED exact MEMORY source paths.
 */
function getCounts(paiDir: string, now: Date = new Date()): Counts {
  const ratingsPath = join(paiDir, 'MEMORY/LEARNING/SIGNALS/ratings.jsonl');
  const skills = classifySkills(readSkillEntries(join(getClaudeDir(), 'skills')));
  const parts: CountParts = {
    skills,
    workflows: countWorkflowFiles(join(getClaudeDir(), 'skills')),
    // P-read: countHooks reads settings.json via loadJson ({}-fallback → 0, matches orig try/catch→0).
    hooks: countHooks(loadJson<Record<string, unknown>>(getSettingsPath(), {})),
    signals: countFilesRecursive(join(paiDir, 'MEMORY/LEARNING'), '.md'),
    files: countFilesRecursive(join(paiDir, 'PAI/USER')),
    work: countSubdirs(join(paiDir, 'MEMORY/WORK')),
    sessions: countFilesRecursive(join(paiDir, 'MEMORY'), '.jsonl'),
    research:
      countFilesRecursive(join(paiDir, 'MEMORY/RESEARCH'), '.md') +
      countFilesRecursive(join(paiDir, 'MEMORY/RESEARCH'), '.json'),
    ratings: countRatingsLines(ratingsPath),
  };
  return assembleCounts(parts, now);
}

/**
 * Refresh usage cache from Anthropic OAuth API. Best-effort — any failure returns silently (the status
 * line falls back to stale cache). Caller-local identity (URLs / tokens / headers / Keychain service) is
 * kept in-file (D4).
 */
async function refreshUsageCache(paiDir: string): Promise<void> {
  const usageCachePath = join(paiDir, 'MEMORY/STATE/usage-cache.json');

  try {
    // Extract OAuth token — macOS Keychain (P-proc) or Linux credentials file.
    let credJson: string;
    if (process.platform === 'darwin') {
      // spawnCapture never rejects; a non-zero exit re-raises the execSync-throw (same silent-return).
      const result = await spawnCapture(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: 3000 },
      );
      if (result.code !== 0) throw new Error('keychain lookup failed');
      credJson = result.stdout.trim();
    } else {
      const credPath = join(process.env.HOME || '', '.claude', '.credentials.json');
      credJson = readFileSync(credPath, 'utf-8').trim();
    }

    const parsed = JSON.parse(credJson);
    const token = parsed?.claudeAiOauth?.accessToken;
    if (!token) return;

    // P-http: fail-soft — fetchWithTimeout returns the raw Response; if(!ok) return (no throw).
    const resp = await fetchWithTimeout('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      timeout: 3000,
    });

    if (!resp.ok) return;
    const data = (await resp.json()) as Record<string, unknown>;
    if (!data?.five_hour) return;

    // Fetch API workspace cost if admin key is available
    const adminKey = process.env.ANTHROPIC_ADMIN_API_KEY;
    if (adminKey) {
      try {
        const now = new Date();
        const startOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01T00:00:00Z`;
        // P-http: second fail-soft fetch — if(costResp.ok) branch preserved.
        const costResp = await fetchWithTimeout(
          `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${startOfMonth}`,
          {
            headers: {
              'x-api-key': adminKey,
              'anthropic-version': '2023-06-01',
            },
            timeout: 5000,
          },
        );
        if (costResp.ok) {
          const costData = (await costResp.json()) as any;
          // Sum all daily cost entries (amount is cents as decimal string)
          let totalCostCents = 0;
          if (Array.isArray(costData?.data)) {
            for (const day of costData.data) {
              if (Array.isArray(day?.results)) {
                for (const entry of day.results) {
                  totalCostCents += parseFloat(entry.amount || '0');
                }
              }
            }
          }
          (data as any).workspace_cost = {
            month_used_cents: Math.round(totalCostCents),
            updated_at: new Date().toISOString(),
          };
          console.error(`[UpdateCounts] Workspace cost: $${(totalCostCents / 100).toFixed(2)} this month`);
        }
      } catch {
        // Non-fatal — admin API unavailable
      }
    }

    // P-write: atomicWrite (tmp+rename) — durability upgrade over the orig writeFileSync; content byte-identical.
    atomicWrite(usageCachePath, JSON.stringify(data, null, 2) + '\n');
    console.error(`[UpdateCounts] Usage cache refreshed: 5H=${(data.five_hour as any)?.utilization}% 7D=${(data.seven_day as any)?.utilization}%`);
  } catch {
    // Non-fatal — status line falls back to stale cache
  }
}

/**
 * Handler called by UpdateCounts.hook.ts — EXACT signature preserved (parent calls handleUpdateCounts()).
 */
export async function handleUpdateCounts(): Promise<void> {
  const paiDir = getPaiDir();
  const settingsPath = getSettingsPath();

  try {
    // Run counts + usage refresh in parallel
    const [counts] = await Promise.all([
      Promise.resolve(getCounts(paiDir)),
      refreshUsageCache(paiDir),
    ]);

    // Read current settings. NO-CLOBBER (preserves live): a present file must parse — a corrupt settings.json
    // throws into the outer catch and skips the write, never gets replaced by a counts-only stub. Absent →
    // seed { counts } (the import.meta.main seed intent). See header behavioral-delta note.
    const rawSettings = readIfExists(settingsPath);
    const settings: Record<string, unknown> =
      rawSettings !== null ? (JSON.parse(rawSettings) as Record<string, unknown>) : {};

    // Update counts section
    settings.counts = counts;

    // v6.2.0+: settings.pai.algorithmVersion was removed; LATEST is the single source
    // of truth and Banner / statusline / ArchitectureSummaryGenerator read it directly.
    // The CLAUDE.md → settings.json sync that lived here is no longer needed.

    // Write back — :293 banner/statusline SoT. P-write: saveJson = atomicWrite (tmp+rename), torn-write-proof.
    // saveJson emits JSON.stringify(value, null, 2) + '\n' — byte-identical to the orig writeFileSync string.
    saveJson(settingsPath, settings);
    console.error(formatSummary(counts));
  } catch (error) {
    console.error('[UpdateCounts] Failed to update counts:', error);
    // Non-fatal - don't throw, let other handlers continue
  }
}

// Allow running standalone to seed initial counts
if (import.meta.main) {
  handleUpdateCounts().then(() => process.exit(0));
}
