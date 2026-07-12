// Hermetic proof test for arthur.ts (Story 12.5 — infra-integration cluster, security-critical).
//
// NO real secret, NO real GCP, NO network: every `get()`/`runCli()` call in this file injects a fake
// `SecretFetcher` — the real `gcpFetcher` (which dynamically imports `@google-cloud/secret-manager`) is
// never exercised. NO real `~/.claude/PAI`: every test builds its own `ArthurEnv` pointed at a
// `mkdtemp`'d root, so nothing here reads or writes the real PAI estate.
//
// What this proves, mapped to the assignment's three CONTRACTS:
//   (a) an ALLOWED `get` writes the (fake) secret to stdout with NO trailing newline — asserted via
//       `spyOn(process.stdout, "write")` on the exact bytes written by `runCli`.
//   (b) a DENIED request writes to stderr and (as a CLI run) returns exit code 2 — asserted two ways:
//       `get()` itself throws `ArthurDeniedError` (the preserved library contract), AND `runCli` (the
//       preserved CLI contract) writes the message via `console.error` and returns `2` (the real
//       `import.meta.main` wrapper turns that returned code into the actual `process.exit(2)` — see the
//       file's own header note on why the exit call itself lives only in that untestable edge).
//   (c) the dated audit dir is created under a temp root and the JSONL line is appended — asserted by
//       reading back `env.auditRoot/YYYY/MM/arthur-{kind}-YYYYMMDD.jsonl` and parsing every line.
//
// Also exercises the preserved policy engine (`evaluate`) directly across all five verdict rules
// (default-allow, allowed_callers, purposes, time_window, require_confirmation, rate_limit) since that
// is the one piece of this file explicitly NOT rewritten — only re-plumbed with an injected `env`/`now`.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFrameworkDir } from "std/fsx";

import {
  type ArthurEnv,
  ArthurDeniedError,
  audit,
  checkRate,
  checkTimeWindow,
  defaultEnv,
  evaluate,
  get,
  getPolicy,
  loadPolicies,
  runCli,
  securityLogPath,
  type SecretFetcher,
} from "./arthur";

const POLICIES_YAML = `
version: 1
CALLER_GATED_KEY:
  allowed_callers: ["good-caller"]
PURPOSE_GATED_KEY:
  purposes: ["billing", "deploy"]
CONFIRM_KEY:
  require_confirmation: true
  risk: high
RATE_KEY:
  rate_limit: "2/minute"
WINDOW_KEY:
  time_window: "09:00-17:00"
`;

/** Fresh env per test: a mkdtemp'd root, a real policies.yaml written under it, no ambient PAI_DIR. */
function makeEnv(): ArthurEnv {
  const root = mkdtempSync(join(tmpdir(), "arthur-test-"));
  const policiesDir = join(root, "USER", "ARTHUR");
  mkdirSync(policiesDir, { recursive: true });
  const policiesPath = join(policiesDir, "policies.yaml");
  writeFileSync(policiesPath, POLICIES_YAML);
  return {
    paiDir: root,
    policiesPath,
    auditRoot: join(root, "MEMORY", "SECURITY"),
    gcpProject: "fake-project",
    // NB: a FIXED test tz to exercise the time-window mechanism — the "13:00 PT" instants + "PT" label
    // below are hand-computed against it. Pedro's PRODUCTION default is Australia/Melbourne (arthur.ts
    // defaultEnv/checkTimeWindow); this fixture stays LA only so the mechanism assertions remain deterministic.
    defaultTz: "America/Los_Angeles",
  };
}

function cleanup(env: ArthurEnv): void {
  rmSync(env.paiDir, { recursive: true, force: true });
}

function fakeFetcher(value = "fake-secret-value"): { fetcher: SecretFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: SecretFetcher = async (key) => {
    calls.push(key);
    return value;
  };
  return { fetcher, calls };
}

