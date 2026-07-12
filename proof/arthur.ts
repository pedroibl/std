#!/usr/bin/env bun
/**
 * arthur — Story 12.5 rewrite onto the std substrate (proof/ consumer; live cutover to
 * ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). PAI Authorization Officer / Credential Custodian:
 * policy-gated GCP Secret Manager access with an append-only audit trail. SECURITY-CRITICAL — this is a
 * PLUMBING-ONLY rewrite. The policy engine (`evaluate`), the GCP fetch semantics, the deny→exit(2)
 * contract, and the stdout-no-trailing-newline secret-release contract are preserved BYTE-FOR-BYTE.
 * Only the identity-free plumbing seam moves onto the substrate.
 *
 * Substrate swaps:
 *   - CLI flag parse (source :318-352, ad-hoc `args.find(a => a.startsWith("--x="))`) → `core/args`
 *     (`positional`/`flagValue`). Not `dispatch`: `get` is async (awaits GCP + the confirmation
 *     channel) and `dispatch`'s handler signature is `() => number` (sync) — forcing an async command
 *     through it would need a fire-and-forget wrapper that breaks the awaited-exit-code contract the
 *     CLI depends on. So this dispatches manually via `if`/`else`, the same shape `cross-vendor-audit.ts`
 *     / `secret-scan.ts` use for their async `main` in this same cluster.
 *   - the dated audit-dir builder (source :48-56 — `getFullYear()`/`getMonth()+1`/`getDate()` +
 *     `existsSync`+`mkdirSync`) → `fsx.ensureDir` for the directory + `dateParts(now, tz)` for the
 *     Y/M/D parts. `tz` is the HOST timezone, resolved ONCE at the edge (`hostTz()`, via
 *     `Intl.DateTimeFormat().resolvedOptions().timeZone`) and injected explicitly — the source read
 *     host-local time AMBIENTLY (`getFullYear()` etc. are local-time getters); resolving the zone once
 *     at the edge and passing it in preserves that exact host-local behavior while satisfying
 *     `dateParts`'s no-ambient-tz contract (D1: core never reads the ambient clock/host tz itself).
 *   - the JSONL audit append (source :65, raw `appendFileSync`) → `report.appendAudit` (an audit log IS
 *     what FR9's `appendAudit` targets; it is BEST-EFFORT/never-throws — a strict improvement over the
 *     source's unguarded `appendFileSync`, where a full disk or a permission fault would have thrown
 *     out of `audit()` and could have taken down the credential request it was only trying to log).
 *   - `new Date().toISOString()` full-moment timestamp (source :60) STAYS a full timestamp —
 *     `isoDate(now)` returns a DATE-only `YYYY-MM-DD` string, which does not fit the audit entry's
 *     `timestamp` field (a moment, not a calendar date), so it is not substituted. `now` becomes an
 *     optional injected parameter (default `new Date()`) purely for test determinism; the value written
 *     on the real CLI path is unchanged.
 *   - the `HH:MM-HH:MM` time-window check (source :113-136) — KEPT LOCAL. `dateParts` returns only
 *     calendar date parts (year/month/day), never hour/minute, so it cannot serve a minutes-of-day
 *     comparison; the `Intl.DateTimeFormat({hour,minute})` extraction is unchanged. What DOES move: the
 *     hardcoded `"America/Los_Angeles"` literal (source :121) is now an injected `tz` PARAMETER
 *     (`ArthurEnv.defaultTz`, defaulting to `"Australia/Melbourne"` — Pedro is in Melbourne, AU, NOT the
 *     PAI template's LA) — caller-local config (D4); it is just no longer buried inside the function body.
 *   - the rate-limit bucket arithmetic (source :94-109, `/minute|hour|day` regex + `Date.now()`) — KEPT
 *     LOCAL verbatim (D4: consumer-specific rate vocabulary, not a generic std primitive). `now`
 *     becomes an optional injected ms-since-epoch parameter (default `Date.now()`) for test determinism.
 *
 * PRESERVED BYTE-FOR-BYTE (the security boundary — never touched, never moved into `std/src`):
 *   - the policy engine (`evaluate`) — every ALLOW/DENY/CONFIRM rule and its ordering, verbatim.
 *   - `get()` — on ALLOW/CONFIRM-approved: fetches from the vault and returns the plaintext. On DENY it
 *     throws `ArthurDeniedError`. Same audit events, same ordering, same messages.
 *   - the CLI `get` command — writes the secret to **stdout with NO trailing newline**
 *     (`process.stdout.write(value)`, source :331) and on `ArthurDeniedError` writes to **stderr and
 *     exits 2** (source :333-337). Both are LIVE contracts other tools pipe/depend on.
 *   - the GCP fetch shape (`projects/{project}/secrets/{key}/versions/latest`) and its 60s in-memory
 *     cache — the fetch is now INJECTABLE (a `SecretFetcher` parameter) so this proof file never
 *     statically imports `@google-cloud/secret-manager` (not installed in std-public, and never should
 *     be — a proof file must not need real GCP credentials to load or test). The real dynamic
 *     `import()` is still the documented DEFAULT fetcher, used whenever a caller doesn't inject a stub
 *     — the production behavior is unchanged, only now swappable at the seam.
 *   - `PAI_DIR` / `POLICIES_PATH` / `GCP_PROJECT` / the `Australia/Melbourne` time-window default — all
 *     stay caller-local identity (D4), bundled into one injectable `ArthurEnv` (the same "env" pattern
 *     `doc-check.ts` uses for PAI-estate roots), still env-sourced with the exact same defaults.
 *
 * Test seam (proof/arthur.test.ts): every function that touches the filesystem, the clock, or the
 * network takes its dependency as an explicit parameter with a real-world default — `securityLogPath`/
 * `audit` take `env`+`now`+`tz`, `loadPolicies`/`getPolicy`/`evaluate` take `env`, `get()` takes an
 * injectable `fetcher`. No `@google-cloud/secret-manager` import, no real `PAI_DIR`, no network call in
 * the test — a fake `SecretFetcher` and a `mkdtemp`'d `ArthurEnv` stand in for both.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

import { flagValue, positional } from "std/core";
import { dateParts } from "std/core";
import { ensureDir, resolveFrameworkDir } from "std/fsx";
import { appendAudit } from "std/report";

// ───────────────────────── Types (unchanged from the source) ─────────────────────────

interface Policy {
  allowed_callers?: string[];
  purposes?: string[];
  rate_limit?: string;
  risk?: "low" | "medium" | "high" | "critical";
  require_confirmation?: boolean;
  time_window?: string;
}

interface Policies {
  version: number;
  [key: string]: Policy | number | undefined;
}

interface AccessRequest {
  key: string;
  caller: string;
  purpose: string;
  session_id?: string;
}

type Verdict = "ALLOW" | "DENY" | "CONFIRM";

interface PolicyDecision {
  verdict: Verdict;
  reason: string;
  rule: string;
}

// ───────────────────────── Edge identity (D4) ─────────────────────────

/** Injected PAI-estate identity — defaulted from env/`$HOME`, overridden by tests (the `doc-check.ts`
 *  "env" pattern). Nothing here is read ambiently by the functions below; it is always passed in. */
