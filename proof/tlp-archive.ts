#!/usr/bin/env bun
/**
 * tlp-archive — proof/ rewrite of `~/.claude/PAI/TOOLS/TlpArchive.ts` (Story 12.5, HTTP cluster part B)
 * onto the std substrate. Scrapes The Last Psychiatrist blog and saves each post as a Knowledge entry.
 *
 * `fetchHtml` (source :45-59) → `std/http.fetchWithTimeout({ timeout: 25_000, headers, redirect })`.
 * The manual `AbortController` + `setTimeout(abort)` + `clearTimeout` in a `finally` (source :46-47,57)
 * is DELETED — `fetchWithTimeout` owns that envelope. It wants HTML text, not JSON, so `httpJson` (which
 * asserts `ok` + parses JSON) does not fit; `fetchHtml` here calls `fetchWithTimeout` for the raw
 * `Response`, asserts `res.ok` itself (same `HTTP ${status}` message as the source), then reads
 * `.text()` off it — matching `fetchWithTimeout`'s documented "caller reads the body" contract.
 *
 * DURABILITY UPGRADE (real behavior change, called out per story instructions): every `writeFileSync`
 * (source :349 URL list, :367 per-post entry, :420-421 success/failed lists, :556 archive index) →
 * `fsx.atomicWrite` (tmp-sibling + rename). A crash mid-write on the source tool could leave a
 * half-written Knowledge `.md` file that the Knowledge graph reads before the writer finishes — a
 * corrupted entry. `atomicWrite` makes that impossible: a reader always sees either the complete old
 * file or the complete new one, never a torn partial. `mkdirSync` (source :375) → `fsx.ensureDir`
 * (idempotent, no exists-check race). The 4 reads (source :438-443 index title/date scrape, :532 URL
 * list, :546 failed-list retry, :554 URL list for index) → `fsx.readIfExists` (absent-tolerant, matches
 * the source's existing `existsSync` guards).
 *
 * `TODAY` (source :24, `new Date().toISOString().slice(0, 10)`) → `isoDate(now)` with `now` INJECTED at
 * the CLI edge (`new Date()` passed once into `main`), not read ambient inside the tested core — the
 * hermeticity `isoDate` exists for. `TODAY` is date-only (`YYYY-MM-DD` frontmatter fields), so this is
 * `isoDate`, not the still-deferred `isoDateTime` 2-consumer primitive (not built here, per scope).
 *
 * CLI (`list`/`probe`/`one`/`all`/`retry`/`index`) → `positional()` for subcommand/URL extraction. Every
 * command here is async (network + fs I/O). The original 12.5 rewrite noted `core/args.dispatch` required
 * SYNCHRONOUS handlers (`Record<string, () => number>`) — the SUBSTRATE FINDING shared with `inference.ts`
 * / `youtube-api.ts` that `args.ts`'s own doc comment deferred "until a real consumer needs it." Epic 17
 * promoted the async sibling `core.dispatchAsync`; `main()` now routes through it, replacing the former
 * `if/else` chain. `onUnknown` returns exit 2 (usage) unchanged — this file is one of `dispatchAsync`'s
 * two proof-of-adoption consumers (with `inference.ts`).
 *
 * STAYS caller-local (D4): `htmlToMd` + every HTML-parsing helper (domain vocabulary, not a plumbing
 * primitive), the Knowledge entry schema (`buildEntry`/`buildArchiveIndex`), the blog's domain URL, the
 * UA string, the `/tmp` state file paths, the tags/author/source constants, `{{PRINCIPAL_NAME}}`. The
 * blog base URL and the state-file paths are overridable via env vars / injected paths so tests never
 * touch the real network or the real `/tmp`.
 *
 * Usage:
 *   bun tlp-archive.ts list             # write <state>/tlp-urls.txt (~700 URLs)
 *   bun tlp-archive.ts probe <url>      # fetch one URL, print parsed result
 *   bun tlp-archive.ts one <url>        # fetch one URL, write a Knowledge entry
 *   bun tlp-archive.ts all              # fetch all URLs from <state>/tlp-urls.txt
 *   bun tlp-archive.ts retry            # retry URLs in <state>/tlp-failed.txt
 *   bun tlp-archive.ts index            # write tlp-archive-index.md
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { dispatchAsync, isoDate, positional } from "std/core";
import { atomicWrite, ensureDir, readIfExists, resolveFrameworkDir } from "std/fsx";
import { fetchWithTimeout } from "std/http";

// ─── Caller-local config (D4) — every path/URL is overridable so tests never hit the real network or /tmp ───

export interface TlpConfig {
  knowledgeDir: string;
  urlFile: string;
  failedFile: string;
  successFile: string;
  archiveUrl: string;
  blogBaseUrl: string;
}

export function defaultConfig(): TlpConfig {
  const HOME = process.env.HOME ?? homedir();
  const blogBaseUrl = process.env.TLP_BASE_URL ?? "https://thelastpsychiatrist.com";
  const stateDir = process.env.TLP_STATE_DIR ?? "/tmp";
  return {
    knowledgeDir: process.env.TLP_KNOWLEDGE_DIR ?? join(resolveFrameworkDir(HOME), "MEMORY/KNOWLEDGE/Blogs"),
    urlFile: join(stateDir, "tlp-urls.txt"),
    failedFile: join(stateDir, "tlp-failed.txt"),
    successFile: join(stateDir, "tlp-success.txt"),
    archiveUrl: process.env.TLP_ARCHIVE_URL ?? `${blogBaseUrl}/archives.html`,
    blogBaseUrl,
  };
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const CONCURRENCY = 8;
const TIMEOUT_MS = 25_000;

type Post = {
  url: string;
  year: string;
  month: string;
  urlSlug: string;
  title: string;
  postDate: string;
  bodyHtml: string;
  bodyMd: string;
  fileSlug: string;
};

// ---------------------- Fetch (source :45-59 → std/http.fetchWithTimeout) ----------------------

export async function fetchHtml(url: string): Promise<string> {
  const res = await fetchWithTimeout(url, {
    timeout: TIMEOUT_MS,
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// ---------------------- HTML helpers (source :63-182, unchanged — caller-local domain logic) ----------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&rsquo;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&rdquo;/g, "”")
    .replace(/&ldquo;/g, "“")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Extract innerHTML of a div with given class or id, tracking nested div depth. */
