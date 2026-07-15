#!/usr/bin/env bun
/**
 * SecurityPipeline.hook.ts — PreToolUse entry point
 *
 * Runs the inspector pipeline on every Bash, Write, Edit, and MultiEdit
 * tool call. Replaces the old SecurityValidator.hook.ts with a composable
 * inspector chain: Pattern → Egress → Rules.
 *
 * TRIGGER: PreToolUse (matcher: Bash, Write, Edit, MultiEdit)
 *
 * ── Story 13.6 rewrite (security cluster) — the SINGLE win is the stdin reader swap:
 *    - readFileSync('/dev/stdin')+trim+JSON.parse (:33-40) → std/stdio readStdinJson<HookInput>().
 * POSTURE (AD-9.4 Rule 2 — fail-CLOSED, HARDENED): this is the WIRED PreToolUse gate over
 *    Bash/Write/Edit/MultiEdit. If it cannot read the tool event it must DENY, not proceed. Pre-13.6 it
 *    fail-OPENED here (`if(!raw.trim()) return; catch { return; // fail open }`). `null → exit 2` is a
 *    deliberate, VISIBLE hardening. Cite src/stdio/read.ts:7-12. The 1000ms default timeout (Rule 2.1)
 *    keeps a slow harness under load from racing to a false deny.
 * PRESERVED: the fatal `main().catch(() => process.exit(0))` (validator EN3) — even for this wired
 *    can-block gate, an unexpected INTERNAL exception (a bug in an inspector/pipeline) stays fail-OPEN: the
 *    stdin read is the intended fail-closed point, and bricking EVERY tool call on an internal bug is worse.
 *    Deliberate preserve-availability decision, recorded in deferred-work §13-6.
 */

import { readStdinJson } from 'std/stdio';
import type { InspectionContext } from './security/types';
import { InspectorPipeline } from './security/pipeline';
import { createPatternInspector } from './security/inspectors/PatternInspector';
import { createEgressInspector } from './security/inspectors/EgressInspector';
import { createRulesInspector } from './security/inspectors/RulesInspector';

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown> | string;
}

const pipeline = new InspectorPipeline([
  createPatternInspector(),
  createEgressInspector(),
  createRulesInspector(),
]);

async function main(): Promise<void> {
  // POSTURE: null → exit 2 (deny). A wired PreToolUse gate that cannot read its event fails CLOSED.
  // Cite src/stdio/read.ts:7-12.
  const input = await readStdinJson<HookInput>();
  if (!input) {
    console.error('[PAI SECURITY] 🚨 BLOCKED: could not read tool event (fail-closed)');
    process.exit(2);
  }

  const ctx: InspectionContext = {
    sessionId: input.session_id,
    toolName: input.tool_name,
    toolInput: input.tool_input,
  };

  const result = await pipeline.run(ctx);

  switch (result.action) {
    case 'deny':
      console.error(`[PAI SECURITY] 🚨 BLOCKED: ${result.reason}`);
      process.exit(2);
      break;

    case 'require_approval':
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: result.permissionDecisionReason,
        },
      }));
      break;

    case 'alert':
      console.error(`[PAI SECURITY] ⚠️ ALERT: ${result.reason}`);
      break;

    case 'allow':
      break;
  }
}

if (import.meta.main) { main().catch(() => process.exit(0)); }