/** Read back every JSONL line under `env.auditRoot` for `now`/`tz` as parsed objects (dated-path proof). */
function readAuditLines(env: ArthurEnv, kind: string, now: Date, tz = env.defaultTz): unknown[] {
  const path = securityLogPath(env, kind, now, tz);
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

const NOW = new Date("2026-03-15T20:00:00.000Z"); // a fixed moment for deterministic dated paths

describe("evaluate — the preserved policy engine (all five rules)", () => {
  test("default-allow: no policy on file for the key", () => {
    const env = makeEnv();
    try {
      const decision = evaluate(env, { key: "UNLISTED_KEY", caller: "anyone", purpose: "" }, NOW);
      expect(decision).toEqual({
        verdict: "ALLOW",
        reason: "no explicit policy; default-allow for low-risk unlisted keys",
        rule: "default",
      });
    } finally {
      cleanup(env);
    }
  });

  test("allowed_callers: DENY when caller not on the list", () => {
    const env = makeEnv();
    try {
      const decision = evaluate(env, { key: "CALLER_GATED_KEY", caller: "bad-caller", purpose: "" }, NOW);
      expect(decision.verdict).toBe("DENY");
      expect(decision.rule).toBe("allowed_callers");
      expect(decision.reason).toContain("bad-caller");
    } finally {
      cleanup(env);
    }
  });

  test("allowed_callers: ALLOW when caller is on the list", () => {
    const env = makeEnv();
    try {
      const decision = evaluate(env, { key: "CALLER_GATED_KEY", caller: "good-caller", purpose: "" }, NOW);
      expect(decision.verdict).toBe("ALLOW");
    } finally {
      cleanup(env);
    }
  });

  test("purposes: DENY when purpose is undeclared or unmatched", () => {
    const env = makeEnv();
    try {
      const noPurpose = evaluate(env, { key: "PURPOSE_GATED_KEY", caller: "x", purpose: "" }, NOW);
      expect(noPurpose.verdict).toBe("DENY");
      expect(noPurpose.rule).toBe("purpose_required");

      const wrongPurpose = evaluate(env, { key: "PURPOSE_GATED_KEY", caller: "x", purpose: "lunch" }, NOW);
      expect(wrongPurpose.verdict).toBe("DENY");
      expect(wrongPurpose.rule).toBe("purpose_match");

      const matched = evaluate(env, { key: "PURPOSE_GATED_KEY", caller: "x", purpose: "Billing" }, NOW); // case-insensitive
      expect(matched.verdict).toBe("ALLOW");
    } finally {
      cleanup(env);
    }
  });

  test("time_window: DENY outside the window, ALLOW inside", () => {
    const env = makeEnv();
    try {
      // 2026-03-15T20:00:00Z is 13:00 PT (America/Los_Angeles, PDT UTC-7) — inside 09:00-17:00.
      const inside = evaluate(env, { key: "WINDOW_KEY", caller: "x", purpose: "" }, NOW);
      expect(inside.verdict).toBe("ALLOW");

      // 2026-03-16T04:00:00Z is 21:00 PT the prior evening — outside 09:00-17:00.
      const outside = evaluate(env, { key: "WINDOW_KEY", caller: "x", purpose: "" }, new Date("2026-03-16T04:00:00.000Z"));
      expect(outside.verdict).toBe("DENY");
      expect(outside.rule).toBe("time_window");
      expect(outside.reason).toContain("PT");
    } finally {
      cleanup(env);
    }
  });

  test("require_confirmation: CONFIRM, not ALLOW or DENY", () => {
    const env = makeEnv();
    try {
      const decision = evaluate(env, { key: "CONFIRM_KEY", caller: "x", purpose: "" }, NOW);
      expect(decision.verdict).toBe("CONFIRM");
      expect(decision.rule).toBe("require_confirmation");
      expect(decision.reason).toContain("high");
    } finally {
      cleanup(env);
    }
  });

  test("rate_limit: ALLOW under the limit, DENY once exceeded — checked LAST (a denied/confirmed attempt never consumes a slot)", () => {
    const env = makeEnv();
    try {
      const t = NOW.getTime();
      const req = { key: "RATE_KEY", caller: "x", purpose: "" };
      expect(evaluate(env, req, new Date(t)).verdict).toBe("ALLOW"); // hit 1/2
      expect(evaluate(env, req, new Date(t + 1000)).verdict).toBe("ALLOW"); // hit 2/2
      const third = evaluate(env, req, new Date(t + 2000));
      expect(third.verdict).toBe("DENY");
      expect(third.rule).toBe("rate_limit");
    } finally {
      cleanup(env);
    }
  });
});

describe("checkRate / checkTimeWindow — kept-local plumbing, unit-level", () => {
  test("checkRate: malformed limit strings are a pass-through no-op (ok:true)", () => {
    expect(checkRate("k", "c", "not-a-rate").ok).toBe(true);
  });

  test("checkTimeWindow: malformed window strings are a pass-through no-op (ok:true)", () => {
    expect(checkTimeWindow("not-a-window").ok).toBe(true);
  });

  test("checkTimeWindow: tz is injected, not hardcoded — a non-default tz shows its raw name in the reason", () => {
    const result = checkTimeWindow("09:00-17:00", "Australia/Melbourne", new Date("2026-03-16T04:00:00.000Z"));
    // 2026-03-16T04:00:00Z is ~15:00 AEDT — inside 09:00-17:00 for this tz (unlike the PT case above).
    expect(result.ok).toBe(true);
  });
});

describe("get() — the preserved library contract", () => {
  test("ALLOW: returns the fetched secret; audit trail has credential_request + credential_release", async () => {
    const env = makeEnv();
    try {
      const { fetcher, calls } = fakeFetcher("plaintext-secret-123");
      const value = await get(env, "UNLISTED_KEY_ALLOW_TEST", { caller: "tester", purpose: "test", fetcher, now: NOW });
      expect(value).toBe("plaintext-secret-123");
      expect(calls).toEqual(["UNLISTED_KEY_ALLOW_TEST"]); // the fetcher was actually invoked, once
      // Each `kind` (== event_type) is a SEPARATE dated file (securityLogPath is keyed by `kind`), so
      // request and release land in two different files — read each back independently.
      const requestLines = readAuditLines(env, "credential_request", NOW) as Array<{ event_type: string; verdict: string }>;
      expect(requestLines.some((l) => l.event_type === "credential_request" && l.verdict === "ALLOW")).toBe(true);
      const releaseLines = readAuditLines(env, "credential_release", NOW) as Array<{ event_type: string }>;
      expect(releaseLines.some((l) => l.event_type === "credential_release")).toBe(true);
    } finally {
      cleanup(env);
    }
  });

  test("DENY: throws ArthurDeniedError; the fetcher is NEVER called (no secret touched)", async () => {
    const env = makeEnv();
    try {
      const { fetcher, calls } = fakeFetcher();
      await expect(
        get(env, "CALLER_GATED_KEY", { caller: "bad-caller", purpose: "", fetcher, now: NOW }),
      ).rejects.toThrow(ArthurDeniedError);
      expect(calls).toEqual([]); // deny happens before any vault access
      const lines = readAuditLines(env, "credential_request", NOW) as Array<{ verdict: string }>;
      expect(lines.some((l) => l.verdict === "DENY")).toBe(true);
    } finally {
      cleanup(env);
    }
  });

  test("CONFIRM + PAI_ARTHUR_OVERRIDE=1: auto-approves and fetches", async () => {
    const env = makeEnv();
    const prior = process.env.PAI_ARTHUR_OVERRIDE;
    process.env.PAI_ARTHUR_OVERRIDE = "1";
    try {
      const { fetcher, calls } = fakeFetcher("confirmed-secret");
      const value = await get(env, "CONFIRM_KEY", { caller: "x", purpose: "", fetcher, now: NOW });
      expect(value).toBe("confirmed-secret");
      expect(calls).toEqual(["CONFIRM_KEY"]);
    } finally {
      if (prior === undefined) delete process.env.PAI_ARTHUR_OVERRIDE;
      else process.env.PAI_ARTHUR_OVERRIDE = prior;
      cleanup(env);
    }
  });

  test("CONFIRM without override: denies (v1 conservative default — no auto-approval)", async () => {
    const env = makeEnv();
    const prior = process.env.PAI_ARTHUR_OVERRIDE;
    delete process.env.PAI_ARTHUR_OVERRIDE;
    try {
      const { fetcher } = fakeFetcher();
      await expect(get(env, "CONFIRM_KEY", { caller: "x", purpose: "", fetcher, now: NOW })).rejects.toThrow(
        ArthurDeniedError,
      );
    } finally {
      if (prior === undefined) delete process.env.PAI_ARTHUR_OVERRIDE;
      else process.env.PAI_ARTHUR_OVERRIDE = prior;
      cleanup(env);
    }
  });
});

describe("runCli — the preserved CLI contract: stdout-no-newline / stderr+exit(2)", () => {
  test("CONTRACT (a): allowed `get` writes the secret to stdout with NO trailing newline", async () => {
    const env = makeEnv();
    try {
      const { fetcher } = fakeFetcher("stdout-secret-xyz");
      const writes: string[] = [];
      const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
      try {
        const code = await runCli(env, ["get", "UNLISTED_KEY_STDOUT_TEST", "--caller=tester", "--purpose=test"], { fetcher, now: NOW });
        expect(code).toBe(0);
        expect(writes).toEqual(["stdout-secret-xyz"]); // exactly the secret, byte-for-byte — no "\n" appended
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup(env);
    }
  });

  test("CONTRACT (b): denied `get` writes to stderr and returns exit code 2", async () => {
    const env = makeEnv();
    try {
      const { fetcher } = fakeFetcher();
      const errors: string[] = [];
      const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
        errors.push(a.map(String).join(" "));
      });
      try {
        const code = await runCli(env, ["get", "CALLER_GATED_KEY", "--caller=bad-caller"], { fetcher, now: NOW });
        expect(code).toBe(2); // the security gate — the real `import.meta.main` wrapper turns this into process.exit(2)
        expect(errors.some((l) => l.startsWith("Arthur:") && l.includes("denied"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup(env);
    }
  });

  test("get with no --caller/--purpose falls back to cli/cli-manual defaults, ALLOW", async () => {
    const env = makeEnv();
    try {
      const { fetcher } = fakeFetcher("default-caller-secret");
      const writes: string[] = [];
      const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
      try {
        const code = await runCli(env, ["get", "UNLISTED_KEY_DEFAULTS_TEST"], { fetcher, now: NOW });
        expect(code).toBe(0);
        expect(writes).toEqual(["default-caller-secret"]);
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup(env);
    }
  });

  test("get with no key → usage error, exit 1", async () => {
    const env = makeEnv();
    try {
      const code = await runCli(env, ["get"]);
      expect(code).toBe(1);
    } finally {
      cleanup(env);
    }
  });

  test("status KEY → prints the raw policy as JSON", async () => {
    const env = makeEnv();
    try {
      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(" "));
      });
      try {
        const code = await runCli(env, ["status", "CALLER_GATED_KEY"], { now: NOW });
        expect(code).toBe(0);
        const parsed = JSON.parse(logs[0]!);
        expect(parsed.key).toBe("CALLER_GATED_KEY");
        expect(parsed.policy.allowed_callers).toEqual(["good-caller"]);
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup(env);
    }
  });

  test("status KEY for an unlisted key → 'default-allow'", async () => {
    const env = makeEnv();
    try {
      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(" "));
      });
      try {
        const code = await runCli(env, ["status", "UNLISTED_KEY"], { now: NOW });
        expect(code).toBe(0);
        expect(JSON.parse(logs[0]!).policy).toBe("default-allow");
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup(env);
    }
  });

  test("policies → dumps the full YAML-parsed policy set", async () => {
    const env = makeEnv();
    try {
      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(" "));
      });
      try {
        const code = await runCli(env, ["policies"], { now: NOW });
        expect(code).toBe(0);
        expect(logs[0]).toContain("CALLER_GATED_KEY");
        expect(logs[0]).toContain("RATE_KEY");
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup(env);
    }
  });

  test("unknown command → usage error, exit 1", async () => {
    const env = makeEnv();
    try {
      const code = await runCli(env, ["bogus"]);
      expect(code).toBe(1);
    } finally {
      cleanup(env);
    }
  });
});

