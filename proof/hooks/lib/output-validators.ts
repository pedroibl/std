// PROOF-ONLY SHIM (Story 13.7, extended Story 13.8, Option A) — NOT deployed.
// output-validators.ts is the no-op 7th lib member (voice/tab title grammar — AD-4, pure identity, no std
// primitive; the live file is left untouched). This copy reproduces the exported signatures the rewritten
// hooks consume — SetQuestionTab (isValidQuestionTitle/getQuestionFallback), VoiceNotification
// (isValidVoiceCompletion/getVoiceFallback), and (Story 13.8) PromptProcessing (isValidWorkingTitle/
// getWorkingFallback/trimToValidTitle) — so `proof/hooks/**` typechecks + tests in isolation. The DEPLOYED
// hooks import the REAL `./lib/output-validators` by the identical relative string. isValidQuestionTitle +
// the working-title family (isValidTitleBase/isValidWorkingTitle/trimToValidTitle/getWorkingFallback) are
// copied VERBATIM (self-contained); isValidVoiceCompletion is a faithful-enough length/emptiness gate (the
// real one adds blocklists/garbage-pattern rejection — caller-local grammar the proof never asserts on).

export function isValidVoiceCompletion(text: string): boolean {
  return !!text && text.length >= 10;
}

export function getVoiceFallback(): string {
  return ''; // Intentionally empty — invalid voice completions should be skipped, not spoken
}

// ─── Tab Title Validation (Story 13.8 — verbatim from the real output-validators.ts) ───

const INCOMPLETE_ENDINGS = new Set([
  'the', 'a', 'an', 'to', 'for', 'with', 'of',
  'in', 'on', 'at', 'by', 'from', 'and', 'or', 'but',
]);

function isValidTitleBase(text: string): { valid: boolean; firstWord: string } {
  if (!text || text.length < 5) return { valid: false, firstWord: '' };
  if (!text.endsWith('.')) return { valid: false, firstWord: '' };

  const content = text.slice(0, -1).trim();
  const words = content.split(/\s+/);
  if (words.length < 2 || words.length > 4) return { valid: false, firstWord: '' };

  const firstWord = words[0].toLowerCase();

  if (/^(completed?|proces{1,2}e?d|processing|handled|handling|finished|finishing|worked|working|done|analyzed?) (the |on )?(task|request|work|it|input)$/i.test(content)) {
    return { valid: false, firstWord };
  }

  const lower = content.toLowerCase();
  if (/\bi\b/.test(lower) || /\bme\b/.test(lower) || /\bmy\b/.test(lower)) {
    return { valid: false, firstWord };
  }

  const lastWord = words[words.length - 1].toLowerCase().replace(/[^a-z]/g, '');
  if (INCOMPLETE_ENDINGS.has(lastWord)) return { valid: false, firstWord };

  if (lastWord.length <= 1) return { valid: false, firstWord };

  return { valid: true, firstWord };
}

export function isValidWorkingTitle(text: string): boolean {
  const { valid, firstWord } = isValidTitleBase(text);
  if (!valid) return false;
  return firstWord.endsWith('ing');
}

export function trimToValidTitle(
  words: string[],
  validator: (text: string) => boolean,
  maxWords: number = 4
): string | null {
  const limit = Math.min(words.length, maxWords);
  for (let n = limit; n >= 2; n--) {
    let candidate = words.slice(0, n).join(' ').replace(/[,;:!?\-—]+$/, '').trim();
    if (!candidate.endsWith('.')) candidate += '.';
    if (validator(candidate)) return candidate;
  }
  return null;
}

export function getWorkingFallback(): string {
  return 'Analyzing input.';
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
