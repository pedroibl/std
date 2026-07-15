#!/usr/bin/env bun
/**
 * TaskGovernance.hook.ts - Subagent Task Creation Governance (TaskCreated)
 *
 * PURPOSE:
 * Validates and logs task creation by subagents. Prevents runaway task spawning
 * and provides audit trail of all agent-created tasks.
 *
 * TRIGGER: TaskCreated
 *
 * INPUT:
 * - task_id: Created task identifier
 * - task_subject: Short task subject line
 * - task_description: Full task description
 * - teammate_name: Name of the agent creating the task
 * - team_name: Team context
 *
 * OUTPUT:
 * - exit(0): Allow task creation (with optional logging)
 * - exit(2): Block task creation (stderr fed back to model)
 *
 * GOVERNANCE RULES:
 * 1. Log all task creation for audit trail
 * 2. Rate limit: max 20 tasks per session to prevent runaway spawning
 * 3. Block tasks with empty descriptions (quality gate)
 *
 * ── Story 13.6 rewrite (security cluster) — two wins + a guard:
 *    - stdin: the BARE unguarded `JSON.parse(readFileSync('/dev/stdin'))` (:32) → std/stdio
 *      readStdinJson<HookInput>(), wrapped in an async main() with a VISIBLE null branch.
 *    - audit log: mkdirSync + appendFileSync(JSON.stringify+'\n') (:84-94) → std/report appendJsonlEvent
 *      (drop-in; it mkdirs the dir and appends record+'\n' itself). ⚠ validator N3: pass the OBJECT, NOT a
 *      pre-`JSON.stringify`'d string — appendJsonlEvent stringifies `record` itself (double-encode otherwise).
 *      Adds best-effort size-rotation TaskGovernance lacked (benign — disclosed in deferred-work §13-6).
 * POSTURE (AD-9.4 Rule 2 — fail-CLOSED, HARDENED + add-guard): pre-13.6 had NO stdin guard → an unreadable
 *    event threw uncaught → exit 1. exit 1 is NON-blocking (only exit 2 blocks TaskCreated), so the task was
 *    created anyway = fail-OPEN. `null → exit 2` (deny) HARDENS it, like the wired gates. Cite src/stdio/read.ts:7-12.
 * The /tmp rate-limit track file (readFileSync/writeFileSync) stays caller-local — out of scope of the
 *    report/fsx swaps the story scoped for this hook.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { readStdinJson } from "std/stdio";
import { appendJsonlEvent } from "std/report";
import { getPaiDir } from './lib/paths';

interface HookInput {
  task_id?: string;
  task_subject?: string;
  task_description?: string;
  teammate_name?: string;
  team_name?: string;
}

async function main(): Promise<void> {
  // POSTURE: null → exit 2 (deny). A TaskCreated governance gate that cannot read its event fails CLOSED.
  // Cite src/stdio/read.ts:7-12.
  const input = await readStdinJson<HookInput>();
  if (!input) {
    process.stderr.write('Task creation blocked: could not read task event (fail-closed).');
    process.exit(2);
  }

  const { task_id, task_subject, task_description, teammate_name, team_name } = input;

  // --- Quality gate: block empty descriptions ---
  if (!task_description || task_description.trim().length < 10) {
    process.stderr.write(
      `Task creation blocked: description too short (${task_description?.length ?? 0} chars). Provide a meaningful task description of at least 10 characters.`
    );
    process.exit(2);
  }

  // --- Rate limit: track tasks per session via temp file ---
  // CLAUDE_SESSION_ID doesn't exist in env, so we use ppid (Claude Code process)
  // and reset the counter when the session (ppid) changes.
  const trackFile = join("/tmp", "pai-task-governance.json");
  let taskCount = 0;
  const currentPpid = String(process.ppid);

  try {
    const data = JSON.parse(readFileSync(trackFile, "utf-8"));
    if (data.ppid === currentPpid) {
      taskCount = data.count || 0;
    }
    // Different ppid = new session, counter resets to 0
  } catch {
    // File doesn't exist or is corrupt — first task this session
  }

  const MAX_TASKS_PER_SESSION = 50;
  if (taskCount >= MAX_TASKS_PER_SESSION) {
    process.stderr.write(
      `Task creation blocked: session limit of ${MAX_TASKS_PER_SESSION} tasks reached. This prevents runaway task spawning. Complete existing tasks before creating new ones.`
    );
    process.exit(2);
  }

  // Increment counter with session tracking
  writeFileSync(trackFile, JSON.stringify({ ppid: currentPpid, count: taskCount + 1 }));

  // --- Audit log ---
  const logDir = join(getPaiDir(), "MEMORY/SECURITY");
  const now = new Date();
  const yearMonth = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`;
  const logPath = join(logDir, yearMonth);

  try {
    // N3: pass the OBJECT — appendJsonlEvent(dir, file, record) stringifies `record` + '\n' itself.
    appendJsonlEvent(logPath, "task-governance.jsonl", {
      ts: now.toISOString(),
      event: "task_created",
      task_id,
      subject: task_subject,
      teammate: teammate_name,
      team: team_name,
      description_length: task_description?.length ?? 0,
    });
  } catch {
    // Non-fatal: logging failure shouldn't block task creation
  }

  // Allow task creation
  process.exit(0);
}

// Fatal catch: preserve-availability (exit 0) on an unexpected internal exception — consistent with the
// other gates' fatal-catches (EN3) and PromptGuard's E3. The stdin read above is the fail-closed point.
if (import.meta.main) { main().catch(() => process.exit(0)); }