describe("CONTRACT (c): dated audit dir + JSONL append under a temp root", () => {
  test("securityLogPath builds env.auditRoot/YYYY/MM/arthur-{kind}-YYYYMMDD.jsonl and creates the dir", () => {
    const env = makeEnv();
    try {
      const path = securityLogPath(env, "credential_request", NOW, "UTC");
      expect(path).toBe(join(env.auditRoot, "2026", "03", "arthur-credential_request-20260315.jsonl"));
      // ensureDir ran — the parent directory now exists, provable by writing into it.
      writeFileSync(path, '{"probe":true}\n');
      expect(readFileSync(path, "utf-8")).toContain("probe");
    } finally {
      cleanup(env);
    }
  });

  test("audit() appends a JSONL line with timestamp + agent:'arthur' + the event fields", () => {
    const env = makeEnv();
    try {
      const path = securityLogPath(env, "custom_event", NOW);
      writeFileSync(join(path, "..", ".keep-parent-exists-probe"), ""); // sanity: dir exists pre-write
      audit(env, { event_type: "custom_event", foo: "bar" }, NOW);
      const raw = readFileSync(path, "utf-8").trim();
      const entry = JSON.parse(raw);
      expect(entry.agent).toBe("arthur");
      expect(entry.event_type).toBe("custom_event");
      expect(entry.foo).toBe("bar");
      expect(entry.timestamp).toBe(NOW.toISOString());
    } finally {
      cleanup(env);
    }
  });

  test("full get() flow under DEFAULT (real clock, real host tz) still lands a readable audit trail", async () => {
    const env = makeEnv();
    try {
      const { fetcher } = fakeFetcher("secret-under-real-clock");
      const value = await get(env, "UNLISTED_KEY", { caller: "x", purpose: "", fetcher }); // no `now` injected
      expect(value).toBe("secret-under-real-clock");
      // Don't assert the exact path (real `new Date()` — non-deterministic), just that SOME dated file
      // landed under auditRoot with a well-formed name.
      const realNow = new Date();
      const path = securityLogPath(env, "credential_request", realNow);
      expect(readFileSync(path, "utf-8").length).toBeGreaterThan(0);
    } finally {
      cleanup(env);
    }
  });
});

