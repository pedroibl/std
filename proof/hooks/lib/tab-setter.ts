// PROOF-ONLY SHIM (Story 13.5, Option A) — NOT deployed.
// Reproduces the tab-setter export ISASync's frozen import consumes (`setPhaseTab`). The DEPLOYED ISASync
// imports the REAL `./lib/tab-setter` (a 13.7 frozen dep — kitty tab colouring) by the identical relative
// string; this copy exists ONLY for the proof. The fire-tests never exercise a real phase transition, so a
// no-op faithfully stands in for the tab side-effect.
import type { AlgorithmTabPhase } from './tab-constants';

/** Set the terminal tab colour for an Algorithm phase transition. Real impl drives kitty; proof no-op. */
export function setPhaseTab(_phase: AlgorithmTabPhase, _sessionId: string, _summary?: string): void {
  // no-op in the proof
}
