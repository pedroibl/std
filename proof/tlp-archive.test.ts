import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig, fetchHtml, main, parsePost, type TlpConfig } from "./tlp-archive";

// Hermetic mock of thelastpsychiatrist.com on an ephemeral port (`port: 0`) — no real network. Every
// path/URL the tool touches (`blogBaseUrl`, `archiveUrl`, `urlFile`, `failedFile`, `successFile`,
// `knowledgeDir`) is a `TlpConfig` field, never a baked constant, so tests point entirely at this
// server + a fresh mkdtemp tree instead of the real site / real `/tmp` / real `~/.claude`.
let server: ReturnType<typeof Bun.serve>;
let base: string;

const POST_HTML = (title: string, dated: string, body: string, withMore = false) => `<!doctype html>
<html><head><title>The Last Psychiatrist: ${title}</title></head>
<body>
<div id="content">
<h1>${title}</h1>
<div class="dated">${dated}</div>
<div class="entry-body">
<p>${body}</p>
</div>
${withMore ? `<div id="more" class="entry-more"><p>More content appended after the fold, also long enough.</p></div>` : ""}
</div>
</body></html>`;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      switch (pathname) {
        case "/archives.html":
          // One relative link, one link with the full base-URL prefix — exercises both branches of
          // the source's optional-prefix regex (source :336, now parametrized off cfg.blogBaseUrl).
          return new Response(
            `<html><body>
              <a href="/2019/01/first_post.html">First</a>
              <a href="${base}/2019/02/second_post.html">Second</a>
            </body></html>`,
            { headers: { "content-type": "text/html" } },
          );
        case "/2019/01/first_post.html":
          return new Response(
            // Title contains ": " on purpose — it forces yamlQuote's fallback double-quoted form
            // (source :198-199), which round-trips through buildArchiveIndex's `title: "..."` regex
            // (source :440). A plain unquoted title would NOT match that regex, same as the source.
            POST_HTML(
              "First Post: A Title",
              "January 15, 2019",
              "This is the body of the first archived post, long enough to clear the 50-char gate easily.",
            ),
            { headers: { "content-type": "text/html" } },
          );
        case "/2019/02/second_post.html":
          return new Response(
            POST_HTML(
              "Second Post Title",
              "February 3, 2019",
              "This is the body of the second archived post, also long enough to clear the gate.",
              true,
            ),
            { headers: { "content-type": "text/html" } },
          );
        case "/2019/03/short_post.html":
          // Body under 50 chars post-strip — exercises the "Body too short" failure path in `one`/`all`.
          return new Response(POST_HTML("Short Post", "March 1, 2019", "Too short."), {
            headers: { "content-type": "text/html" },
          });
        case "/missing.html":
          return new Response("not found", { status: 404 });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function makeCfg(): TlpConfig {
  const root = mkdtempSync(join(tmpdir(), "tlp-archive-test-"));
  return {
    knowledgeDir: join(root, "Knowledge"),
    urlFile: join(root, "tlp-urls.txt"),
    failedFile: join(root, "tlp-failed.txt"),
    successFile: join(root, "tlp-success.txt"),
    archiveUrl: `${base}/archives.html`,
    blogBaseUrl: base,
  };
}

let cfg: TlpConfig;
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

let tmpRoot: string;

beforeEach(() => {
  cfg = makeCfg();
  tmpRoot = cfg.urlFile.slice(0, cfg.urlFile.lastIndexOf("/"));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("fetchHtml — std/http fetchWithTimeout, caller reads .text() (source :45-59)", () => {
  test("fetches HTML text over the mock server", async () => {
    const html = await fetchHtml(`${base}/2019/01/first_post.html`);
    expect(html).toContain("First Post: A Title");
  });

  test("a non-ok response throws `HTTP <status>` — same message shape as the source", async () => {
    let caught: unknown;
    try {
      await fetchHtml(`${base}/missing.html`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("HTTP 404");
  });
});

describe("parsePost — HTML parsing preserved verbatim (source :237-276)", () => {
  test("extracts title / date / slug / body from a canned post page", () => {
    const url = `${base}/2019/01/first_post.html`;
    const post = parsePost(POST_HTML("First Post Title", "January 15, 2019", "Body text here."), url);
    expect(post.title).toBe("First Post Title");
    expect(post.postDate).toBe("2019-01-15");
    expect(post.year).toBe("2019");
    expect(post.month).toBe("01");
    expect(post.fileSlug).toBe("tlp-2019-01-first-post");
    expect(post.bodyMd).toContain("Body text here.");
  });

  test("concatenates entry-body + entry-more when present", () => {
    const url = `${base}/2019/02/second_post.html`;
    const post = parsePost(
      POST_HTML("Second Post Title", "February 3, 2019", "Main body.", true),
      url,
    );
    expect(post.bodyMd).toContain("Main body.");
    expect(post.bodyMd).toContain("More content appended after the fold");
  });
});

describe("main('list') — buildUrlList → fsx.atomicWrite (source :334-351)", () => {
  test("writes cfg.urlFile with both relative and base-prefixed links resolved + deduped + sorted", async () => {
    const code = await main(["list"], cfg);
    expect(code).toBe(0);
    const written = readFileSync(cfg.urlFile, "utf-8").trim().split("\n");
    expect(written).toEqual([
      `${base}/2019/01/first_post.html`,
      `${base}/2019/02/second_post.html`,
    ]);
  });
});

describe("main('probe') — fetch + parse, no write", () => {
  test("prints the parsed post as JSON, does not touch the filesystem", async () => {
    const code = await main(["probe", `${base}/2019/01/first_post.html`], cfg);
    expect(code).toBe(0);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(printed).toContain("First Post: A Title");
    expect(printed).toContain("\"fileSlug\": \"tlp-2019-01-first-post\"");
  });
});

describe("main('one') — DURABILITY UPGRADE: writeFileSync → fsx.atomicWrite; TODAY → isoDate(injected now)", () => {
  test("writes a Knowledge entry with the expected bytes, using the INJECTED now (not the real clock)", async () => {
    const fixedNow = new Date("2020-06-15T00:00:00Z");
    const code = await main(["one", `${base}/2019/01/first_post.html`], cfg, fixedNow);
    expect(code).toBe(0);

    const entryPath = join(cfg.knowledgeDir, "tlp-2019-01-first-post.md");
    const content = readFileSync(entryPath, "utf-8");

    // isoDate(now) drove created/updated — proves the fixed injected date, not `new Date()` ambient.
    expect(content).toContain("created: 2020-06-15");
    expect(content).toContain("updated: 2020-06-15");
    expect(content).toContain('title: "First Post: A Title"');
    expect(content).toContain(`source_url: ${base}/2019/01/first_post.html`);
    expect(content).toContain("post_date: 2019-01-15");
    expect(content).toContain("This is the body of the first archived post");
  });

  test("a body under the 50-char gate reports ok:false with a 'Body too short' error, writes nothing", async () => {
    const code = await main(["one", `${base}/2019/03/short_post.html`], cfg);
    expect(code).toBe(0); // `one` itself succeeds; the failure is inside the JSON result
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(printed).toContain("\"ok\": false");
    expect(printed).toContain("Body too short");
  });
});

describe("main('all') — bulk run: fsx.ensureDir + fsx.atomicWrite for entries + success/failed lists", () => {
  test("processes every URL in cfg.urlFile, writes entries + success/failed manifests", async () => {
    // Skip the archive-page fetch: pre-seed urlFile directly (proves `all` reads it via readIfExists,
    // source :527-533, without re-crawling when the file already exists).
    const seeded = [
      `${base}/2019/01/first_post.html`,
      `${base}/2019/02/second_post.html`,
      `${base}/2019/03/short_post.html`, // will fail (too short)
    ].join("\n");
    await Bun.write(cfg.urlFile, seeded + "\n");

    const fixedNow = new Date("2021-03-01T00:00:00Z");
    const code = await main(["all"], cfg, fixedNow);
    expect(code).toBe(0);

    expect(readFileSync(join(cfg.knowledgeDir, "tlp-2019-01-first-post.md"), "utf-8")).toContain(
      "created: 2021-03-01",
    );
    expect(readFileSync(join(cfg.knowledgeDir, "tlp-2019-02-second-post.md"), "utf-8")).toContain(
      "created: 2021-03-01",
    );

    const successList = readFileSync(cfg.successFile, "utf-8").trim().split("\n");
    expect(successList).toHaveLength(2);

    const failedList = readFileSync(cfg.failedFile, "utf-8").trim().split("\n");
    expect(failedList).toHaveLength(1);
    expect(failedList[0]).toContain("short_post.html");
  });
});

describe("main('retry') — reads cfg.failedFile via readIfExists (source :541-546)", () => {
  test("with no failed file: logs 'No failed file' and returns 0, writes nothing", async () => {
    const code = await main(["retry"], cfg);
    expect(code).toBe(0);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(printed).toContain("No failed file");
  });

  test("retries the URL column of an existing failed file", async () => {
    await Bun.write(cfg.failedFile, `${base}/2019/01/first_post.html\tsome earlier error\n`);
    const fixedNow = new Date("2022-01-01T00:00:00Z");
    const code = await main(["retry"], cfg, fixedNow);
    expect(code).toBe(0);
    const entry = readFileSync(join(cfg.knowledgeDir, "tlp-2019-01-first-post.md"), "utf-8");
    expect(entry).toContain("created: 2022-01-01");
  });
});

describe("main('index') — buildArchiveIndex reads existing entries via readIfExists (source :438-443)", () => {
  test("writes tlp-archive-index.md listing the archived post read back from disk", async () => {
    const fixedNow = new Date("2023-05-05T00:00:00Z");
    await main(["list"], cfg);
    await main(["one", `${base}/2019/01/first_post.html`], cfg, fixedNow);

    const code = await main(["index"], cfg, fixedNow);
    expect(code).toBe(0);

    const indexPath = join(cfg.knowledgeDir, "tlp-archive-index.md");
    const content = readFileSync(indexPath, "utf-8");
    expect(content).toContain("The Last Psychiatrist — Archive Index");
    // Title pulled back from the entry file just written (proves the readIfExists round-trip).
    expect(content).toContain("First Post: A Title");
    expect(content).toContain("2019-01-15");
  });

  test("extracts unquoted titles correctly from frontmatter", async () => {
    const fixedNow = new Date("2023-05-05T00:00:00Z");
    await main(["list"], cfg);

    const postSlug = "tlp-2019-01-first-post";
    const postPath = join(cfg.knowledgeDir, `${postSlug}.md`);
    
    mkdirSync(cfg.knowledgeDir, { recursive: true });
    writeFileSync(postPath, `---\ntitle: Unquoted Post Title\npost_date: 2019-01-15\n---`);

    const code = await main(["index"], cfg, fixedNow);
    expect(code).toBe(0);

    const indexPath = join(cfg.knowledgeDir, "tlp-archive-index.md");
    const content = readFileSync(indexPath, "utf-8");
    expect(content).toContain("Unquoted Post Title");
  });
});

describe("main — unknown command", () => {
  test("prints usage and returns 2", async () => {
    const code = await main(["bogus"], cfg);
    expect(code).toBe(2);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(printed).toContain("Usage:");
  });
});

describe("defaultConfig — env-var overrides (D4: nothing baked, everything overridable)", () => {
  test("honors TLP_BASE_URL / TLP_STATE_DIR / TLP_KNOWLEDGE_DIR / TLP_ARCHIVE_URL", () => {
    const saved = {
      base: process.env.TLP_BASE_URL,
      state: process.env.TLP_STATE_DIR,
      knowledge: process.env.TLP_KNOWLEDGE_DIR,
      archive: process.env.TLP_ARCHIVE_URL,
    };
    process.env.TLP_BASE_URL = "http://example.test";
    process.env.TLP_STATE_DIR = "/tmp/tlp-state-override";
    process.env.TLP_KNOWLEDGE_DIR = "/tmp/tlp-knowledge-override";
    process.env.TLP_ARCHIVE_URL = "http://example.test/custom-archive.html";
    try {
      const c = defaultConfig();
      expect(c.blogBaseUrl).toBe("http://example.test");
      expect(c.urlFile).toBe("/tmp/tlp-state-override/tlp-urls.txt");
      expect(c.knowledgeDir).toBe("/tmp/tlp-knowledge-override");
      expect(c.archiveUrl).toBe("http://example.test/custom-archive.html");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        const envKey = `TLP_${k === "base" ? "BASE_URL" : k === "state" ? "STATE_DIR" : k === "knowledge" ? "KNOWLEDGE_DIR" : "ARCHIVE_URL"}`;
        if (v === undefined) delete process.env[envKey];
        else process.env[envKey] = v;
      }
    }
  });

  test("defaults archiveUrl off blogBaseUrl when TLP_ARCHIVE_URL is unset", () => {
    const saved = { base: process.env.TLP_BASE_URL, archive: process.env.TLP_ARCHIVE_URL };
    delete process.env.TLP_ARCHIVE_URL;
    process.env.TLP_BASE_URL = "http://example2.test";
    try {
      expect(defaultConfig().archiveUrl).toBe("http://example2.test/archives.html");
    } finally {
      if (saved.base === undefined) delete process.env.TLP_BASE_URL;
      else process.env.TLP_BASE_URL = saved.base;
      if (saved.archive === undefined) delete process.env.TLP_ARCHIVE_URL;
      else process.env.TLP_ARCHIVE_URL = saved.archive;
    }
  });
});

// ── RT-2 framework-dir resolution (AD-9.3, Category-4 resolver-only) ──────────────────────────────────

describe("RT-2 framework-dir resolution (AD-9.3)", () => {
  // tlp-archive is Category 4: it does NOT read LIFEOS_DIR/PAI_DIR at the framework root — only
  // resolveFrameworkDir(HOME) for the knowledgeDir base, plus the TLP_KNOWLEDGE_DIR subpath override.
  // So exercise the RESOLVER cases (fresh→LIFEOS, legacy PAI tree→PAI) + the override precedence.
  const KEYS = ["TLP_KNOWLEDGE_DIR", "HOME", "LIFEOS_DIR", "PAI_DIR"] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("fresh home → knowledgeDir resolves under <home>/.claude/LIFEOS", () => {
    delete process.env.TLP_KNOWLEDGE_DIR;
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    const home = mkdtempSync(join(tmpdir(), "rt2-"));
    process.env.HOME = home;
    try {
      expect(defaultConfig().knowledgeDir).toBe(
        join(home, ".claude", "LIFEOS", "MEMORY/KNOWLEDGE/Blogs"),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("legacy PAI tree present → resolver picks PAI", () => {
    delete process.env.TLP_KNOWLEDGE_DIR;
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    const home = mkdtempSync(join(tmpdir(), "rt2-"));
    mkdirSync(join(home, ".claude", "PAI"), { recursive: true });
    process.env.HOME = home;
    try {
      expect(defaultConfig().knowledgeDir).toBe(
        join(home, ".claude", "PAI", "MEMORY/KNOWLEDGE/Blogs"),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("TLP_KNOWLEDGE_DIR override still wins over the resolver", () => {
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    process.env.TLP_KNOWLEDGE_DIR = "/custom";
    expect(defaultConfig().knowledgeDir).toBe("/custom");
  });
});