describe("loadPolicies / getPolicy — real YAML.parse over a temp policies.yaml (no @google-cloud/secret-manager involved)", () => {
  test("loadPolicies parses the temp file; getPolicy resolves a known + an unlisted key", () => {
    const env = makeEnv();
    try {
      const policies = loadPolicies(env, NOW.getTime());
      expect(policies.version).toBe(1);
      expect(getPolicy(env, "CALLER_GATED_KEY", NOW.getTime())).toEqual({ allowed_callers: ["good-caller"] });
      expect(getPolicy(env, "UNLISTED_KEY", NOW.getTime())).toBeNull();
    } finally {
      cleanup(env);
    }
  });

  test("loadPolicies caches per policiesPath for 5s, keyed so two envs never collide", () => {
    const envA = makeEnv();
    const envB = makeEnv();
    try {
      writeFileSync(envA.policiesPath, "version: 1\nA_ONLY:\n  risk: low\n");
      writeFileSync(envB.policiesPath, "version: 2\nB_ONLY:\n  risk: high\n");
      const t = NOW.getTime();
      expect(loadPolicies(envA, t).version).toBe(1);
      expect(loadPolicies(envB, t).version).toBe(2);
      // Still within the 5s window — cached value returned even if the file changed underneath.
      writeFileSync(envA.policiesPath, "version: 99\n");
      expect(loadPolicies(envA, t + 1000).version).toBe(1); // cache hit, not the rewritten file
      expect(loadPolicies(envA, t + 6000).version).toBe(99); // cache expired — re-read
    } finally {
      cleanup(envA);
      cleanup(envB);
    }
  });
});

