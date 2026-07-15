#!/usr/bin/env bun
/**
 * CheckpointPerISC.hook.ts — auto git commit on every ISC `[ ]`->`[x]` transition
 *
 * TRIGGER: PostToolUse (Write, Edit) on ISA.md (or legacy PRD.md) under
 * MEMORY/WORK/<slug>/. DORMANT / not-wired — fired for proof via an exact-contract stdin pipe.
 *
 * For each newly-checked ISC, iterates through the allowlist of opted-in repos
 * (~/.claude/checkpoint-repos.txt per spec) and creates one git commit per
 * repo that has uncommitted changes. Commit subject:
 *   "<ISC-id> (<slug>): <sanitized description>"
 *
 * Idempotent via sidecar state file: MEMORY/WORK/<slug>/.checkpoint-state.json.
 * Allowlist is empty by default; repos must be opted in explicitly by {{PRINCIPAL_NAME}}.
 *
 * Fails closed: any error path logs to stderr and emits `{continue:true}` with
 * exit 0 — never crashes the session, never commits without an allowlist,
 * never executes any destructive git op (no reset/revert/checkout/branch -D/
 * clean -fd/push --force).
 *
 * ── Story 13.5 rewrite (consumer sweep onto the std substrate; AD-9.4) ──────────────────────────────
 * PRIMITIVE SWAPS:
 *   P1    JSON.parse(readFileSync(0)) stdin (:135) + top-level try/catch → std/stdio readStdinJson
 *   git   read-only isGitRepo/hasChanges — std/git `git(repo,args)` (FAIL-SOFT reconstruction, see below)
 *   fsx   loadState/saveState JSON sidecar → fsx.loadJson / fsx.atomicWrite; existsSync → fsx.exists;
 *         allowlist read → fsx.readIfExists
 * POSTURE (AD-9.4 Rule 2) — fail-OPEN, PRESERVED. readStdinJson null → the visible `return` branch falls
 *   through to the `.finally` → emitContinueAndExit() (`{continue:true}` + exit 0). The old top-level
 *   `catch → process.exit(0)` becomes this null branch.
 * ⚠ git FAIL-SOFT RECONSTRUCTION (the key subtlety, validator carve-out): std/git returns "" on ANY
 *   failure (never throws), whereas the old `gitRun` threw and callers try/catch'd. So the READ-ONLY probes
 *   re-derive success from OUTPUT LENGTH, not a caught exception (same reconstruction 12.5 did):
 *     isGitRepo  = git(repo,['rev-parse','--git-dir']).length > 0
 *     hasChanges = git(repo,['status','--porcelain']).length > 0
 *   BUT `commitInRepo` is CARVED OUT onto a LOCAL THROWING runner (validator E1 — silent-bug hazard): under
 *   fail-soft, a FAILED `git commit --quiet` (empty stdout on success) would be indistinguishable from
 *   success, and the subsequent `git rev-parse HEAD` would return the PRE-EXISTING sha → a stale non-null
 *   sha → the ISC wrongly recorded as committed (idempotent → never retried). The throwing execFileSync
 *   catches a failed commit via its exception; fail-soft cannot. So commitInRepo stays on execFileSync.
 * CALLER-LOCAL identity (D4): ALLOWLIST_PATH, GIT_TIMEOUT_MS, the commit-subject format, `expandPath`
 *   (DEFERred — a 2-site candidate), and `sanitizeMessage` (validators E2+ENH-3 — KEEP verbatim, NOT
 *   core.collapse/truncate: it strips backticks/`$` and trims LAST, then a hard slice; core reorders trim).
 */

import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { parseFrontmatter, parseCriteriaList, ARTIFACT_FILENAME, LEGACY_ARTIFACT_FILENAME } from './lib/isa-utils';
import { readStdinJson } from 'std/stdio';
import { atomicWrite, exists, loadJson, readIfExists } from 'std/fsx';
import { git } from 'std/git';

