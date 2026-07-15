// PROOF-ONLY SHIM (Story 13.5, Option A) — NOT deployed.
// Reproduces the tab-constants export ISASync's frozen import consumes (the `AlgorithmTabPhase` type,
// via PHASE_TAB_CONFIG). The DEPLOYED ISASync imports the REAL `./lib/tab-constants` (a 13.7 frozen dep)
// by the identical relative string; this copy exists ONLY so `proof/hooks/**` typechecks in isolation.
// Mirrors the real signature shape (`type AlgorithmTabPhase = keyof typeof PHASE_TAB_CONFIG`).

export const PHASE_TAB_CONFIG: Record<string, { symbol: string; inactiveBg: string; label: string; gerund: string }> = {};
export type AlgorithmTabPhase = keyof typeof PHASE_TAB_CONFIG;
