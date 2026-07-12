import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNdjson } from "std/core";
import {
  defaultConfig,
  parseArgs,
  buildProposal,
  enqueue,
  main,
  type Proposal,
  type ProposeConfig,
} from "./propose-current-state-entry";

let dir: string;
let queueFile: string;

function cfg(overrides: Partial<ProposeConfig> = {}): ProposeConfig {
  return {
    queueFile,
    allowedSources: ["lifelog", "calendar", "gmail", "homebridge", "manual", "amazon", "bills"],
    allowedTargets: ["CONSUMPTION", "ACTIVITY", "SOCIAL", "FINANCIAL", "SIGNALS", "SNAPSHOT"],
    now: new Date("2026-07-12T03:04:05.678Z"),
    makeId: () => "fixed-id-0001",
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "propose-cs-"));
  queueFile = join(dir, "sub", "CURRENT_STATE", "proposals.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseArgs", () => {
  test("parses valid --source/--target/--json (space form)", () => {
    const r = parseArgs(
      ["--source", "lifelog", "--target", "CONSUMPTION", "--json", '{"name":"Papaya Thai"}'],
      cfg(),
    );
    expect(r).toEqual({ ok: true, source: "lifelog", target: "CONSUMPTION", payload: { name: "Papaya Thai" } });
  });

  test("accepts the --flag=value form (flagValue leniency)", () => {
    const r = parseArgs(["--source=manual", "--target=SIGNALS", "--json={\"k\":1}"], cfg());
    expect(r).toEqual({ ok: true, source: "manual", target: "SIGNALS", payload: { k: 1 } });
  });

  test("missing flags → required-flags message", () => {
    const r = parseArgs(["--source", "lifelog"], cfg());
    expect(r).toEqual({
      ok: false,
      message: "Required flags: --source <src> --target <TARGET_FILE> --json '<payload>'",
    });
  });

  test("bad source → must-be-one-of message with the caller vocab", () => {
    const r = parseArgs(["--source", "twitter", "--target", "SOCIAL", "--json", "{}"], cfg());
    expect(r).toEqual({
      ok: false,
      message: "source must be one of: lifelog, calendar, gmail, homebridge, manual, amazon, bills",
    });
  });

  test("bad target → must-be-one-of message", () => {
    const r = parseArgs(["--source", "gmail", "--target", "NOPE", "--json", "{}"], cfg());
    expect(r).toEqual({
      ok: false,
      message: "target must be one of: CONSUMPTION, ACTIVITY, SOCIAL, FINANCIAL, SIGNALS, SNAPSHOT",
    });
  });

  test("invalid JSON payload → invalid-payload message", () => {
    const r = parseArgs(["--source", "bills", "--target", "FINANCIAL", "--json", "{not-json"], cfg());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.startsWith("Invalid JSON payload:")).toBe(true);
  });
});

describe("buildProposal", () => {
  test("stamps a frozen-shape pending record with injected id + full ISO timestamp", () => {
    const p = buildProposal("calendar", "ACTIVITY", { title: "gym" }, cfg());
    expect(p).toEqual({
      id: "fixed-id-0001",
      timestamp: "2026-07-12T03:04:05.678Z",
      source: "calendar",
      target: "ACTIVITY",
      payload: { title: "gym" },
      status: "pending",
    });
  });
});