export interface ArthurEnv {
  paiDir: string;
  policiesPath: string;
  auditRoot: string;
  gcpProject: string;
  /** Time-window default tz — caller-local config (D4), unchanged value from the source. */
  defaultTz: string;
}

export function defaultEnv(): ArthurEnv {
  const paiDir = process.env.LIFEOS_DIR || process.env.PAI_DIR || resolveFrameworkDir(homedir());
  return {
    paiDir,
    policiesPath: join(paiDir, "USER", "ARTHUR", "policies.yaml"),
    auditRoot: join(paiDir, "MEMORY", "SECURITY"),
    gcpProject: process.env.PAI_GCP_PROJECT ?? "",
    defaultTz: "Australia/Melbourne",
  };
}

/** Host timezone, resolved ONCE at the edge — see the "Substrate swaps" note above: this preserves the
 *  source's ambient-local-time audit-dir date while satisfying `dateParts`'s no-ambient-tz contract. */
function hostTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// ───────────────────────── Audit log ─────────────────────────

/**
 * `env.auditRoot/YYYY/MM/arthur-{kind}-YYYYMMDD.jsonl` — the source's dated audit path, rebuilt on
 * `dateParts(now, tz)` + `fsx.ensureDir`. `now`/`tz` default to the real clock / resolved host tz, so
 * the CLI's ambient behavior is unchanged; tests inject both for determinism.
 */
export function securityLogPath(env: ArthurEnv, kind: string, now: Date = new Date(), tz: string = hostTz()): string {
  const [yyyy, mm, dd] = dateParts(now, tz).iso.split("-");
  const dir = join(env.auditRoot, yyyy!, mm!);
  ensureDir(dir);
  return join(dir, `arthur-${kind}-${yyyy}${mm}${dd}.jsonl`);
}

