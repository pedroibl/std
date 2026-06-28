// Shared gate machinery — the import/export specifier scanner the Epic-1 gates build on.
//
// Rule-of-Three home (D2): `check-core-purity.ts` (1.2) and `check-dep-root.ts` (1.3) each
// re-declared these regexes + `stripComments`/`lineOf`; `check-single-source.ts` (1.4) is the
// THIRD caller, so the duplication is extracted here once. The `DYNAMIC_IMPORT` regex, previously
// declared in BOTH gates, collapses to a single definition.
//
// This is TOOLING (scripts/, not src/) — it may use Bun/node APIs freely; only `src/core/**` is
// held to D1 purity. The scanner itself is pure string→data and unit-tested beside this file.

/** `import … from "x"` / `import x, {y} from "x"`. */
export const FROM_IMPORT = /\bimport\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
/** Side-effect import: `import "x"`. */
export const SIDE_EFFECT_IMPORT = /\bimport\s+["']([^"']+)["']/g;
/** CommonJS `require("x")`. */
export const REQUIRE_CALL = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
/** Dynamic `import("x")` / `await import("x")` — a real runtime/module edge, scanned alongside the static forms. */
export const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
/** Re-export barrels: `export { x } from "x"`, `export * from "x"`, `export type { x } from "x"`. */
export const EXPORT_FROM = /\bexport\b[^;]*?\bfrom\s*["']([^"']+)["']/g;

/**
 * Blank out the *content* of block + line comments while preserving newlines (and column offsets),
 * so `lineOf` keeps reporting the original line of every later finding. Strings are left intact —
 * use `stripStringsAndComments` when string-context awareness is required.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function isWs(c: string): boolean {
  return c === " " || c === "\t" || c === "\r" || c === "\n";
}

function isIdent(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

/** The word ending at index `end` in the buffer (contiguous identifier chars), or "". */
function wordEndingAt(buf: string[], end: number): string {
  let j = end;
  let w = "";
  while (j >= 0 && isIdent(buf[j]!)) {
    w = buf[j] + w;
    j--;
  }
  return w;
}

/**
 * Is the just-opened quote (whose preceding chars are already in `buf`) a *module-specifier* string —
 * i.e. the operand of `from "…"`, `import("…")`, or `require("…")`? Only specifier strings keep their
 * content; every other string is masked. (Comments + prior strings in `buf` are already spaces, so a
 * `from` inside a comment can't be mistaken for the keyword.)
 */
function isSpecifierQuote(buf: string[]): boolean {
  let j = buf.length - 1;
  while (j >= 0 && isWs(buf[j]!)) j--;
  if (j < 0) return false;
  if (buf[j] === "(") {
    j--;
    while (j >= 0 && isWs(buf[j]!)) j--;
    const word = wordEndingAt(buf, j);
    return word === "import" || word === "require";
  }
  // `from "…"` (import/export-from) or a bare side-effect `import "…"`.
  const word = wordEndingAt(buf, j);
  return word === "from" || word === "import";
}

// Keywords after which a `/` opens a regex literal, not division (`return /re/`, `typeof /re/`, …).
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "case", "yield", "await", "in", "of", "do", "else", "void", "delete",
  "instanceof", "new", "throw",
]);

/**
 * Does a `/` at this point open a regex literal (vs being division)? A `)`/`]`/`}` or a plain
 * identifier/number before it means division; an operator/punctuation (or start-of-input) means
 * regex. The one trap: a keyword-led regex (`return /['"]/`) — the char before `/` is an identifier
 * char, so we read the whole preceding word and treat the known regex-preceding keywords as regex.
 */
function regexStarts(buf: string[]): boolean {
  let j = buf.length - 1;
  while (j >= 0 && isWs(buf[j]!)) j--;
  if (j < 0) return true;
  const c = buf[j]!;
  if (c === ")" || c === "]" || c === "}") return false;
  if (/[A-Za-z0-9_$]/.test(c)) return REGEX_PRECEDING_KEYWORDS.has(wordEndingAt(buf, j));
  return true;
}

/**
 * String-aware sibling of `stripComments`: a single left-to-right pass that masks the interior of
 * comments, string literals, template literals, AND regex literals to spaces (newlines preserved),
 * EXCEPT it keeps the content of genuine module-specifier strings (`from "…"`, `import("…")`,
 * `require("…")`) so the specifier regexes still capture real edges.
 *
 * This closes the tracked string-context-naive limitation: a `from '…'` sitting *inside* an outer
 * string (e.g. `const q = "select x from 'loom'"`) is masked away and never read as a module edge,
 * while a real `import x from "loom"` is untouched — its quote opens in code context.
 */
export function stripStringsAndComments(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;

  const pushMasked = (c: string) => out.push(c === "\n" ? "\n" : " ");

  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];

    // Line comment — blank to end of line.
    if (c === "/" && next === "/") {
      out.push(" ", " ");
      i += 2;
      while (i < n && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }

    // Block comment — blank interior, preserve newlines.
    if (c === "/" && next === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        pushMasked(src[i]!);
        i++;
      }
      if (i < n) {
        out.push(" ", " ");
        i += 2;
      }
      continue;
    }

    // Regex literal — mask interior; `/` inside a `[...]` class does not close it.
    if (c === "/" && regexStarts(out)) {
      out.push("/");
      i++;
      let inClass = false;
      while (i < n) {
        const d = src[i]!;
        if (d === "\n") break; // unterminated on this line — bail (regex can't span lines)
        if (d === "\\") {
          out.push(" ", " ");
          i += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          out.push("/");
          i++;
          break;
        }
        out.push(" ");
        i++;
      }
      continue;
    }

    // String / template literal.
    if (c === '"' || c === "'" || c === "`") {
      const keep = c !== "`" && isSpecifierQuote(out);
      out.push(c);
      i++;
      while (i < n) {
        const d = src[i]!;
        if (d === "\\") {
          if (keep) out.push(d, src[i + 1] ?? "");
          else {
            out.push(" ");
            if (i + 1 < n) pushMasked(src[i + 1]!);
          }
          i += 2;
          continue;
        }
        if (d === c) {
          out.push(c);
          i++;
          break;
        }
        if (keep) out.push(d);
        else pushMasked(d);
        i++;
      }
      continue;
    }

    out.push(c);
    i++;
  }

  return out.join("");
}

export function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Every import/require/export-from specifier in already-cleaned source text. */
export function specifiers(clean: string): Array<{ spec: string; index: number }> {
  const out: Array<{ spec: string; index: number }> = [];
  for (const re of [FROM_IMPORT, SIDE_EFFECT_IMPORT, REQUIRE_CALL, EXPORT_FROM, DYNAMIC_IMPORT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) out.push({ spec: m[1]!, index: m.index });
  }
  return out;
}
