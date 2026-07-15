/**
 * learning-readback.ts - Close the learning loop by reading learnings back into context
 *
 * PURPOSE:
 * The PAI learning system writes extensively (8,400+ files across 5 hooks) but
 * previously had no readback mechanism. This library provides fast, compact
 * readers that LoadContext.hook.ts calls at session start to inject accumulated
 * knowledge back into the model's context.
 *
 * FUNCTIONS:
 * - loadLearningDigest()    — Recent learning signals (ALGORITHM + SYSTEM)
 * - loadWisdomFrames()      — Crystallized behavioral patterns (WISDOM/FRAMES)
 * - loadFailurePatterns()   — Recent failure insights (FAILURES)
 * - loadSignalTrends()      — Performance metrics from learning-cache.sh
 * - loadSynthesisPatterns() — Most recent weekly complaint synthesis (SYNTHESIS)
 *
 * PERFORMANCE:
 * Each function reads a small number of pre-existing files (<10).
 * Total budget: <100ms combined. All reads are synchronous for simplicity.
 *
 * OUTPUT:
 * Each function returns a compact string (<500 chars) or null if no data.
 * Combined output stays under 2000 chars for context injection.
 *
 * ── Story 13.4 rewrite (consumer sweep) — the 5 file reads now import a tested std slice; behavior + the
 *    frozen export surface (consumed by LoadContext=13.8 AND PAI/TOOLS/ContextLoadReport.ts) preserved:
 *    - readFileSync ×5 (:60,147,204,251,289) → std/fsx readIfExists (ENOENT→null, else re-throws into the
 *      existing try/catch). The two existsSync-guarded pairs (:204,:289) FOLD (one syscall, no TOCTOU);
 *      the three bare reads gain a `content === null` skip mirroring the old throw→catch.
 * DEFERRED (map over-claims — see deferred-work.md §13-4): the 4 readdirSync dir scans stay caller-local —
 *    fsx.walkFiles is recursive/exhaustive/unordered and would lose the bounded/sorted/early-break semantics
 *    over the 8,400+-file corpus (no `listDir` primitive exists). getMetaField/extractSection also DEFERred
 *    (their tight sub-captures / `\n---` terminator differ from the std shapes). Kept caller-local.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { readIfExists } from 'std/fsx';

/**
 * Read the N most recent learning files from a LEARNING subdirectory.
 * Files are named YYYY-MM-DD-HHMMSS_LEARNING_*.md with YAML frontmatter.
 * Extracts the **Feedback:** line and rating for compact display.
 */