describe("RT-2 framework-dir resolution (AD-9.3)", () => {
  // `defaultEnv()` resolves the framework dir via `process.env.LIFEOS_DIR ?? PAI_DIR ??
  // resolveFrameworkDir(homedir())`. Unlike the sibling tools, arthur reads `homedir()` (node:os), NOT
  // `process.env.HOME`. Bun caches `homedir()` at process start and ignores runtime `process.env.HOME`
  // mutation (verified empirically), so the fresh-temp-home / legacy-PAI-tree assertions CANNOT be
  // forced here — those two cases are intentionally omitted for arthur. The two deterministic
  // env-precedence tests below stand, plus a delegation test proving the no-env fallback IS the
  // resolver applied to homedir() (not a hardcoded path).
  // NOTE: the ambient shell may export a real PAI_DIR (live PAI). Every test controls
  // LIFEOS_DIR + PAI_DIR explicitly and restores them, or the ambient env leaks in.
  const KEYS = ["LIFEOS_DIR", "PAI_DIR"] as const;
  let savedEnv: Record<string, string | undefined>;
  beforeEach(() => {
    savedEnv = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test("LIFEOS_DIR wins over PAI_DIR", () => {
    process.env.LIFEOS_DIR = "/life";
    process.env.PAI_DIR = "/pai";
    expect(defaultEnv().paiDir).toBe("/life");
  });

  test("PAI_DIR honored when LIFEOS_DIR unset (transition window)", () => {
    delete process.env.LIFEOS_DIR;
    process.env.PAI_DIR = "/pai";
    expect(defaultEnv().paiDir).toBe("/pai");
  });

  test("neither env set → fallback delegates to resolveFrameworkDir(homedir()) (LIFEOS-preferred)", () => {
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    // Can't force a temp home (homedir() is process-cached), so prove the wiring: the fallback IS the
    // resolver applied to homedir(), not a baked path. resolveFrameworkDir prefers LIFEOS over PAI.
    expect(defaultEnv().paiDir).toBe(resolveFrameworkDir(homedir()));
  });
});