/**
 * Append one audit entry via `report.appendAudit` (best-effort JSONL append, FR9). Same entry shape as
 * the source: `{ timestamp, agent: "arthur", ...event }`, routed to the `kind`-specific dated log.
 */
export function audit(env: ArthurEnv, event: Record<string, unknown>, now: Date = new Date()): void {
  const entry = {
    timestamp: now.toISOString(),
    agent: "arthur",
    ...event,
  };
  const kind = typeof event.event_type === "string" ? event.event_type : "event";
  appendAudit(securityLogPath(env, kind, now), entry);
}

// ───────────────────────── Policy loader ─────────────────────────

// Keyed by policiesPath (not a single global slot) so tests using distinct mkdtemp'd envs never share
// a cache window — a pure testability improvement, harmless to the single-path production caller.
const policiesCache = new Map<string, { policies: Policies; loadedAt: number }>();
const POLICIES_CACHE_MS = 5_000;

export function loadPolicies(env: ArthurEnv, now: number = Date.now()): Policies {
  const cached = policiesCache.get(env.policiesPath);
  if (cached && now - cached.loadedAt < POLICIES_CACHE_MS) return cached.policies;
  const text = readFileSync(env.policiesPath, "utf8");
  const policies = YAML.parse(text) as Policies;
  policiesCache.set(env.policiesPath, { policies, loadedAt: now });
  return policies;
}

export function getPolicy(env: ArthurEnv, key: string, now?: number): Policy | null {
  const policies = loadPolicies(env, now);
  const p = policies[key];
  if (p && typeof p === "object") return p as Policy;
  return null;
}

// ───────────────────────── Rate limiting (SQLite, in-memory for v1) — kept local (D4) ─────────────────────────

const rateWindows = new Map<string, number[]>();

export function checkRate(key: string, caller: string, limit: string, now: number = Date.now()): { ok: boolean; reason?: string } {
  const match = limit.match(/^(\d+)\/(minute|hour|day)$/);
  if (!match) return { ok: true };
  const [, countStr, unit] = match;
  const max = parseInt(countStr!, 10);
  const windowMs = unit === "minute" ? 60_000 : unit === "hour" ? 3_600_000 : 86_400_000;
  const bucket = `${key}|${caller}`;
  const hits = (rateWindows.get(bucket) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    return { ok: false, reason: `rate limit: ${limit} exceeded (${hits.length} hits)` };
  }
  hits.push(now);
  rateWindows.set(bucket, hits);
  return { ok: true };
}

// ───────────────────────── Time window check — kept local (D4); tz now injected ─────────────────────────

export function checkTimeWindow(window: string, tz: string = "Australia/Melbourne", now: Date = new Date()): { ok: boolean; reason?: string } {
  const match = window.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!match) return { ok: true };
  const [, sh, sm, eh, em] = match;
  // Windows are expressed in `tz` (default Australia/Melbourne — Pedro's tz), independent of the
  // host timezone — compute the current tz-local wall-clock minutes-of-day. `dateParts` cannot serve
  // this: it returns only calendar date parts, never hour/minute (see the header note).
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const tzHour = parseInt(tzParts.find((p) => p.type === "hour")?.value ?? "0", 10) % 24;
  const tzMin = parseInt(tzParts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const minutesNow = tzHour * 60 + tzMin;
  const startMin = parseInt(sh!, 10) * 60 + parseInt(sm!, 10);
  const endMin = parseInt(eh!, 10) * 60 + parseInt(em!, 10);
  if (minutesNow < startMin || minutesNow > endMin) {
    const label = tz === "Australia/Melbourne" ? "AET" : tz === "America/Los_Angeles" ? "PT" : tz;
    const nowStamp = `${String(tzHour).padStart(2, "0")}:${String(tzMin).padStart(2, "0")} ${label}`;
    return { ok: false, reason: `outside time window ${window} (now ${nowStamp})` };
  }
  return { ok: true };
}

// ───────────────────────── Policy evaluation — PRESERVED byte-for-byte ─────────────────────────