// Allowlist path: top of ~/.claude per spec. We only READ this file (never
// write to it), so ContainmentGuard's write restriction on bare ~/.claude
// doesn't apply. One absolute repo path per line; '#' comments and blank
// lines are ignored. Tilde and $HOME prefixes are expanded as a quality-of-
// life feature so users can write `~/Projects/foo` instead of the long form.
const ALLOWLIST_PATH = join(homedir(), '.claude', 'checkpoint-repos.txt');
const GIT_TIMEOUT_MS = 5000;

interface HookInput {
  tool_input?: { file_path?: string };
}

interface CheckpointState {
  committed_iscs: string[];
  last_commit_sha: Record<string, string>;
}

/** A `git -C <repo> <args>` runner returning stdout. The read-only probes take one as an injectable seam
 *  (default: the fail-soft std/git `git`) so tests can drive the isGitRepo/hasChanges truth table with a
 *  fake, no real repo needed. */
export type GitRunner = (repo: string, args: string[]) => string;

// DEFER (AC10): a 2-site candidate (also lib/paths.ts:19-26); promote to fsx at a 3rd caller. Keep local.
export function expandPath(p: string): string {
  let s = p.trim();
  if (!s) return s;
  if (s.startsWith('~/')) s = join(homedir(), s.slice(2));
  else if (s === '~') s = homedir();
  s = s.replace(/^\$HOME(\/|$)/, homedir() + '$1');
  return s;
}

export function loadAllowlist(): string[] {
  try {
    // fsx.readIfExists: missing file → null → [] (matches the old existsSync guard); a real read error on
    // an existing file re-throws and is caught below → [] (matches the old readFileSync try/catch).
    const raw = readIfExists(ALLOWLIST_PATH);
    if (raw === null) return [];
    return raw
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#'))
      .map(expandPath);
  } catch (err) {
    console.error('[CheckpointPerISC] failed to read allowlist:', err);
    return [];
  }
}

export function loadState(stateFile: string): CheckpointState {
  // fsx.loadJson softens missing-file + unparseable-JSON to the fallback (was: existsSync guard +
  // try/catch reset). Behavioral delta: a malformed state file now resets SILENTLY (loadJson swallows the
  // parse error) where the old body logged "malformed state file, resetting" — recorded in deferred-work.
  // The Array.isArray / typeof-object shape guards are RE-APPLIED (loadJson returns the raw parsed value).
  const parsed = loadJson<any>(stateFile, { committed_iscs: [], last_commit_sha: {} });
  return {
    committed_iscs: Array.isArray(parsed.committed_iscs) ? parsed.committed_iscs : [],
    last_commit_sha: parsed.last_commit_sha && typeof parsed.last_commit_sha === 'object' ? parsed.last_commit_sha : {},
  };
}

export function saveState(stateFile: string, state: CheckpointState): void {
  try {
    // fsx.atomicWrite (tmp-sibling + rename) — torn-write-proof; same final bytes as the old writeFileSync.
    atomicWrite(stateFile, JSON.stringify(state, null, 2) + '\n');
  } catch (err) {
    console.error('[CheckpointPerISC] failed to write state:', err);
  }
}

// READ-ONLY probes on std/git (fail-soft): success re-derived from output length, never a thrown exception.
// `run` defaults to the real fail-soft std/git; tests inject a fake to drive the truth table hermetically.
export function isGitRepo(repo: string, run: GitRunner = git): boolean {
  return run(repo, ['rev-parse', '--git-dir']).length > 0;
}

export function hasChanges(repo: string, run: GitRunner = git): boolean {
  return run(repo, ['status', '--porcelain']).length > 0;
}