function extractDivByMarker(html: string, openTag: string): string | null {
  const idx = html.indexOf(openTag);
  if (idx === -1) return null;
  const start = idx + openTag.length;
  let depth = 1;
  let i = start;
  const re = /<\/?div\b/gi;
  re.lastIndex = start;
  while (true) {
    const m = re.exec(html);
    if (!m) return null;
    if (m[0].toLowerCase().startsWith("</div")) {
      depth--;
      if (depth === 0) {
        return html.slice(start, m.index);
      }
    } else {
      depth++;
    }
    i = re.lastIndex;
    if (i > html.length) return null;
  }
}

// ---------------------- HTML → Markdown (source :108-182, unchanged) ----------------------

function htmlToMd(html: string): string {
  let s = html;
  // Strip scripts, styles, iframes, forms entirely
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  s = s.replace(/<form[\s\S]*?<\/form>/gi, "");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  // Headings
  s = s.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n");
  s = s.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n");
  s = s.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n");
  s = s.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, "\n\n#### $1\n\n");
  s = s.replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, "\n\n##### $1\n\n");
  s = s.replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, "\n\n###### $1\n\n");

  // Inline emphasis
  s = s.replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**");
  s = s.replace(/<b\b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**");
  s = s.replace(/<em\b[^>]*>([\s\S]*?)<\/em>/gi, "*$1*");
  s = s.replace(/<i\b[^>]*>([\s\S]*?)<\/i>/gi, "*$1*");
  s = s.replace(/<u\b[^>]*>([\s\S]*?)<\/u>/gi, "$1");

  // Links
  s = s.replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => {
    const cleaned = txt.replace(/<[^>]+>/g, "").trim();
    if (!cleaned) return "";
    return `[${cleaned}](${href})`;
  });

  // Images
  s = s.replace(
    /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*?(?:\balt=["']([^"']*)["'])?[^>]*\/?>/gi,
    (_, src, alt) => `![${alt || ""}](${src})`,
  );

  // Blockquotes
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    const cleaned = htmlToMd(inner).trim();
    return "\n\n" + cleaned.split("\n").map((l) => "> " + l).join("\n") + "\n\n";
  });

  // Lists
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");
  s = s.replace(/<\/?(ul|ol)\b[^>]*>/gi, "\n\n");

  // Paragraphs and breaks
  s = s.replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<p\b[^>]*>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");

  // Drop remaining divs/spans
  s = s.replace(/<\/?(div|span|section|article|figure|figcaption|center|font|small|big)\b[^>]*>/gi, "");

  // Strip unknown tags
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "");

  // Decode entities
  s = decodeEntities(s);

  // Whitespace cleanup
  s = s.replace(/ /g, " ");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();
  return s;
}

