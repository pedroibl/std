#!/usr/bin/env bun
/**
 * SmartApprover.hook.ts — PermissionRequest entry point
 *
 * Replaces TrustedWorkspaceApprover with a smarter permission model:
 * 1. Trusted workspace paths → auto-approve (fast path, no LLM)
 * 2. Non-trusted paths → classify read vs write via haiku
 * 3. Read operations → auto-approve
 * 4. Write operations → let user decide
 *
 * TRIGGER: PermissionRequest (matcher: Write|Edit|MultiEdit|Bash)
 *
 * ── Story 13.6 rewrite (security cluster) — two wins:
 *    - stdin: readFileSync('/dev/stdin')+trim+JSON.parse (:112-127) → std/stdio readStdinJson().
 *    - cache: existsSync/readFileSync/JSON.parse + writeFileSync (:40-58) → std/fsx loadJson + atomicWrite.
 * POSTURE (AD-9.4 Rule 2 — PRESERVED defer-to-user, NOT hardened): SmartApprover is a PermissionRequest
 *    hook where emitting NO output = the user is prompted to decide (the safe default). So `null → return`
 *    (no output) — deliberately NOT `exit 2` and NOT allow. Cite src/stdio/read.ts:7-12. This dormant gate
 *    must not harden: a null event that silently denied would break legitimate permission prompts.
 * PRESERVED: the fatal `main().catch(() => process.exit(0))` (validator EN3) — exit 0 with no output on an
 *    internal exception is itself "defer to user".
 */

import { resolve } from 'path';
import { homedir } from 'os';
import { readStdinJson } from 'std/stdio';
import { loadJson, atomicWrite } from 'std/fsx';
import { paiPath } from './lib/paths';

const HOME = homedir();

const TRUSTED_PREFIXES = [
  resolve(HOME, '.claude') + '/',
  resolve(HOME, 'Projects') + '/',
  resolve(HOME, 'LocalProjects') + '/',
  resolve(HOME, 'Downloads') + '/',
  '/tmp/',
  '/private/tmp/',
  '/var/folders/',
];

// ── Permission Cache ──

interface PermissionCache {
  [toolKey: string]: 'allow' | 'ask';
}

const CACHE_PATH = paiPath('USER', 'SECURITY', 'permission-cache.yaml');
let memoryCache: PermissionCache = {};

function loadCache(): PermissionCache {
  if (Object.keys(memoryCache).length > 0) return memoryCache;
  try {
    // fsx.loadJson softens ENOENT + unparseable → {}; the try/catch preserves the original's "ANY read
    // failure (incl. a genuine fs fault) → empty cache" non-fatal semantics.
    memoryCache = loadJson<PermissionCache>(CACHE_PATH, {});
  } catch {
    memoryCache = {};
  }
  return memoryCache;
}

function saveCache(): void {
  try {
    atomicWrite(CACHE_PATH, JSON.stringify(memoryCache, null, 2));
  } catch {
    // Cache write failure is non-fatal
  }
}

// ── Path Classification ──

function isTrustedPath(filePath: string): boolean {
  const expanded = filePath.startsWith('~')
    ? filePath.replace('~', HOME)
    : filePath;
  const normalized = resolve(expanded);
  return TRUSTED_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

function bashTargetsTrustedPath(command: string): boolean {
  const patterns = [
    '~/.claude/', `${HOME}/.claude/`,
    '~/Projects/', `${HOME}/Projects/`,
    '~/LocalProjects/', `${HOME}/LocalProjects/`,
    '$HOME/.claude/', '${HOME}/.claude/',
    '$HOME/Projects/', '${HOME}/Projects/',
  ];
  return patterns.some(p => command.includes(p));
}

// ── Read/Write Classification ──

async function classifyReadWrite(toolName: string, toolInput: Record<string, unknown>): Promise<'read' | 'write'> {
  // Static classification for known tools
  if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') return 'read';
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') return 'write';

  // For Bash, check command heuristically
  if (toolName === 'Bash') {
    const command = (toolInput?.command as string) || '';
    const readOnlyPatterns = [
      /^(ls|cat|head|tail|wc|file|stat|du|df|which|type|echo|printf)\b/,
      /^(git\s+(status|log|diff|show|branch|tag|remote|rev-parse))\b/,
      /^(rg|grep|fd|find|bat|eza|tree|jq|yq)\b/,
      /^(bun\s+run\s+(test|check|lint|type-check|build))\b/,
      /^(node|bun|deno)\s+.*\s+--version/,
      /^(curl|wget)\s+-s\s/,
      /^date\b/,
      /^pwd\b/,
    ];
    if (readOnlyPatterns.some(p => p.test(command))) return 'read';
    return 'write'; // Default bash to write (conservative)
  }

  return 'write'; // Default to write (conservative)
}

// ── Main ──

async function main(): Promise<void> {
  // POSTURE: null → return (defer-to-user). No output = the harness prompts the user. Cite src/stdio/read.ts:7-12.
  const input = await readStdinJson<{ tool_name?: string; tool_input?: Record<string, unknown> }>();
  if (!input) { return; }

  const toolName = input.tool_name ?? '';
  const toolInput = input.tool_input ?? {};
  const filePath = toolInput.file_path as string | undefined;
  const command = toolInput.command as string | undefined;

  // MCP tools matched by PermissionRequest matcher are pre-vetted
  const isMcpTool = toolName.startsWith('mcp__');

  // Fast path: trusted workspace
  const trusted = isMcpTool
    ? true
    : filePath
      ? isTrustedPath(filePath)
      : command
        ? bashTargetsTrustedPath(command)
        : false;

  if (trusted) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    }));
    return;
  }

  // Non-trusted: classify read vs write
  const cacheKey = `${toolName}:${(filePath || command || '').slice(0, 100)}`;
  const cache = loadCache();

  if (cache[cacheKey]) {
    if (cache[cacheKey] === 'allow') {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      }));
    }
    // 'ask' → return without output, letting user decide
    return;
  }

  const classification = await classifyReadWrite(toolName, toolInput);

  if (classification === 'read') {
    memoryCache[cacheKey] = 'allow';
    saveCache();
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    }));
  }
  // Write operations: don't cache, let user decide each time
}

if (import.meta.main) { main().catch(() => process.exit(0)); }