describe("enqueue — NDJSON queue framing", () => {
  test("creates the dir and appends one object per line, each newline-terminated", () => {
    const p: Proposal = {
      id: "a",
      timestamp: "2026-07-12T00:00:00.000Z",
      source: "manual",
      target: "SNAPSHOT",
      payload: { x: 1 },
      status: "pending",
    };
    enqueue(queueFile, p);
    const raw = readFileSync(queueFile, "utf-8");
    expect(raw).toBe(JSON.stringify(p) + "\n");
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("appends without clobbering prior records (never loses a record)", () => {
    enqueue(queueFile, buildProposal("manual", "SIGNALS", { n: 1 }, cfg({ makeId: () => "id-1" })));
    enqueue(queueFile, buildProposal("manual", "SIGNALS", { n: 2 }, cfg({ makeId: () => "id-2" })));
    const rows = parseNdjson<Proposal>(readFileSync(queueFile, "utf-8"));
    expect(rows.map((r) => r.id)).toEqual(["id-1", "id-2"]);
  });
});

describe("main — end to end", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  test("propose → read queue back via parseNdjson → frozen record shape + pending + framing", () => {
    const code = main(
      ["--source", "lifelog", "--target", "CONSUMPTION", "--json", '{"category":"restaurant","name":"Papaya Thai"}'],
      cfg(),
    );
    expect(code).toBe(0);
    expect(existsSync(queueFile)).toBe(true);

    const raw = readFileSync(queueFile, "utf-8");
    expect(raw.endsWith("\n")).toBe(true); // append framing

    const rows = parseNdjson<Proposal>(raw);
    expect(rows).toHaveLength(1);
    const rec = rows[0];
    expect(Object.keys(rec).sort()).toEqual(
      ["id", "payload", "source", "status", "target", "timestamp"].sort(),
    );
    expect(rec.status).toBe("pending");
    expect(rec.id).toBe("fixed-id-0001");
    expect(rec.timestamp).toBe("2026-07-12T03:04:05.678Z");
    expect(rec.source).toBe("lifelog");
    expect(rec.target).toBe("CONSUMPTION");
    expect(rec.payload).toEqual({ category: "restaurant", name: "Papaya Thai" });
  });

  test("preserves the success stdout bytes", () => {
    main(["--source", "manual", "--target", "SNAPSHOT", "--json", "{}"], cfg());
    expect(logSpy).toHaveBeenCalledWith("✅ Proposal fixed-id-0001 enqueued (manual → SNAPSHOT)");
    expect(logSpy).toHaveBeenCalledWith("Review with: bun ApproveCurrentStateEntries.ts --review");
  });

  test("validation failure → exit 1, message on stderr, no queue file written", () => {
    const code = main(["--source", "lifelog"], cfg());
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      "Required flags: --source <src> --target <TARGET_FILE> --json '<payload>'",
    );
    expect(existsSync(queueFile)).toBe(false);
  });
});

describe("RT-2 framework-dir resolution (AD-9.3)", () => {
  // NOTE: the ambient shell may export a real PAI_DIR (live PAI). Every test MUST control
  // LIFEOS_DIR + PAI_DIR + HOME explicitly and restore them, or the ambient env leaks in.
  const KEYS = ["LIFEOS_DIR", "PAI_DIR", "HOME"] as const;
  const SUB = ["USER", "TELOS", "CURRENT_STATE", "proposals.jsonl"] as const;
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
    expect(defaultConfig().queueFile).toBe(join("/life", ...SUB));
  });

  test("PAI_DIR honored when LIFEOS_DIR unset (transition window)", () => {
    delete process.env.LIFEOS_DIR;
    process.env.PAI_DIR = "/pai";
    expect(defaultConfig().queueFile).toBe(join("/pai", ...SUB));
  });

  test("neither env set → resolver falls back to LIFEOS under a fresh temp home", () => {
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    const home = mkdtempSync(join(tmpdir(), "rt2-"));
    process.env.HOME = home;
    try {
      expect(defaultConfig().queueFile).toBe(join(home, ".claude", "LIFEOS", ...SUB));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("legacy PAI tree present → resolver picks PAI", () => {
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    const home = mkdtempSync(join(tmpdir(), "rt2-"));
    mkdirSync(join(home, ".claude", "PAI"), { recursive: true });
    process.env.HOME = home;
    try {
      expect(defaultConfig().queueFile).toBe(join(home, ".claude", "PAI", ...SUB));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