// ---------------------- YAML quoting (source :186-204, unchanged) ----------------------

function yamlQuote(s: string): string {
  // Convert ASCII quotes to typographic — eliminates need for YAML escaping
  // and renders nicer in any UI that displays the raw title.
  let t = s.trim();
  // Open/close detection: a quote preceded by start-of-string, whitespace,
  // or an opening bracket is "open"; everything else is "close".
  t = t.replace(/(^|[\s(\[{])"/g, "$1“"); // " → “
  t = t.replace(/"/g, "”"); // " → ”
  t = t.replace(/(^|[\s(\[{])'/g, "$1‘"); // ' → ‘
  t = t.replace(/'/g, "’"); // ' → ’
  // Plain YAML scalar is safe unless leading char is reserved or content
  // contains ": " (colon-space) or " #" (space-hash).
  const leading = /^[!&*?|>%@`“‘"' \-]/;
  if (!leading.test(t) && !t.includes(": ") && !t.includes(" #")) {
    return t;
  }
  // Fall back to double-quoted; no straight " can occur after typographic conversion.
  return '"' + t + '"';
}

// ---------------------- Date parsing (source :206-233, unchanged) ----------------------

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

function parsePostDate(raw: string, fallback: { year: string; month: string }): string {
  const m = raw.match(/(\w+)\s+(\d{1,2}),\s+(\d{4})/);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon) {
      const day = m[2].padStart(2, "0");
      return `${m[3]}-${mon}-${day}`;
    }
  }
  return `${fallback.year}-${fallback.month.padStart(2, "0")}-01`;
}

// ---------------------- Parser (source :237-276, unchanged) ----------------------

export function parsePost(html: string, url: string): Post {
  const urlMatch = url.match(/\/(\d{4})\/(\d{2})\/([^/]+)\.html$/);
  if (!urlMatch) throw new Error(`Bad URL: ${url}`);
  const [, year, month, urlSlug] = urlMatch;

  // Title — <title> tag is most reliable (h1 banner can collide with site header)
  let title = "";
  const t = html.match(/<title>([\s\S]+?)<\/title>/i);
  if (t) {
    title = t[1].replace(/^[\s\S]*?The Last Psychiatrist:\s*/i, "").trim();
  }
  if (!title) {
    // Fallback: find h1 INSIDE <div id="content">
    const contentMatch = html.match(/<div id="content"[^>]*>([\s\S]*?)<div class="entry-body"/i);
    if (contentMatch) {
      const h1 = contentMatch[1].match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1) title = h1[1].replace(/<[^>]+>/g, "").trim();
    }
  }
  title = decodeEntities(title);
  if (!title) title = urlSlug.replace(/_/g, " ");

  // Date
  const dateMatch = html.match(/<div class="dated">([\s\S]*?)<\/div>/i);
  const dateRaw = dateMatch ? dateMatch[1].trim() : "";
  const postDate = parsePostDate(dateRaw, { year, month });

  // Body — concat entry-body + entry-more
  const bodyParts: string[] = [];
  const eb = extractDivByMarker(html, '<div class="entry-body">');
  if (eb) bodyParts.push(eb);
  const em = extractDivByMarker(html, '<div id="more" class="entry-more">');
  if (em) bodyParts.push(em);
  const bodyHtml = bodyParts.join("\n\n");
  const bodyMd = htmlToMd(bodyHtml);

  const fileSlug = `tlp-${year}-${month}-${urlSlug.replace(/_/g, "-")}`.replace(/-+/g, "-");

  return { url, year, month, urlSlug, title, postDate, bodyHtml, bodyMd, fileSlug };
}

// ---------------------- Frontmatter writer (source :280-330, unchanged; `today` now injected) ----------------------

function buildEntry(post: Post, prevSlug: string | null, today: string): string {
  const tags = ["blogs", "the-last-psychiatrist", "psychiatry", "culture-criticism"];
  const related: { slug: string; type: string }[] = [{ slug: "tlp-archive-index", type: "part-of" }];
  if (prevSlug) {
    related.push({ slug: prevSlug, type: "preceded-by" });
  } else {
    related.push({ slug: "real-internet-of-things-retrospective", type: "related" });
  }

  const fm = [
    "---",
    `title: ${yamlQuote(post.title)}`,
    "type: blog",
    `tags: [${tags.join(", ")}]`,
    `created: ${today}`,
    `updated: ${today}`,
    "quality: 7",
    `author: "Alone (The Last Psychiatrist)"`,
    `source: "The Last Psychiatrist"`,
    `source_url: ${post.url}`,
    `post_date: ${post.postDate}`,
    `source_blog: ${post.fileSlug}`,
    "related:",
    ...related.map((r) => `  - slug: ${r.slug}\n    type: ${r.type}`),
    "---",
    "",
    `# ${post.title}`,
    "",
    `*Published ${post.postDate} on [thelastpsychiatrist.com](${post.url}) by "Alone."*`,
    "",
    "## Thesis",
    "",
    `Original essay archived from The Last Psychiatrist blog. Full text below.`,
    "",
    "## Evidence",
    "",
    post.bodyMd || "_(body could not be extracted)_",
    "",
    "## Implications",
    "",
    "- Archived as part of the [[tlp-archive-index|TLP archive]] for durable retrieval.",
    "",
    "## Sources",
    "",
    `- ${post.url}`,
    "",
  ].join("\n");
  return fm;
}

// ---------------------- URL list (source :334-351 → fsx.atomicWrite) ----------------------

async function buildUrlList(cfg: TlpConfig): Promise<string[]> {
  const html = await fetchHtml(cfg.archiveUrl);
  const escapedBase = cfg.blogBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`href="(${escapedBase})?(/\\d{4}/\\d{2}/[a-z0-9_-]+\\.html)"`, "gi");
  const seen = new Set<string>();
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const url = `${cfg.blogBaseUrl}${m[2]}`;
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  // Sort chronologically by URL date
  urls.sort();
  atomicWrite(cfg.urlFile, urls.join("\n") + "\n");
  return urls;
}

// ---------------------- Bulk run (source :355-423) ----------------------

async function processOne(
  cfg: TlpConfig,
  url: string,
  prevSlug: string | null,
  today: string,
): Promise<{ ok: boolean; slug?: string; error?: string }> {
  try {
    const html = await fetchHtml(url);
    const post = parsePost(html, url);
    if (!post.bodyMd || post.bodyMd.length < 50) {
      throw new Error(`Body too short: ${post.bodyMd.length}`);
    }
    const out = buildEntry(post, prevSlug, today);
    const path = join(cfg.knowledgeDir, `${post.fileSlug}.md`);
    atomicWrite(path, out);
    return { ok: true, slug: post.fileSlug };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runBulk(
  cfg: TlpConfig,
  urls: string[],
  today: string,
): Promise<{ success: string[]; failed: string[] }> {
  ensureDir(cfg.knowledgeDir);
  const success: string[] = [];
  const failed: string[] = [];

  // Process sequentially in chunks of CONCURRENCY for ordering of prev-slug
  // — but per-batch, prev-slug is stable from start of batch.
  // For simplicity, do truly concurrent; prev-slug derived from URL date order.
  // URLs are sorted chronologically, so each URL's "prev" = the URL above it in the sorted list.
  const slugForUrl = (u: string) => {
    const m = u.match(/\/(\d{4})\/(\d{2})\/([^/]+)\.html$/);
    if (!m) return null;
    return `tlp-${m[1]}-${m[2]}-${m[3].replace(/_/g, "-")}`.replace(/-+/g, "-");
  };

  let idx = 0;
  let done = 0;
  const total = urls.length;
  const startedAt = Date.now();

  async function worker() {
    while (true) {
      const my = idx++;
      if (my >= urls.length) return;
      const url = urls[my];
      const prev = my > 0 ? slugForUrl(urls[my - 1]) : null;
      const r = await processOne(cfg, url, prev, today);
      done++;
      if (r.ok) {
        success.push(url);
        if (done % 25 === 0 || done === total) {
          const pct = Math.round((done / total) * 100);
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
          console.log(`[${done}/${total}] ${pct}%  elapsed ${elapsed}s`);
        }
      } else {
        failed.push(`${url}\t${r.error}`);
        console.error(`FAIL ${url} :: ${r.error}`);
      }
      // gentle politeness jitter
      await new Promise((res) => setTimeout(res, 80 + Math.random() * 120));
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  atomicWrite(cfg.successFile, success.join("\n") + "\n");
  atomicWrite(cfg.failedFile, failed.join("\n") + (failed.length ? "\n" : ""));
  return { success, failed };
}

// ---------------------- Index (source :427-507 → fsx.readIfExists/atomicWrite; `today` injected) ----------------------

function buildArchiveIndex(cfg: TlpConfig, urls: string[], today: string): string {
  // group by year
  const byYear: Record<string, { date: string; slug: string; title: string; url: string }[]> = {};
  for (const url of urls) {
    const m = url.match(/\/(\d{4})\/(\d{2})\/([^/]+)\.html$/);
    if (!m) continue;
    const [, year, month, urlSlug] = m;
    const slug = `tlp-${year}-${month}-${urlSlug.replace(/_/g, "-")}`.replace(/-+/g, "-");
    const path = join(cfg.knowledgeDir, `${slug}.md`);
    let title = urlSlug.replace(/_/g, " ");
    let date = `${year}-${month}-01`;
    const txt = readIfExists(path);
    if (txt !== null) {
      const tm = txt.match(/^title:\s*(?:"([^"]+)"|([^\n]+))/m);
      if (tm) title = (tm[1] || tm[2] || "").trim();
      const dm = txt.match(/^post_date:\s*(\d{4}-\d{2}-\d{2})/m);
      if (dm) date = dm[1];
    }
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push({ date, slug, title, url });
  }
  const years = Object.keys(byYear).sort().reverse();

  const lines: string[] = [];
  lines.push("---");
  lines.push('title: "The Last Psychiatrist — Archive Index"');
  lines.push("type: blog");
  lines.push("tags: [blogs, the-last-psychiatrist, archive, index]");
  lines.push(`created: ${today}`);
  lines.push(`updated: ${today}`);
  lines.push("quality: 9");
  lines.push('author: "Alone (The Last Psychiatrist)"');
  lines.push('source: "The Last Psychiatrist"');
  lines.push(`source_url: ${cfg.archiveUrl}`);
  lines.push("related:");
  lines.push("  - slug: real-internet-of-things-retrospective");
  lines.push("    type: related");
  lines.push("  - slug: blog-redteam-adversarial-content-quality");
  lines.push("    type: related");
  lines.push("---");
  lines.push("");
  lines.push("# The Last Psychiatrist — Archive Index");
  lines.push("");
  lines.push(
    "Index of every post archived from [thelastpsychiatrist.com](https://thelastpsychiatrist.com) — pseudonymous blog by \"Alone\", active 2005–2014. Cultural criticism through a psychiatric lens. Each entry links to the full archived essay stored as a Knowledge note tagged `blogs`.",
  );
  lines.push("");
  lines.push("## Thesis");
  lines.push("");
  lines.push(
    "TLP's body of work is one of the most influential cultural-criticism corpora of the late-Web-2.0 era — themes of narcissism, advertising, the disavowal of agency, and the medicalization of identity that became central to {{PRINCIPAL_NAME}}'s own framing. Preserving the full archive locally insulates the corpus against link-rot and makes every essay browsable inside Pulse.",
  );
  lines.push("");
  lines.push("## Evidence");
  lines.push("");
  lines.push(`- ${urls.length} posts archived spanning ${years[years.length - 1]}–${years[0]}.`);
  lines.push("- Each post stored as `Ideas/tlp-YYYY-MM-slug.md` with full body in markdown.");
  lines.push("- Tagged `blogs` + `the-last-psychiatrist` + `psychiatry` + `culture-criticism`.");
  lines.push("- Chained chronologically via `preceded-by` cross-links.");
  lines.push("");
  lines.push("## Implications");
  lines.push("");
  lines.push("- Personal corpus survives if the original site goes dark.");
  lines.push("- Searchable via the standard Knowledge graph + Pulse Knowledge surface.");
  lines.push("- Tag-filterable: `tags:blogs` returns the entire TLP archive.");
  lines.push("");
  for (const y of years) {
    const posts = byYear[y].sort((a, b) => b.date.localeCompare(a.date));
    lines.push(`## ${y} (${posts.length} posts)`);
    lines.push("");
    for (const p of posts) {
      lines.push(`- ${p.date} — [[${p.slug}|${p.title}]] · [original](${p.url})`);
    }
    lines.push("");
  }
  lines.push("## Sources");
  lines.push("");
  lines.push(`- ${cfg.archiveUrl}`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------- CLI (source :511-567) ----------------------

export async function main(
  argv: string[] = process.argv.slice(2),
  cfg: TlpConfig = defaultConfig(),
  now: Date = new Date(),
): Promise<number> {
  const today = isoDate(now);
  const cmd = positional(argv);

  // Subcommand routing → `core.dispatchAsync` (the async sibling promoted in Epic 17). Each handler is
  // async (network + fs), returns its own exit code, and closes over `cfg`/`today`/`argv`; behavior +
  // console output are byte-identical to the former `if/else` chain, including the exit-2 usage on an
  // unknown command via `onUnknown`.
  const handlers: Record<string, () => Promise<number>> = {
    list: async () => {
      const urls = await buildUrlList(cfg);
      console.log(`Wrote ${urls.length} URLs to ${cfg.urlFile}`);
      return 0;
    },
    probe: async () => {
      const url = positional(argv.slice(1));
      if (!url) throw new Error("probe requires URL arg");
      const html = await fetchHtml(url);
      const post = parsePost(html, url);
      console.log(
        JSON.stringify(
          { ...post, bodyHtml: post.bodyHtml.slice(0, 200) + "...", bodyMd: post.bodyMd.slice(0, 400) + "..." },
          null,
          2,
        ),
      );
      return 0;
    },
    one: async () => {
      const url = positional(argv.slice(1));
      if (!url) throw new Error("one requires URL arg");
      const r = await processOne(cfg, url, null, today);
      console.log(JSON.stringify(r, null, 2));
      return 0;
    },
    all: async () => {
      let urls: string[];
      const existing = readIfExists(cfg.urlFile);
      if (existing === null) {
        console.log("Building URL list first…");
        urls = await buildUrlList(cfg);
      } else {
        urls = existing.split("\n").filter(Boolean);
      }
      console.log(`Processing ${urls.length} URLs at concurrency ${CONCURRENCY}…`);
      const r = await runBulk(cfg, urls, today);
      console.log(`\n=== DONE ===`);
      console.log(`Success: ${r.success.length}`);
      console.log(`Failed:  ${r.failed.length}`);
      if (r.failed.length) {
        console.log(`\nFailed list at ${cfg.failedFile}`);
      }
      return 0;
    },
    retry: async () => {
      const failedContent = readIfExists(cfg.failedFile);
      if (failedContent === null) {
        console.log("No failed file");
        return 0;
      }
      const lines = failedContent.split("\n").filter(Boolean);
      const urls = lines.map((l) => l.split("\t")[0]).filter(Boolean);
      console.log(`Retrying ${urls.length} URLs…`);
      const r = await runBulk(cfg, urls, today);
      console.log(`\n=== RETRY DONE ===`);
      console.log(`Success: ${r.success.length}`);
      console.log(`Failed:  ${r.failed.length}`);
      return 0;
    },
    index: async () => {
      const urlContent = readIfExists(cfg.urlFile) ?? "";
      const urls = urlContent.split("\n").filter(Boolean);
      const out = buildArchiveIndex(cfg, urls, today);
      atomicWrite(join(cfg.knowledgeDir, "tlp-archive-index.md"), out);
      console.log(`Wrote tlp-archive-index.md (${out.length} chars)`);
      return 0;
    },
  };

  return dispatchAsync(cmd, handlers, () => {
    console.log("Usage: bun tlp-archive.ts {list|probe URL|one URL|all|retry|index}");
    return 2;
  });
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