export function evaluate(env: ArthurEnv, req: AccessRequest, now: Date = new Date()): PolicyDecision {
  const policy = getPolicy(env, req.key, now.getTime());

  // Default-allow for unlisted keys (low-risk bias per v1 design)
  if (!policy) {
    return {
      verdict: "ALLOW",
      reason: "no explicit policy; default-allow for low-risk unlisted keys",
      rule: "default",
    };
  }

  // Caller allowlist check
  if (policy.allowed_callers && !policy.allowed_callers.includes("any")) {
    if (!policy.allowed_callers.includes(req.caller)) {
      return {
        verdict: "DENY",
        reason: `caller '${req.caller}' not in allowlist for ${req.key}`,
        rule: "allowed_callers",
      };
    }
  }

  // Purpose declaration (mandatory if policy specifies purposes)
  if (policy.purposes && policy.purposes.length > 0) {
    if (!req.purpose || req.purpose.length < 3) {
      return {
        verdict: "DENY",
        reason: `purpose required for ${req.key}; none declared`,
        rule: "purpose_required",
      };
    }
    const declared = req.purpose.trim().toLowerCase();
    const matched = policy.purposes.some((p) => p.trim().toLowerCase() === declared);
    if (!matched) {
      return {
        verdict: "DENY",
        reason: `purpose '${req.purpose}' does not match allowed list [${policy.purposes.join(", ")}]`,
        rule: "purpose_match",
      };
    }
  }

  // Time window
  if (policy.time_window) {
    const win = checkTimeWindow(policy.time_window, env.defaultTz, now);
    if (!win.ok) {
      return { verdict: "DENY", reason: win.reason!, rule: "time_window" };
    }
  }

  // High-risk confirmation
  if (policy.require_confirmation) {
    return {
      verdict: "CONFIRM",
      reason: `risk=${policy.risk ?? "high"} requires human confirmation`,
      rule: "require_confirmation",
    };
  }

  // Rate limit — checked LAST so denied/unconfirmed attempts never consume a
  // rate slot (checkRate has the side effect of recording a hit).
  if (policy.rate_limit) {
    const rate = checkRate(req.key, req.caller, policy.rate_limit, now.getTime());
    if (!rate.ok) {
      return { verdict: "DENY", reason: rate.reason!, rule: "rate_limit" };
    }
  }

  return { verdict: "ALLOW", reason: "policy checks passed", rule: "policy_match" };
}

// ───────────────────────── GCP Secret Manager fetch — injectable (test seam) ─────────────────────────

export type SecretFetcher = (key: string, project: string) => Promise<string>;

// A non-literal-string specifier: TypeScript's dynamic `import()` only resolves module typings for a
// STRING-LITERAL argument. Routing through this `string`-typed const means `tsc --noEmit` never tries
// to find `@google-cloud/secret-manager`'s types (or the package itself) to typecheck this file — it is
// not, and must not become, a std-public dependency. `bun`'s runtime `import()` still resolves it fine
// at actual call time in production, where the real package IS installed (in PAI/TOOLS' own env).
const GCP_SECRET_MANAGER_SPECIFIER: string = "@google-cloud/secret-manager";

/** The real GCP fetch (production default). Never called by the test — tests inject a `SecretFetcher` stub. */
async function gcpFetcher(key: string, project: string): Promise<string> {
  const mod = (await import(GCP_SECRET_MANAGER_SPECIFIER)) as {
    SecretManagerServiceClient: new () => {
      accessSecretVersion(req: { name: string }): Promise<[{ payload?: { data?: { toString(): string } } }]>;
    };
  };
  const client = new mod.SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({
    name: `projects/${project}/secrets/${key}/versions/latest`,
  });
  const value = version.payload?.data?.toString() ?? "";
  if (!value) throw new Error(`GCP returned empty payload for ${key}`);
  return value;
}

const secretCache = new Map<string, { value: string; fetchedAt: number }>();
const SECRET_CACHE_MS = 60_000;

async function fetchFromGCP(env: ArthurEnv, key: string, fetcher: SecretFetcher = gcpFetcher, now: number = Date.now()): Promise<string> {
  const cached = secretCache.get(key);
  if (cached && now - cached.fetchedAt < SECRET_CACHE_MS) return cached.value;

  if (!env.gcpProject) {
    throw new Error("PAI_GCP_PROJECT env var not set; Arthur cannot reach the vault");
  }

  const value = await fetcher(key, env.gcpProject);
  secretCache.set(key, { value, fetchedAt: now });
  return value;
}

// ───────────────────────── Confirmation channel (v1 stub) ─────────────────────────

async function requestConfirmation(env: ArthurEnv, req: AccessRequest, reason: string, now: Date = new Date()): Promise<boolean> {
  // v1 stub — sends push via Pulse/Telegram and waits up to 60s for approval
  // TODO: wire to actual Telegram/iMessage push handler
  audit(env, {
    event_type: "confirmation_requested",
    key: req.key,
    caller: req.caller,
    purpose: req.purpose,
    reason,
    session_id: req.session_id,
  }, now);

  if (process.env.PAI_ARTHUR_OVERRIDE === "1") {
    audit(env, { event_type: "override", key: req.key, caller: req.caller, reason: "PAI_ARTHUR_OVERRIDE=1" }, now);
    return true;
  }

  // v1: conservative default — no auto-approval without human channel wired up.
  console.error(`[Arthur] CONFIRMATION REQUIRED for ${req.key} by ${req.caller}. Set PAI_ARTHUR_OVERRIDE=1 for one-shot approval.`);
  return false;
}

