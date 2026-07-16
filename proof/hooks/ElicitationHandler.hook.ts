#!/usr/bin/env bun
/**
 * ElicitationHandler.hook.ts - MCP Elicitation Auto-Respond (Elicitation)
 *
 * TRIGGER: Elicitation (fires when MCP server requests structured input)
 * Added: v2.1.76
 *
 * When MCP servers (Stripe, Bright Data, etc.) request user input mid-task,
 * this hook logs the request. For known safe patterns, it can auto-respond.
 * For unknown patterns, it passes through to show the interactive dialog.
 *
 * Story 13.7 (AC8): main() stays SYNCHRONOUS. The stdin read keeps its sync
 * `readFileSync('/dev/stdin')` deliberately — adopting the async readStdinJson would
 * force this whole hook async for no benefit on a dormant hook. Only the JSONL append
 * moves onto report.appendJsonlEvent (which stays synchronous).
 */

import { readFileSync } from 'fs';
import { appendJsonlEvent } from 'std/report';
import { paiPath } from './lib/paths';
import { getISOTimestamp, getPSTDate, getYearMonth } from './lib/time';

interface ElicitationInput {
  mcp_server_name?: string;
  elicitation_schema?: Record<string, unknown>;
  elicitation_message?: string;
}

function main() {
  let input: ElicitationInput;
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
    event_type: 'elicitation_request',
    server: input.mcp_server_name || 'unknown',
    schema: input.elicitation_schema || null,
    message: input.elicitation_message || null
  };

  // Log all elicitation requests for audit. appendJsonlEvent creates logDir + appends JSON+'\n'
  // (best-effort, never throws — replaces the mkdir + appendFileSync-in-try/catch idiom).
  appendJsonlEvent(logDir, `elicitation-${getPSTDate()}.jsonl`, logEntry);

  // Pass through to interactive dialog (don't auto-respond by default).
  // To auto-respond for specific MCP servers, add patterns here:
  //
  // if (input.mcp_server_name === 'stripe' && input.elicitation_schema?.type === 'confirmation') {
  //   console.log(JSON.stringify({
  //     hookSpecificOutput: {
  //       hookEventName: 'Elicitation',
  //       elicitationResponse: { confirmed: true }
  //     }
  //   }));
  // }

  process.exit(0);
}

main();
