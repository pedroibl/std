// PROOF-ONLY SHIM (Story 13.7, Option A) — NOT deployed.
// output-validators.ts is the no-op 7th lib member (voice/tab title grammar — AD-4, pure identity, no std
// primitive; the live file is left untouched by 13.7). This copy reproduces the exported signatures the
// rewritten hooks consume — SetQuestionTab (isValidQuestionTitle/getQuestionFallback) and VoiceNotification
// (isValidVoiceCompletion/getVoiceFallback) — so `proof/hooks/**` typechecks + tests in isolation. The
// DEPLOYED hooks import the REAL `./lib/output-validators` by the identical relative string. isValidQuestionTitle
// is copied verbatim (self-contained); isValidVoiceCompletion is a faithful-enough length/emptiness gate (the
// real one adds blocklists/garbage-pattern rejection — caller-local grammar the proof never asserts on).

export function isValidVoiceCompletion(text: string): boolean {
  return !!text && text.length >= 10;
}

export function getVoiceFallback(): string {
  return ''; // Intentionally empty — invalid voice completions should be skipped, not spoken
}

export function isValidQuestionTitle(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  if (text.endsWith('.')) return false;
  if (text.length > 30) return false;
  const words = text.trim().split(/\s+/);
  if (words.length < 1 || words.length > 4) return false;
  if (/<[^>]*>/.test(text)) return false;
  return true;
}

export function getQuestionFallback(): string {
  return 'Awaiting input';
}