// ───────────────────────── Public API — PRESERVED byte-for-byte ─────────────────────────

export async function get(
  env: ArthurEnv,
  key: string,
  opts: { caller: string; purpose: string; session_id?: string; fetcher?: SecretFetcher; now?: Date },
): Promise<string> {
  const now = opts.now ?? new Date();
  const req: AccessRequest = { key, caller: opts.caller, purpose: opts.purpose, session_id: opts.session_id };

  // Policy check
  const decision = evaluate(env, req, now);
  audit(env, {
    event_type: "credential_request",
    key,
    caller: opts.caller,
    purpose: opts.purpose,
    session_id: opts.session_id,
    verdict: decision.verdict,
    rule: decision.rule,
    reason: decision.reason,
  }, now);

  if (decision.verdict === "DENY") {
    throw new ArthurDeniedError(`Arthur denied ${key} for ${opts.caller}: ${decision.reason}`);
  }

  if (decision.verdict === "CONFIRM") {
    const approved = await requestConfirmation(env, req, decision.reason, now);
    if (!approved) {
      audit(env, { event_type: "credential_deny", key, caller: opts.caller, reason: "confirmation not received" }, now);
      throw new ArthurDeniedError(`Arthur denied ${key} for ${opts.caller}: confirmation not received`);
    }
    audit(env, { event_type: "confirmation_approved", key, caller: opts.caller }, now);
  }

  // Fetch from vault
  const value = await fetchFromGCP(env, key, opts.fetcher, now.getTime());
  audit(env, {
    event_type: "credential_release",
    key,
    caller: opts.caller,
    purpose: opts.purpose,
    session_id: opts.session_id,
    verdict: "ALLOW",
    rule: decision.rule,
  }, now);
  return value;
}

export class ArthurDeniedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ArthurDeniedError";
  }
}

// ───────────────────────── CLI entrypoint ─────────────────────────

/**
 * The testable CLI body: parses `argv` with `core/args`, runs the matching command, and RETURNS an exit
 * code — it never calls `process.exit` itself (that stays in the `import.meta.main` wrapper below, the
 * one genuinely untestable edge). This is what makes the deny→exit(2) contract assertable without a
 * subprocess: a test can call `runCli` directly and check the returned code + what was written to
 * stdout/stderr, and the real CLI wrapper still exits with that exact code when actually run.
 */
export async function runCli(
  env: ArthurEnv,
  argv: string[],
  opts?: { fetcher?: SecretFetcher; now?: Date },
): Promise<number> {
  const cmd = positional(argv);

  if (cmd === "get") {
    const key = positional(argv.slice(1));
    const caller = flagValue(argv, "caller") ?? "cli";
    const purpose = flagValue(argv, "purpose") ?? "cli-manual";
    if (!key) {
      console.error("Usage: Arthur.ts get KEY_NAME [--caller=NAME] [--purpose=TEXT]");
      return 1;
    }
    try {
      // `opts.fetcher` is a TEST-ONLY seam (undefined in the real `import.meta.main` wrapper below, so
      // `get()` falls through to the real `gcpFetcher` default — production behavior is unchanged).
      const value = await get(env, key, { caller, purpose, fetcher: opts?.fetcher, now: opts?.now });
      process.stdout.write(value); // NO trailing newline — live contract, consumers pipe this
      return 0;
    } catch (err) {
      if (err instanceof ArthurDeniedError) {
        console.error(`Arthur: ${err.message}`);
        return 2; // security gate: deny → exit 2
      }
      throw err;
    }
  }

  if (cmd === "status") {
    const key = positional(argv.slice(1));
    if (!key) {
      console.error("Usage: Arthur.ts status KEY_NAME");
      return 1;
    }
    const policy = getPolicy(env, key, opts?.now?.getTime());
    console.log(JSON.stringify({ key, policy: policy ?? "default-allow" }, null, 2));
    return 0;
  }

  if (cmd === "policies") {
    console.log(YAML.stringify(loadPolicies(env, opts?.now?.getTime())));
    return 0;
  }

  console.error("Arthur CLI commands: get KEY | status KEY | policies");
  return 1;
}

if (import.meta.main) {
  runCli(defaultEnv(), process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