function getRecentLearnings(baseDir: string, subdir: string, count: number, minRating?: number): string[] {
  const insights: string[] = [];
  const learningDir = join(baseDir, 'MEMORY', 'LEARNING', subdir);
  if (!existsSync(learningDir)) return insights;

  try {
    // Get month dirs sorted descending (newest first)
    const months = readdirSync(learningDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
      .map(d => d.name)
      .sort()
      .reverse();

    for (const month of months) {
      if (insights.length >= count) break;
      const monthPath = join(learningDir, month);

      try {
        const files = readdirSync(monthPath)
          .filter(f => f.endsWith('.md'))
          .sort()
          .reverse();

        for (const file of files) {
          if (insights.length >= count) break;
          try {
            const content = readIfExists(join(monthPath, file));
            if (content === null) continue; // ENOENT (raced-away file) → skip, same as the old throw→catch
            const feedbackMatch = content.match(/\*\*Feedback:\*\*\s*(.+)/);
            const ratingMatch = content.match(/rating:\s*(\d+)/);
            if (feedbackMatch) {
              const rating = ratingMatch ? ratingMatch[1] : '?';
              if (minRating !== undefined) {
                const r = ratingMatch ? parseInt(ratingMatch[1], 10) : NaN;
                if (!Number.isFinite(r) || r < minRating) continue; // wins filter: skip below threshold
              }
              const feedback = feedbackMatch[1].substring(0, 80);
              insights.push(`[${rating}/10] ${feedback}`);
            }
          } catch { /* skip unreadable files */ }
        }
      } catch { /* skip unreadable months */ }
    }
  } catch { /* skip if dir scan fails */ }

  return insights;
}

/**
 * Load recent learning signals from ALGORITHM and SYSTEM directories.
 * Returns the 3 most recent from each, formatted as a compact bullet list.
 */
export function loadLearningDigest(paiDir: string): string | null {
  const algorithmInsights = getRecentLearnings(paiDir, 'ALGORITHM', 3);
  const systemInsights = getRecentLearnings(paiDir, 'SYSTEM', 3);

  if (algorithmInsights.length === 0 && systemInsights.length === 0) return null;

  const parts: string[] = ['**Recent Learning Signals:**'];

  if (algorithmInsights.length > 0) {
    parts.push('*Algorithm:*');
    algorithmInsights.forEach(i => parts.push(`  ${i}`));
  }
  if (systemInsights.length > 0) {
    parts.push('*System:*');
    systemInsights.forEach(i => parts.push(`  ${i}`));
  }

  return parts.join('\n');
}

/**
 * Load recent WINS — high-rated learning signals (rating >= 8) from ALGORITHM + SYSTEM.
 * Symmetric to loadFailurePatterns, but surfaces what worked so a session opens with
 * encouragement, not only corrections. Returns null when there are no high-rated signals
 * yet (honest: never fabricates wins — seed WISDOM/FRAMES for a guaranteed positive anchor).
 */
export function loadRecentWins(paiDir: string, minRating = 8): string | null {
  const algorithmWins = getRecentLearnings(paiDir, 'ALGORITHM', 3, minRating);
  const systemWins = getRecentLearnings(paiDir, 'SYSTEM', 3, minRating);

  if (algorithmWins.length === 0 && systemWins.length === 0) return null;

  const parts: string[] = ['**Recent Wins (keep doing these):**'];

  if (algorithmWins.length > 0) {
    parts.push('*Algorithm:*');
    algorithmWins.forEach(i => parts.push(`  ${i}`));
  }
  if (systemWins.length > 0) {
    parts.push('*System:*');
    systemWins.forEach(i => parts.push(`  ${i}`));
  }

  return parts.join('\n');
}

/**
 * Load Wisdom Frame core principles for context injection.
 * Reads all WISDOM/FRAMES/*.md files and extracts principle headers
 * (lines matching "### Name [CRYSTAL: N%]").
 */
export function loadWisdomFrames(paiDir: string): string | null {
  const framesDir = join(paiDir, 'MEMORY', 'WISDOM', 'FRAMES');
  if (!existsSync(framesDir)) return null;

  const principles: string[] = [];

  try {
    const files = readdirSync(framesDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      try {
        const content = readIfExists(join(framesDir, file));
        if (content === null) continue; // ENOENT → skip, same as the old throw→catch
        const domain = file.replace('.md', '');

        // Extract principle headers with CRYSTAL confidence
        const matches = content.matchAll(/^### (.+?) \[CRYSTAL: (\d+)%\]/gm);
        for (const match of matches) {
          const confidence = parseInt(match[2], 10);
          if (confidence >= 85) {
            principles.push(`[${domain}] ${match[1]} (${confidence}%)`);
          }
        }
      } catch { /* skip unreadable frames */ }
    }
  } catch { /* skip if dir scan fails */ }

  if (principles.length === 0) return null;

  return `**Wisdom Frames (high confidence):**\n${principles.map(p => `  ${p}`).join('\n')}`;
}

/**
 * Load recent failure pattern insights.
 * Reads the 5 most recent FAILURES directories and extracts the CONTEXT.md
 * first paragraph for a compact summary of what went wrong.
 */
export function loadFailurePatterns(paiDir: string, limit = 5): string | null {
  const failuresDir = join(paiDir, 'MEMORY', 'LEARNING', 'FAILURES');
  if (!existsSync(failuresDir)) return null;

  const patterns: string[] = [];

  try {
    // Get month dirs sorted descending
    const months = readdirSync(failuresDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
      .map(d => d.name)
      .sort()
      .reverse();

    for (const month of months) {
      if (patterns.length >= limit) break;
      const monthPath = join(failuresDir, month);

      try {
        // Failure dirs are named timestamp_slug
        const dirs = readdirSync(monthPath, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name)
          .sort()
          .reverse();

        for (const dir of dirs) {
          if (patterns.length >= limit) break;
          const contextPath = join(monthPath, dir, 'CONTEXT.md');

          try {
            // readIfExists folds the existsSync+readFileSync pair (one syscall, no TOCTOU): a missing
            // CONTEXT.md → null → skip this failure dir, exactly as the old existsSync guard did.
            const content = readIfExists(contextPath);
            if (content === null) continue;
            // Extract slug as human-readable failure description
            const slug = dir.replace(/^\d{4}-\d{2}-\d{2}-\d{6}_/, '').replace(/-/g, ' ');
            // Get date from dir name
            const dateMatch = dir.match(/^(\d{4}-\d{2}-\d{2})/);
            const date = dateMatch ? dateMatch[1] : '';
            patterns.push(`[${date}] ${slug.substring(0, 70)}`);
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip unreadable months */ }
    }
  } catch { /* skip if dir scan fails */ }

  if (patterns.length === 0) return null;

  return `**Recent Failure Patterns (avoid these):**\n${patterns.map(p => `  ${p}`).join('\n')}`;
}

/**
 * Load the most recent weekly complaint synthesis.
 * Reads MEMORY/LEARNING/SYNTHESIS/YYYY-MM/YYYY-MM-DD_weekly-patterns.md
 * (written by LearningPatternSynthesis.ts) and extracts the average rating
 * plus the top issue clusters so every session is primed with current themes.
 */
export function loadSynthesisPatterns(paiDir: string, limit = 5): string | null {
  const synthesisDir = join(paiDir, 'MEMORY', 'LEARNING', 'SYNTHESIS');
  if (!existsSync(synthesisDir)) return null;

  try {
    // Get month dirs sorted descending (newest first)
    const months = readdirSync(synthesisDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
      .map(d => d.name)
      .sort()
      .reverse();

    for (const month of months) {
      const monthPath = join(synthesisDir, month);

      try {
        const files = readdirSync(monthPath)
          .filter(f => f.endsWith('_weekly-patterns.md'))
          .sort()
          .reverse();

        for (const file of files) {
          try {
            const content = readIfExists(join(monthPath, file));
            if (content === null) continue; // ENOENT → skip, same as the old throw→catch

            const avgMatch = content.match(/\*\*Average Rating:\*\*\s*([\d.]+\/10)/);
            if (!avgMatch) continue;

            // Extract numbered items under "## Top Issues"
            const topIssuesMatch = content.match(/## Top Issues\s*\n([\s\S]*?)(?:\n##|\n---|$)/);
            if (!topIssuesMatch) continue;

            const issues: string[] = [];
            const itemRegex = /^\s*(\d+)\.\s+(.+)$/gm;
            let m: RegExpExecArray | null;
            while ((m = itemRegex.exec(topIssuesMatch[1])) !== null) {
              if (issues.length >= limit) break;
              issues.push(`  ${m[1]}. ${m[2].trim()}`);
            }

            if (issues.length === 0) return null;

            return `**Current Complaint Clusters (from weekly synthesis):** Avg rating ${avgMatch[1]}\n${issues.join('\n')}`;
          } catch { /* skip unreadable files */ }
        }
      } catch { /* skip unreadable months */ }
    }
  } catch { /* skip if dir scan fails */ }

  return null;
}

/**
 * Load performance signal trends from the pre-computed learning-cache.sh.
 * Extracts numeric averages and trend direction for a compact status line.
 */
export function loadSignalTrends(paiDir: string): string | null {
  const cachePath = join(paiDir, 'MEMORY', 'STATE', 'learning-cache.sh');

  try {
    // readIfExists folds the existsSync+readFileSync pair: a missing cache → null → return null,
    // exactly as the old existsSync guard did (one syscall, no TOCTOU).
    const content = readIfExists(cachePath);
    if (content === null) return null;

    // Parse shell variable assignments (key='value' or key=value)
    const vars: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const match = line.match(/^(\w+)='?([^']*)'?$/);
      if (match) vars[match[1]] = match[2];
    }

    const todayAvg = vars.today_avg || '?';
    const weekAvg = vars.week_avg || '?';
    const monthAvg = vars.month_avg || '?';
    const trend = vars.trend || 'stable';
    const totalCount = vars.total_count || '?';
    const dayTrend = vars.day_trend || 'stable';

    const trendEmoji = trend === 'up' ? 'trending up' : trend === 'down' ? 'trending down' : 'stable';

    return `**Performance Signals:** Today: ${todayAvg}/10 | Week: ${weekAvg}/10 | Month: ${monthAvg}/10 | Trend: ${trendEmoji} | Total signals: ${totalCount}`;
  } catch {
    return null;
  }
}
