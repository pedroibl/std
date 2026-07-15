/**
 * PAI Security Logger — Unified security event logging
 *
 * All security events log to MEMORY/SECURITY/YYYY/MM/ with descriptive filenames.
 * Logging failures are silent — they must never block operations.
 *
 * ── Story 13.6 rewrite (security cluster) — the SINGLE win here is the fs → std/fsx swap:
 *    - existsSync + mkdirSync + writeFileSync (:41-45) → fsx.atomicWrite (ensureDir + tmp-write + rename).
 *      The file CONTENT is byte-identical (JSON.stringify(event, null, 2), no trailing newline added);
 *      the write just becomes atomic (benign hardening — disclosed in deferred-work §13-6).
 * NON-SWAP (validators E2 / N-a): `slugify` here is WORD-capped (maxWords=5); core.slugify is CHAR-capped
 *    (maxLen) → NOT identical, would change the filename shape → kept caller-local. `timestamp` returns a
 *    `YYYYMMDD-HHMMSS` stamp; core.dateParts has NO hour/minute/second and its `month` is a number (→ `7`
 *    not `07`) → cannot reconstruct the stamp → kept fully caller-local. tz stays Pedro's actual (system
 *    local = Australia/Melbourne on his machine); no LA/kai template default is introduced.
 */

import { atomicWrite } from 'std/fsx';
import { paiPath } from '../lib/paths';
import type { SecurityEvent } from './types';

function slugify(text: string, maxWords = 5): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1)
    .slice(0, maxWords)
    .join('-');
}

function timestamp(): { year: string; month: string; stamp: string } {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return { year: y.toString(), month: mo, stamp: `${y}${mo}${d}-${h}${mi}${s}` };
}

export function logSecurityEvent(event: SecurityEvent): void {
  try {
    const ts = timestamp();
    const summary = slugify(event.reason || event.target || 'unknown');
    const filename = `security-${event.eventType}-${summary}-${ts.stamp}.jsonl`;
    const logPath = paiPath('MEMORY', 'SECURITY', ts.year, ts.month, filename);

    atomicWrite(logPath, JSON.stringify(event, null, 2));
  } catch {
    // Logging failure must never block operations
    console.error('[SecurityLogger] Failed to write security event');
  }
}
