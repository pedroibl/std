// Story 9.5 — the similarity + scoring kit: a word tokenizer, token-set Jaccard, a positional char
// overlap, and the regex-rule scorer behind PAI/Tools' three structurally-identical classifiers
// (MigrateScan, WisdomDomainClassifier, LearningPatternSynthesis). Pure (D1): zero node:*/fs/DOM/network,
// no process/document, no clock.
//
// The whole point of scoreRules is D4: it ships ONLY the match→accumulate→rank→margin→confidence loop.
// The rule tables — the keyword regexes, the weights, the thresholds, the domain/target vocabulary —
// stay in the callers and are passed in. core bakes in no consumer vocabulary.
//
// Pure transforms, NOT the Result union and NOT throwing. A degenerate input yields 0 (the similarity
// helpers) or an empty-ranked, 0-confidence record (scoreRules) — never a throw, never Result. Do not
// "harden" these.

/**
 * Word tokens: lowercase, replace everything but `[a-z0-9\s-]` with a space, split on whitespace, and
 * drop tokens of length <= 1. The canonical word tokenizer (MemoryRetriever). `HarvestExecutor`'s
 * `tokenizeForOverlap` (a Set, len>=3, split on `[^a-z0-9]+`) is a caller-side variant, not a second
 * core export.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Token-set Jaccard similarity `|A ∩ B| / |A ∪ B|` over `tokenize(a)`/`tokenize(b)`, in `[0, 1]`.
 * Both-empty (union size 0) → `0`.
 *
 * Distinct from the origin's overlap coefficient (`HarvestExecutor.tokenOverlapScore` = `|A ∩ B| /
 * min(|A|, |B|)`): Jaccard divides by the union, so the numbers differ — the overlap coefficient is a
 * trivial caller derivation from the same token sets.
 */
export function jaccard(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  const union = new Set([...A, ...B]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const t of A) if (B.has(t)) intersection += 1;
  return intersection / union.size;
}

/**
 * Positional character-overlap ratio (verbatim port of `contentOverlap`, byte-identical in
 * SessionHarvester and ProjectsHarvester): compare the two strings index-by-index up to the shorter
 * length, return matching-positions / longer length. Empty input → `0`.
 *
 * This is a POSITIONAL ratio, not a char-multiset intersection — `"abc"` vs `"xbc"` scores 2/3 (only
 * positions 1,2 align), and a shared prefix on a longer string is penalized by `/ longer.length`. Its
 * callers depend on exactly this behavior; do not "improve" it into a set overlap.
 */
export function charOverlap(a: string, b: string): number {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (shorter.length === 0) return 0;
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] === longer[i]) matches++;
  }
  return matches / longer.length;
}

/** A scoring rule: a label, the regexes that vote for it, and an optional weight (default 1). */
export interface ScoreRule {
  label: string;
  patterns: RegExp[];
  weight?: number;
}

/** The scored, ranked outcome: labels by descending score, the winner, the margin, and a confidence. */
export interface ScoreResult {
  ranked: Array<{ label: string; score: number; matched: string[] }>;
  top: { label: string; score: number } | null;
  margin: number;
  confidence: number;
}

/**
 * Score `text` against a caller-supplied rule table. Per rule, `hits` = the number of `patterns` that
 * match `text` (boolean per pattern), and `hits * (weight ?? 1)` is added to that rule's `label`.
 * Multiple rules may share a `label` — their scores aggregate (e.g. primary/secondary keyword tiers
 * map to two same-label rules with different weights).
 *
 * Returns labels ranked by descending score, the `top` label, the `margin` to the runner-up, and a
 * `confidence` = `min(1, (margin + top.score * 0.3) / 10)` (the MigrateScan formula — the only origin
 * that emits margin→confidence). Nothing matches → `{ ranked: [], top: null, margin: 0, confidence: 0 }`.
 *
 * Identity stays in the caller (D4): the rule table, the weights, the confidence tuning, and any
 * post-filtering (thresholds, reason-trimming, path lookups) are the caller's — core ships only the loop.
 */
export function scoreRules(text: string, rules: ScoreRule[]): ScoreResult {
  const byLabel = new Map<string, { score: number; matched: string[] }>();

  for (const rule of rules) {
    let hits = 0;
    const matched: string[] = [];
    for (const p of rule.patterns) {
      if (text.match(p)) {
        hits += 1;
        matched.push(`matched /${p.source}/`);
      }
    }
    if (hits === 0) continue;
    const entry = byLabel.get(rule.label) ?? { score: 0, matched: [] };
    entry.score += hits * (rule.weight ?? 1);
    entry.matched.push(...matched);
    byLabel.set(rule.label, entry);
  }

  const ranked = [...byLabel.entries()]
    .map(([label, { score, matched }]) => ({ label, score, matched }))
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return { ranked: [], top: null, margin: 0, confidence: 0 };

  const top = ranked[0]!;
  const margin = top.score - (ranked[1]?.score ?? 0);
  const confidence = Math.min(1, (margin + top.score * 0.3) / 10);
  return { ranked, top: { label: top.label, score: top.score }, margin, confidence };
}
