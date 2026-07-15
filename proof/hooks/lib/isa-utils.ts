// PROOF-ONLY SHIM (Story 13.3, Option A) — NOT deployed.
// Reproduces the isa-utils exports the 13.3 rewrites consume (ToolActivityTracker's `bumpLastToolActivity`
// KV-staleness bump). Frozen module (AD-9.4 Rule 3 / AC7) — isa-utils.ts is untouched this story (its own
// collapse is a later cluster). The DEPLOYED hook imports the REAL `./lib/isa-utils` by the identical
// string; this copy exists ONLY for the proof. Named the same as the existing proof/isa-utils.ts pattern.

/** Bump the registry's last-tool-activity timestamp for a session. Real impl writes the ISA registry;
 *  the proof never exercises the happy path (fire-tests use null-inducing stdin → exit 0 before this). */
export function bumpLastToolActivity(_sessionUUID: string): boolean {
  return false;
}

// ── Registry + work-state surface (added Story 13.3 for observability-transport.ts) ──
// Faithful signatures of the isa-utils exports observability-transport consumes: the session registry
// read/write pair (for cleanStaleSessions) and the work.json path constant. Real impl reads/writes the
// ISA registry JSON; these stubs keep proof/hooks/** typechecking + let the pure fns be unit-tested with
// injected registries (cleanStaleSessions in the deployed lib uses the REAL pair by the identical string).
import { paiPath } from './paths';

export const WORK_JSON = paiPath('MEMORY', 'STATE', 'work.json');

/** Read the session registry. Real impl loads the registry JSON; proof stub returns an empty registry. */
export function readRegistry(): { sessions: Record<string, any> } {
  return { sessions: {} };
}

/** Persist the session registry. Real impl writes the registry JSON; proof stub is a no-op. */
export function writeRegistry(_reg: { sessions: Record<string, any> }): void {
  // no-op in the proof — cleanStaleSessions is exercised via the injectable pure fn, not this write
}

// ── ISA artifact + rating-pulse surface (added Story 13.4 for WCL + SatisfactionCapture) ──
// Faithful signatures of the isa-utils exports the memory cluster consumes: findArtifactPath (WCL locates
// the session's ISA.md) and addRatingPulse (SatCap records a rating on the ISA registry). Frozen module —
// isa-utils.ts's own collapse is Story 13.5; the 13.4 hooks keep importing these two by identical string.

/** Locate a session's Ideal-State-Artifact path (ISA.md / legacy PRD.md) by slug, or null when absent.
 *  Real impl walks MEMORY/WORK/<slug>; proof stub returns null (fire-tests hit no-state exit-0 first). */
export function findArtifactPath(_slug: string): string | null {
  return null;
}

export interface RatingPulse {
  value: number; // 1-10
  timestamp: number; // epoch ms
  message?: string; // the short message that triggered it (optional, max 32 chars)
}

/** Record a rating pulse on the session's ISA registry. Real impl mutates the registry; proof no-op. */
export function addRatingPulse(_sessionUUID: string, _pulse: RatingPulse): void {
  // no-op in the proof — SatisfactionCapture's happy path is not exercised by the null-stdin fire test
}