export function sanitizeMessage(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/[`$]/g, '').trim().slice(0, 200);
}

// CARVE-OUT (validator E1): commitInRepo stays on the THROWING execFileSync so a failed commit surfaces as
// an exception (→ null) instead of a fail-soft "" that would let a stale rev-parse HEAD masquerade as a
// fresh commit. Preserves GIT_TIMEOUT_MS + the commit-subject format (both caller-local).
export function gitCommitRun(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// `run` defaults to the THROWING gitCommitRun (the carve-out); tests inject a fake (throwing or succeeding)
// to prove the stale-sha hazard is avoided — a thrown commit → null, never a pre-existing HEAD sha.
export function commitInRepo(repo: string, iscId: string, slug: string, description: string, run: GitRunner = gitCommitRun): string | null {
  try {
    run(repo, ['add', '-A']);
    // iscId already has the canonical "ISC-<N>" form (or "ISC-<N>-A-<M>" for
    // anti-criteria) per parseCriteriaList — use it verbatim, do not re-prefix.
    const subject = `${iscId} (${slug}): ${sanitizeMessage(description)}`;
    // --no-verify skips husky/pre-commit hooks; --no-gpg-sign avoids GPG
    // passphrase prompts that would hang the session blocking on stdin.
    run(repo, ['commit', '-m', subject, '--quiet', '--no-verify', '--no-gpg-sign']);
    const sha = run(repo, ['rev-parse', 'HEAD']).trim();
    return sha;
  } catch (err: unknown) {
    const e = err as { stderr?: { toString?: () => string }; message?: string };
    const detail = e?.stderr?.toString?.() || e?.message || String(err);
    console.error(`[CheckpointPerISC] commit failed in ${repo} for ${iscId}: ${detail}`);
    return null;
  }
}

function emitContinueAndExit(): never {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}

async function main(input: HookInput) {
  const filePath: string = input?.tool_input?.file_path || '';
  if (!filePath.includes('MEMORY/WORK/')) return;
  const isISA = filePath.endsWith('/' + ARTIFACT_FILENAME) || filePath.endsWith(ARTIFACT_FILENAME);
  const isLegacyPRD = filePath.endsWith('/' + LEGACY_ARTIFACT_FILENAME) || filePath.endsWith(LEGACY_ARTIFACT_FILENAME);
  if (!isISA && !isLegacyPRD) return;
  if (!exists(filePath)) return;

  const slugDir = dirname(filePath);
  const slug = basename(slugDir);
  const stateFile = join(slugDir, '.checkpoint-state.json');

  const content = readIfExists(filePath);
  if (content === null) return; // vanished between the exists probe and the read
  const fm = parseFrontmatter(content);
  if (!fm) return;
  const criteria = parseCriteriaList(content);
  if (criteria.length === 0) return;

  const state = loadState(stateFile);
  const alreadyCommitted = new Set(state.committed_iscs);
  const newlyChecked = criteria.filter(c => c.status === 'completed' && !alreadyCommitted.has(c.id));
  if (newlyChecked.length === 0) return;

  const allowlist = loadAllowlist();
  if (allowlist.length === 0) {
    console.error('[CheckpointPerISC] no repos configured, skipping');
    return;
  }

  for (const isc of newlyChecked) {
    for (const repo of allowlist) {
      if (!exists(repo)) {
        console.error(`[CheckpointPerISC] repo not found: ${repo}`);
        continue;
      }
      if (!isGitRepo(repo)) {
        console.error(`[CheckpointPerISC] not a git repo: ${repo}`);
        continue;
      }
      if (!hasChanges(repo)) continue;
      const sha = commitInRepo(repo, isc.id, slug, isc.description);
      if (sha) state.last_commit_sha[repo] = sha;
    }
    state.committed_iscs.push(isc.id);
  }

  saveState(stateFile, state);
}

if (import.meta.main) {
  // P1: read + parse stdin, posture-neutral. Fail-OPEN (AD-9.4 Rule 2): null → the visible `return` below
  // falls through to `.finally` → emitContinueAndExit(). Replaces the old top-level
  // JSON.parse(readFileSync(0)) → process.exit(0).
  readStdinJson<HookInput>()
    .then(input => {
      if (input === null) return; // fail-OPEN: .finally emits {continue:true} + exit 0
      return main(input);
    })
    .catch(err => {
      console.error('[CheckpointPerISC] uncaught error:', err);
    })
    .finally(() => {
      emitContinueAndExit();
    });
}
