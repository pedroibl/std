#!/usr/bin/env bun
/**
 * ContainmentGuard.hook.ts — PreToolUse Edit/Write/MultiEdit gate
 *
 * Blocks writes that would leak sensitive identity/infra strings into
 * files outside the Z1-Z4 containment zones used by ShadowRelease.
 *
 * Z1 USER/**            Z3 PAI/MEMORY/**
 * Z2 settings*.json     Z4 skills/_*
 *
 * Anything outside those zones must stay clean of:
 *   /Users/daniel, daniel@, kai@unsupervised-learning, danielmiessler.com,
 *   admin.ul.live, 889c0252fcc9f919765fa9f62467d46e (CF account ID),
 *   0baeb281c44f46878a4650ee3ff26b5b (CF KV namespace ID).
 *
 * TRIGGER: PreToolUse (matcher: Edit, Write, MultiEdit)
 * EXIT CODES: 0 = allow, 2 = deny (blocks the write)
 *
 * Test safely:
 *   echo '{"tool_name":"Write","tool_input":{"file_path":"/Users/daniel/.claude/hooks/demo.ts","content":"const u = \"/Users/daniel\";"}}' | bun run hooks/ContainmentGuard.hook.ts; echo $?
 *
 * ── Story 13.6 rewrite (security cluster) — the SINGLE win + the ONE real migration:
 *    - stdin: SYNC readFileSync('/dev/stdin')+trim+JSON.parse (:99-104) → std/stdio readStdinJson<HookInput>()
 *      → main() becomes ASYNC (the sync→async migration this story flags). Verified: the `await` still
 *      flushes console.error/exit(2) before the process exits.
 * POSTURE (AD-9.4 Rule 2 — fail-CLOSED, HARDENED): a PreToolUse Edit/Write gate (dormant, but a live gate)
 *    that cannot read its event must DENY. Pre-13.6 the sync reader fail-OPENED (`if(!raw.trim()) return`).
 *    `null → exit 2`. Cite src/stdio/read.ts:7-12.
 * NOTE: containment-zones.ts stays SINGLE-CONSUMER (validator E1) — skills/_PAI/TOOLS/ShadowRelease.ts does
 *    NOT exist; the "ShadowRelease" strings in the header/allowlist are STALE (flagged in deferred-work §13-6),
 *    not a live consumer. The facade is still frozen as a conservative default (AD-9.4 Rule 3).
 */

import { readStdinJson } from 'std/stdio';
import { isContained, isPatternAllowlisted, relativeToClaudeRoot } from './lib/containment-zones';

interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface ScanTarget {
  filePath: string;
  content: string;
  label: string;
}

const IDENTITY_PATTERNS: readonly string[] = [
  '/Users/daniel',
  'daniel@',
  'kai@unsupervised-learning',
  'danielmiessler.com',
  'admin.ul.live',
  '889c0252fcc9f919765fa9f62467d46e',
  '0baeb281c44f46878a4650ee3ff26b5b',
];

const CLAUDE_ROOT = `${process.env.HOME ?? ''}/.claude`;

function isUnderClaudeRoot(filePath: string): boolean {
  const prefix = CLAUDE_ROOT.endsWith('/') ? CLAUDE_ROOT : CLAUDE_ROOT + '/';
  return filePath === CLAUDE_ROOT || filePath.startsWith(prefix);
}

function isFileContained(filePath: string): boolean {
  // Files outside ~/.claude/ are personal project repos (~/Projects, ~/LocalProjects, etc.)
  // and are not part of the PAI release tree that ShadowRelease scrubs. The containment
  // guard exists to keep PAI public-release content clean — not to police Daniel's own projects.
  if (!isUnderClaudeRoot(filePath)) return true;
  if (isPatternAllowlisted(relativeToClaudeRoot(filePath, CLAUDE_ROOT))) return true;
  return isContained(filePath, CLAUDE_ROOT);
}

function extractScanTargets(toolName: string, toolInput: Record<string, unknown>): ScanTarget[] {
  const targets: ScanTarget[] = [];
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
  if (!filePath) return targets;
  if (toolName === 'Write') {
    const content = typeof toolInput.content === 'string' ? toolInput.content : '';
    targets.push({ filePath, content, label: 'content' });
    return targets;
  }
  if (toolName === 'Edit') {
    const newString = typeof toolInput.new_string === 'string' ? toolInput.new_string : '';
    targets.push({ filePath, content: newString, label: 'new_string' });
    return targets;
  }
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    edits.forEach((edit, index) => {
      if (!edit || typeof edit !== 'object') return;
      const ns = (edit as Record<string, unknown>).new_string;
      if (typeof ns === 'string') targets.push({ filePath, content: ns, label: `edits[${index}].new_string` });
    });
  }
  return targets;
}

function findMatch(content: string): string | undefined {
  for (const pattern of IDENTITY_PATTERNS) {
    if (content.includes(pattern)) return pattern;
  }
  return undefined;
}

async function main(): Promise<void> {
  // POSTURE: null → exit 2 (deny). A PreToolUse Edit/Write gate that cannot read its event fails CLOSED.
  // Cite src/stdio/read.ts:7-12.
  const input = await readStdinJson<HookInput>();
  if (!input) {
    process.stderr.write('[ContainmentGuard] 🚨 BLOCKED: could not read tool event (fail-closed)\n');
    process.exit(2);
  }

  const toolName = input.tool_name ?? '';
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') return;
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return;

  const targets = extractScanTargets(toolName, toolInput as Record<string, unknown>);
  for (const target of targets) {
    if (isFileContained(target.filePath)) continue;
    const hit = findMatch(target.content);
    if (!hit) continue;
    process.stderr.write(
      `[ContainmentGuard] 🚨 BLOCKED: ${toolName} ${target.filePath} (${target.label}) would write '${hit}' outside Z1-Z4 containment. ` +
      `Route via env var, move the file under PAI/USER/, PAI/MEMORY/, skills/_*, or rewrite the content.\n`,
    );
    process.exit(2);
  }
}

// EN2: the sync→async conversion forces a NEW bottom-level catch (the pre-13.6 sync `main();` had none). This
// is itself a fail-CLOSED-gate decision. DECISION: preserve-availability (exit 0) on an unexpected INTERNAL
// exception — decided the SAME way as PromptGuard's E3 fatal-catch. An internal bug (in containment-zones /
// extractScanTargets) is NOT a failure to read the event; bricking every Edit/Write on an internal bug is
// worse than the leak this dormant gate guards. The stdin read above remains the intended fail-closed point.
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`[ContainmentGuard] Fatal — allowing (internal error, not an unread event): ${err}\n`);
    process.exit(0);
  });
}
