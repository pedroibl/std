// Story 9.2 — the text/string kit: slug, clip, whitespace-collapse, regex/HTML escaping, tag
// normalization, and a content hash. The pure string shapers that were re-rolled in nearly every
// PAI/Tool (slugify alone had 6 copies; `truncate`/`collapse` are byte-identical in AnvilProgress
// and ForgeProgress). Pure (D1): zero node:*/fs/DOM/network, no process/document, no clock.
//
// These are pure transforms, NOT the Result union and NOT throwing. There is no "malformed" input —
// an empty or junk string in yields an empty/shaped string out (slugify("") → "", normalizeTags("")
// → []). Do not "harden" these into throws.

/**
 * Lowercase kebab slug: lowercase, drop everything but `[a-z0-9]`/space/hyphen, spaces → `-`,
 * collapse runs of `-`, trim leading/trailing `-`, then cap to `maxLen`. The trailing-`-` trim runs
 * AFTER the length cap, so a cut landing mid-separator never leaves a dangling `-`.
 *
 * ASCII-only by design: non-ASCII letters are DROPPED, not transliterated (`"São Paulo"` →
 * `"so-paulo"`, `"Tomé"` → `"tom"`). This is the faithful behavior of the six PAI/Tools copies this
 * collapses, kept so the Epic 11/12 call-site swaps are pure substitutions with no slug drift. A
 * Unicode-preserving or transliterating variant is a separate, clearly-named function to add when a
 * consumer actually needs accented/CJK slugs — not a change to this one.
 */
export function slugify(text: string, maxLen = 60): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  // Cap length, then re-trim a trailing '-' the cut may have exposed.
  return slug.slice(0, maxLen).replace(/-$/, "");
}

/**
 * Clamp `text` to at most `limit` characters, appending `...` when it overflows (the ellipsis counts
 * toward the limit). Character-boundary, ported verbatim from `AnvilProgress.ts:121` ≡
 * `ForgeProgress.ts:165` — the two byte-identical copies this primitive collapses. With `limit < 3`
 * the visible text is empty and only the (clamped) ellipsis remains.
 */
export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
}

/** Collapse every run of whitespace to a single space and trim the ends. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Escape the regex metacharacters in `text` so it can be embedded literally in a `RegExp`. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape `& < > " '` to their HTML entities. `&` is handled first by the single-pass replace. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** Strip one layer of matching surrounding single/double quotes; otherwise return as-is. */
function unquote(s: string): string {
  const q = s[0];
  if (s.length >= 2 && (q === '"' || q === "'") && s[s.length - 1] === q) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Normalize a tag input to a trimmed, lowercased `string[]` with empties dropped. Accepts the three
 * shapes seen across callers: an actual `string[]`, a comma string `"a, b"`, or a bracketed string
 * `"[a, b]"`; nullish/empty input yields `[]` (loose, unvalidated data degrades, never throws). This
 * is the tag normalizer only — it does no frontmatter parsing (see parseFrontmatter) and no
 * domain/quality logic (that stays in the caller, D4).
 */
export function normalizeTags(input: string[] | string | null | undefined): string[] {
  if (!input) return []; // nullish/empty from loose, unvalidated data → [] (AC #7: no throw)
  let parts: string[];
  if (Array.isArray(input)) {
    parts = input;
  } else {
    const trimmed = input.trim();
    const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
    parts = inner.split(",");
  }
  return parts.map((t) => unquote(t.trim()).trim().toLowerCase()).filter((t) => t.length > 0);
}

/**
 * Stable content hash for dedup: normalize (collapse whitespace, lowercase) and take the first
 * `sliceLen` characters, then djb2. Returns lowercase hex. The slice length is a parameter so no
 * caller's window (e.g. 400) is baked in. Same normalized text → same hash; whitespace and case do
 * not affect it.
 */
export function contentHash(text: string, sliceLen = 400): string {
  const norm = collapse(text).toLowerCase().slice(0, sliceLen);
  let h = 5381;
  for (let i = 0; i < norm.length; i++) h = (h * 33) ^ norm.charCodeAt(i);
  return (h >>> 0).toString(16);
}
