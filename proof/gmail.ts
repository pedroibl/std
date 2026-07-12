#!/usr/bin/env bun
// gmail — Story 12.5 rewrite onto the std substrate (proof/ consumer; live cutover to
// ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). Direct Gmail API client using OAuth refresh
// token. Behavior preserved.
//
// Usage:
//   gmail.ts count "<q>"                           # inbox-size estimate for query
//   gmail.ts ids   "<q>" [max]                     # list message IDs (default max 500)
//   gmail.ts archive <id>[,id,...]                 # remove INBOX label in batch (up to 1000)
//   gmail.ts fetch <id>                            # minimal From/Subject/snippet JSON
//   gmail.ts send --to ADDR --subject SUBJ (--body-file PATH | --body-stdin) [--html]
//                 [--cc ADDR] [--bcc ADDR] [--from ADDR] [--reply-to ADDR]
//                 [--reply-to-id GMAIL_ID]         # auto-thread to this message
//
// send command sends as the authenticated Gmail user. Gmail signs with its own DKIM, so no DMARC
// alignment issues that SES has.
//
// Credentials path is resolved in order:
//   1. $GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE (settings.json env)
//   2. $HOME/.claude/PAI/USER/CREDENTIALS/google/credentials.json (fallback)
//
// SUBSTRATE FINDING #1 — the ONE decision of this story's HTTP-cluster part: `gmail()`, the REST
// helper, canNOT be rewritten onto `httpJson`. `httpJson` is FAIL-LOUD on a non-JSON 2xx body — but
// Gmail's `batchModify` (archive) and `send` endpoints return an EMPTY (or near-empty) 2xx body on
// success, and an empty body is not valid JSON. Routing those calls through `httpJson` would make every
// successful archive/send throw `"response body was not valid JSON"`. So `gmail()` stays on
// `fetchWithTimeout` (the transparent envelope, asserts nothing, reads no body) and keeps its own
// empty-tolerant edge parse (`text ? JSON.parse(text) : {}`). No empty-body-tolerant variant is added
// to `httpJson` itself — it has exactly one consumer here that needs that behavior (D2, no speculative
// generalization). `gmail.test.ts` carries the regression that proves the empty-body path stays green.
//
// SUBSTRATE FINDING #2 — `core.dispatch()` doesn't fit this CLI's subcommand switch: it is documented
// sync-only (`Record<string, () => number>`), but every subcommand handler here `await`s a network
// call. `inference.ts` (this same story) hits the identical wall. Both hand-roll the same
// `Object.hasOwn`-keyed map `dispatch()` uses internally, just async — the "async/richer-result
// variant" `dispatch`'s own doc comment defers "until a real consumer needs it" (D2). There are now two
// candidate consumers.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { flagValue, hasFlag, positional } from "std/core";
import { fetchWithTimeout, httpJson } from "std/http";
import { loadJson } from "std/fsx";

// ─── Caller-local identity (D4): creds path/env, OAuth + API base URLs, INBOX label ─────────────────

function credsPath(): string {
  return (
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE?.replace(/^\$HOME/, homedir()) ??
    `${homedir()}/.claude/PAI/USER/CREDENTIALS/google/credentials.json`
  );
}

// Env-overridable so tests can point at a local Bun.serve server; real defaults preserved.
function oauthUrl(): string {
  return process.env.GMAIL_OAUTH_URL || "https://oauth2.googleapis.com/token";
}
function apiBaseUrl(): string {
  return process.env.GMAIL_API_BASE_URL || "https://gmail.googleapis.com/gmail/v1/users/me";
}

type Creds = { client_id: string; client_secret: string; refresh_token: string };

// Lazy + cached (NOT read at module load, unlike the source): the source read creds synchronously at
// import time, which meant merely `import`-ing the file for a test — or as a library — required a
// valid creds file to already exist on disk. Deferring the read to first actual use means importing
// this module is side-effect-free, matching the `import.meta.main` guard the story mandates below (a
// guard is pointless if the module still does real I/O just by being imported).
let _creds: Creds | undefined;
function creds(): Creds {
  if (_creds === undefined) {
    const c = loadJson<Partial<Creds>>(credsPath(), {});
    if (!c.client_id || !c.client_secret || !c.refresh_token) {
      throw new Error(`missing or invalid credentials file: ${credsPath()}`);
    }
    _creds = c as Creds;
  }
  return _creds;
}

