// PROOF-ONLY SHIM (Story 13.5, expanded Story 13.7) — NOT deployed.
// tab-constants is PURE IDENTITY (kitty tab colours/symbols/phase gerunds — AD-4, no std primitive; the
// live file is left untouched by 13.7). This copy reproduces the FULL export surface the 13.7 tab-setter
// delamination + handlers/TabState consume (TAB_COLORS/ACTIVE_*/INACTIVE_TAB_FG/TabState in addition to
// PHASE_TAB_CONFIG/AlgorithmTabPhase). The DEPLOYED hooks import the REAL `./lib/tab-constants` by the
// identical relative string; this copy exists ONLY so `proof/hooks/**` typechecks + tests in isolation.
// Values mirror the live file so the derived `keyof typeof` types are exact.

export const TAB_COLORS = {
  thinking:  { inactiveBg: '#1E0A3C', label: 'purple' },
  working:   { inactiveBg: '#804000', label: 'orange' },
  question:  { inactiveBg: '#0D4F4F', label: 'teal' },
  completed: { inactiveBg: '#022800', label: 'green' },
  error:     { inactiveBg: '#804000', label: 'orange' },
  idle:      { inactiveBg: 'none',    label: 'default' },
} as const;

export const ACTIVE_TAB_BG = '#002B80';
export const ACTIVE_TAB_FG = '#FFFFFF';
export const INACTIVE_TAB_FG = '#A0A0A0';

export type TabState = keyof typeof TAB_COLORS;

export const PHASE_TAB_CONFIG: Record<string, { symbol: string; inactiveBg: string; label: string; gerund: string }> = {
  OBSERVE:  { symbol: '👁️', inactiveBg: '#0C2D48', label: 'observe',  gerund: 'Observing.' },
  THINK:    { symbol: '🧠', inactiveBg: '#2D1B69', label: 'think',    gerund: 'Thinking.' },
  PLAN:     { symbol: '📋', inactiveBg: '#1E1B4B', label: 'plan',     gerund: 'Planning.' },
  BUILD:    { symbol: '🔨', inactiveBg: '#78350F', label: 'build',    gerund: 'Building.' },
  EXECUTE:  { symbol: '⚡', inactiveBg: '#713F12', label: 'execute',  gerund: 'Executing.' },
  VERIFY:   { symbol: '✅', inactiveBg: '#14532D', label: 'verify',   gerund: 'Verifying.' },
  LEARN:    { symbol: '📚', inactiveBg: '#134E4A', label: 'learn',    gerund: 'Learning.' },
  COMPLETE: { symbol: '✅', inactiveBg: '#022800', label: 'complete', gerund: 'Complete.' },
  IDLE:     { symbol: '',   inactiveBg: 'none',    label: 'idle',     gerund: '' },
};

export type AlgorithmTabPhase = keyof typeof PHASE_TAB_CONFIG;
