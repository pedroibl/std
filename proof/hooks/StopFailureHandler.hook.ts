#!/usr/bin/env bun
/**
 * StopFailureHandler.hook.ts - API Error Recovery (StopFailure)
 *
 * TRIGGER: StopFailure (fires when turn ends due to API error)
 * Added: v2.1.78
 *
 * Logs API failures (rate limits, auth errors, server errors) and sends
 * a voice notification so {{PRINCIPAL_NAME}} knows the session hit an error.
 *
 * Story 13.7: the JSONL append moves onto report.appendJsonlEvent. The stdin read keeps its sync
 * `readFileSync('/dev/stdin')` (dormant hook, no async benefit). The Pulse `/notify` fetch is DEFERRED
 * (deferred-work §13-7): it is ALREADY bounded by AbortSignal.timeout(3000) — not unbounded — so the
 * fetchWithTimeout swap would be a no-behavior-change churn; left as-is per the story.
 */

import { readFileSync } from 'fs';
import { appendJsonlEvent } from 'std/report';
import { paiPath } from './lib/paths';
import { getISOTimestamp, getPSTDate, getYearMonth } from './lib/time';
import { getVoiceId } from './lib/identity';

interface StopFailureInput {
  session_id?: string;
  hook_event_name?: string;
  error?: string;
}

async function main() {
  let input: StopFailureInput;
  try {
    input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));
  } catch {
    // fail-OPEN (AD-9.4 Rule 2): no / malformed stdin → exit 0, non-blocking.
    process.exit(0);
  }

  const timestamp = getISOTimestamp();
  const [year, month] = getYearMonth().split('-');
  const logDir = paiPath('MEMORY', 'SECURITY', year, month);

  const logEntry = {
    timestamp,
    session_id: input.session_id || 'unknown',
    event_type: 'stop_failure',
    hook_event: input.hook_event_name || 'StopFailure',
    error_details: input.error || 'unknown API error'
  };

  // Log the failure. appendJsonlEvent creates logDir + appends JSON+'\n' (best-effort, never throws).
  appendJsonlEvent(logDir, `stop-failures-${getPSTDate()}.jsonl`, logEntry);

  // Voice notification for API errors. DEFERRED swap (already timeout-bounded at 3000ms — §13-7).
  try {
    await fetch('http://localhost:31337/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'API error ended the turn. Check the session.',
        voice_id: getVoiceId(),
        voice_enabled: true
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Silent — voice server may be down
  }

  process.exit(0);
}

main();