let cachedToken: { token: string; expires: number } | null = null;
async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;
  const c = creds();
  const body = new URLSearchParams({
    client_id: c.client_id,
    client_secret: c.client_secret,
    refresh_token: c.refresh_token,
    grant_type: "refresh_token",
  });
  // Real JSON on both success and failure paths (Google's token endpoint) — httpJson's fail-loud
  // assert-ok+parse contract fits directly. No empty-body edge case here, unlike gmail() below.
  const j = await httpJson<{ access_token: string; expires_in: number }>(oauthUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  cachedToken = { token: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return cachedToken.token;
}

async function gmail(path: string, init?: RequestInit): Promise<any> {
  const t = await accessToken();
  const url = `${apiBaseUrl()}${path}`;
  // fetchWithTimeout, NOT httpJson — see SUBSTRATE FINDING #1 at the top of this file. This also adds
  // a timeout envelope where the original bare `fetch` had none (HTTP_TIMEOUT_MS default 30s) — a
  // strict improvement, no regression for real Gmail calls.
  const r = await fetchWithTimeout(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function listIds(q: string, max: number): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < max) {
    const pageSize = Math.min(500, max - ids.length);
    const qp = new URLSearchParams({ q, maxResults: String(pageSize) });
    if (pageToken) qp.set("pageToken", pageToken);
    const res = await gmail(`/messages?${qp.toString()}`);
    for (const m of res.messages ?? []) ids.push(m.id);
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return ids;
}

async function countQuery(q: string): Promise<number> {
  const qp = new URLSearchParams({ q, maxResults: "1" });
  const res = await gmail(`/messages?${qp.toString()}`);
  return res.resultSizeEstimate ?? 0;
}

async function archiveBatch(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    await gmail(`/messages/batchModify`, {
      method: "POST",
      body: JSON.stringify({ ids: chunk, removeLabelIds: ["INBOX"] }),
    });
  }
}

async function fetchMin(id: string): Promise<any> {
  const qp2 = new URLSearchParams({ format: "metadata" });
  qp2.append("metadataHeaders", "From");
  qp2.append("metadataHeaders", "Subject");
  qp2.append("metadataHeaders", "Date");
  const m = await gmail(`/messages/${id}?${qp2.toString()}`);
  const headers = m.payload?.headers ?? [];
  const h = (n: string) => headers.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  return { id, from: h("From"), subject: h("Subject"), date: h("Date"), snippet: (m.snippet ?? "").slice(0, 120) };
}

type SendOpts = {
  to: string;
  subject: string;
  body: string;
  html?: boolean;
  cc?: string;
  bcc?: string;
  from?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
};

function b64url(buf: Uint8Array | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : Buffer.from(buf);
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildRfc822(opts: SendOpts): string {
  const headers: string[] = [];
  headers.push(`MIME-Version: 1.0`);
  if (opts.from) headers.push(`From: ${opts.from}`);
  headers.push(`To: ${opts.to}`);
  if (opts.cc) headers.push(`Cc: ${opts.cc}`);
  if (opts.bcc) headers.push(`Bcc: ${opts.bcc}`);
  if (opts.replyTo) headers.push(`Reply-To: ${opts.replyTo}`);
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) headers.push(`References: ${opts.references}`);
  headers.push(`Subject: ${opts.subject}`);
  const ctype = opts.html ? `text/html; charset="UTF-8"` : `text/plain; charset="UTF-8"`;
  headers.push(`Content-Type: ${ctype}`);
  headers.push(`Content-Transfer-Encoding: 8bit`);
  return `${headers.join("\r\n")}\r\n\r\n${opts.body}`;
}

async function resolveThreadFromReplyId(gmailId: string): Promise<{ threadId: string; inReplyTo: string; references: string; subject: string }> {
  const qp = new URLSearchParams({ format: "metadata" });
  qp.append("metadataHeaders", "Message-ID");
  qp.append("metadataHeaders", "References");
  qp.append("metadataHeaders", "Subject");
  const m = await gmail(`/messages/${gmailId}?${qp.toString()}`);
  const headers = m.payload?.headers ?? [];
  const h = (n: string) => headers.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  const msgId = h("Message-ID") || h("Message-Id");
  const priorRefs = h("References");
  const subj = h("Subject");
  if (!msgId) throw new Error(`could not find Message-ID header on ${gmailId}`);
  const refs = priorRefs ? `${priorRefs} ${msgId}` : msgId;
  return { threadId: m.threadId, inReplyTo: msgId, references: refs, subject: subj };
}

async function sendMessage(opts: SendOpts & { dryRun?: boolean }): Promise<any> {
  const raw = b64url(buildRfc822(opts));
  const payload: any = { raw };
  if (opts.threadId) payload.threadId = opts.threadId;
  if (opts.dryRun) return { dryRun: true, rfc822_preview: buildRfc822(opts).slice(0, 500) };
  return gmail(`/messages/send`, { method: "POST", body: JSON.stringify(payload) });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────────────────────────

const SEND_BOOL_FLAGS = ["body-stdin", "html", "dry-run"] as const;
const SEND_VALUE_FLAGS = [
  "to",
  "subject",
  "body-file",
  "cc",
  "bcc",
  "from",
  "reply-to",
  "reply-to-id",
  "in-reply-to",
  "references",
  "thread-id",
] as const;

function parseSendArgs(argv: string[]): SendOpts & { bodyFile?: string; bodyStdin?: boolean; replyToId?: string; dryRun?: boolean } {
  // The original threw on any --flag outside its switch; core/args's flagValue/hasFlag don't validate
  // the flag set for us, so this CLI's own grammar (D4) still owns that check.
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const name = a.split("=")[0].replace(/^--/, "");
    if (!(SEND_BOOL_FLAGS as readonly string[]).includes(name) && !(SEND_VALUE_FLAGS as readonly string[]).includes(name)) {
      throw new Error(`unknown arg: ${a}`);
    }
  }

  return {
    to: flagValue(argv, "to") ?? "",
    subject: flagValue(argv, "subject") ?? "",
    body: "", // filled in by the caller after reading --body-file/--body-stdin
    bodyFile: flagValue(argv, "body-file"),
    bodyStdin: hasFlag(argv, "body-stdin"),
    html: hasFlag(argv, "html"),
    cc: flagValue(argv, "cc"),
    bcc: flagValue(argv, "bcc"),
    from: flagValue(argv, "from"),
    replyTo: flagValue(argv, "reply-to"),
    replyToId: flagValue(argv, "reply-to-id"),
    inReplyTo: flagValue(argv, "in-reply-to"),
    references: flagValue(argv, "references"),
    threadId: flagValue(argv, "thread-id"),
    dryRun: hasFlag(argv, "dry-run"),
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = positional(argv); // argv[0] — the subcommand token, never itself a "--flag"
  const args = argv.slice(1);

  // See SUBSTRATE FINDING #2 at the top of this file for why this is a hand-rolled async map (same
  // `Object.hasOwn` shape `dispatch()` uses internally) rather than `core.dispatch()` itself.
  const handlers: Record<string, () => Promise<void>> = {
    count: async () => {
      console.log(await countQuery(args[0] ?? "in:inbox"));
    },
    ids: async () => {
      const q = args[0] ?? "in:inbox";
      const max = args[1] ? parseInt(args[1], 10) : 500;
      const ids = await listIds(q, max);
      console.log(ids.join("\n"));
    },
    archive: async () => {
      const ids = (args[0] ?? "").split(",").filter(Boolean);
      if (!ids.length) throw new Error("no ids");
      await archiveBatch(ids);
      console.log(`archived ${ids.length}`);
    },
    fetch: async () => {
      console.log(JSON.stringify(await fetchMin(args[0]), null, 2));
    },
    fetchall: async () => {
      const q = args[0] ?? "in:inbox";
      const max = args[1] ? parseInt(args[1], 10) : 500;
      const ids = await listIds(q, max);
      const conc = 20;
      for (let i = 0; i < ids.length; i += conc) {
        const chunk = ids.slice(i, i + conc);
        const results = await Promise.all(chunk.map((id) => fetchMin(id).catch((e) => ({ id, error: e.message }))));
        for (const r of results) console.log(JSON.stringify(r));
      }
    },
    send: async () => {
      const opts = parseSendArgs(args);
      if (!opts.to) throw new Error("--to required");
      if (!opts.subject && !opts.replyToId) throw new Error("--subject required (or --reply-to-id to inherit)");
      if (!opts.bodyFile && !opts.bodyStdin) throw new Error("--body-file or --body-stdin required");
      const body = opts.bodyStdin ? await readStdin() : readFileSync(opts.bodyFile!, "utf8");
      if (opts.replyToId) {
        const thr = await resolveThreadFromReplyId(opts.replyToId);
        opts.threadId ??= thr.threadId;
        opts.inReplyTo ??= thr.inReplyTo;
        opts.references ??= thr.references;
        if (!opts.subject) opts.subject = thr.subject.startsWith("Re:") ? thr.subject : `Re: ${thr.subject}`;
      }
      const res = await sendMessage({ ...opts, body });
      console.log(JSON.stringify(res, null, 2));
    },
  };

  try {
    if (Object.hasOwn(handlers, cmd)) {
      await handlers[cmd]();
      return 0;
    }
    console.log("usage: gmail.ts count|ids|archive|fetch|fetchall|send ...");
    return 1;
  } catch (e: any) {
    console.error(`ERR: ${e.message}`);
    return 1;
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

/** Test-only: clears the module-level token cache so each test exercises a fresh OAuth round-trip. */
export function _resetTokenCacheForTests(): void {
  cachedToken = null;
  _creds = undefined;
}

// Exported for hermetic testing (proof/gmail.test.ts) — no test touches the real ~/.claude or network.
export { accessToken, archiveBatch, countQuery, gmail };
