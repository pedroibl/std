#!/usr/bin/env bun
/**
 * TeammateIdle.hook.ts - Teammate Idle Event Logger
 *
 * PURPOSE:
 * Logs when agent team members go idle for observability.
 * Does NOT block or redirect — pure logging.
 * Future: could implement reassignment logic for specific team patterns.
 *
 * TRIGGER: TeammateIdle (fires when an agent team member becomes idle)
 *
 * OUTPUTS:
 * - MEMORY/OBSERVABILITY/teammate-events.jsonl (structured event log)
 *
 * PERFORMANCE: <10ms (file append only, no inference)
 */

import { readStdinJson } from 'std/stdio';
import { appendJsonlEvent } from 'std/report';
import { paiPath } from './lib/paths';
import { getISOTimestamp } from './lib/time';

interface TeammateIdleInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  teammate_name: string;
  team_name: string;
}

const OBS_DIR = paiPath('MEMORY', 'OBSERVABILITY');

async function main() {
  // fail-OPEN (AD-9.4 Rule 2): null (empty/malformed/timeout stdin) → exit 0, never block agent teams.
  const input = await readStdinJson<TeammateIdleInput>(2000);
  if (input === null) process.exit(0);

  try {
    const event = {
      timestamp: getISOTimestamp(),
      event: 'teammate_idle',
      session_id: input.session_id,
      teammate_name: input.teammate_name,
      team_name: input.team_name,
    };

    // appendJsonlEvent creates OBS_DIR + appends JSON+'\n'; best-effort (never throws).
    appendJsonlEvent(OBS_DIR, 'teammate-events.jsonl', event);
  } catch {
    // Silently exit — never block agent teams
  }

  process.exit(0);
}

main();
