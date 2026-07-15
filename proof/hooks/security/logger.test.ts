// logger.test.ts — locks the Story-13.6 fs → std/fsx.atomicWrite swap: logSecurityEvent still writes the
// event to MEMORY/SECURITY/YYYY/MM/ with the SAME byte content (JSON.stringify(event, null, 2), no trailing
// newline). paiPath is resolved at CALL time (not module load), so a plain PAI_DIR set suffices — no
// cache-busting import needed. slugify/timestamp are NOT swapped (validators E2/N-a) — this test also pins
// that the filename keeps the word-cap slug + YYYYMMDD-HHMMSS stamp shape.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecurityEvent } from "./types";
import { logSecurityEvent } from "./logger";

let root = "";
const savedPaiDir = process.env.PAI_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sec-logger-"));
  process.env.PAI_DIR = root;
});
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (savedPaiDir === undefined) delete process.env.PAI_DIR;
  else process.env.PAI_DIR = savedPaiDir;
});

const event: SecurityEvent = {
  timestamp: "2026-07-16T00:00:00.000Z",
  sessionId: "sess-1",
  eventType: "block",
  inspector: "PatternInspector",
  tool: "Bash",
  target: "rm -rf /etc",
  reason: "Zero access path: /etc",
  actionTaken: "Hard block — exit 2",
};

describe("logSecurityEvent — atomicWrite swap keeps content + path shape", () => {
  test("writes a security-block-*.jsonl file with byte-identical JSON content", () => {
    logSecurityEvent(event);

    // Walk temp/MEMORY/SECURITY recursively to find the written file.
    const secRoot = join(root, "MEMORY", "SECURITY");
    const files = readdirSync(secRoot, { recursive: true }) as string[];
    const rel = files.find((f) => typeof f === "string" && f.endsWith(".jsonl"));
    expect(rel).toBeDefined();

    const abs = join(secRoot, rel as string);
    const content = readFileSync(abs, "utf-8");
    // The exact byte content atomicWrite must reproduce (no added newline).
    expect(content).toBe(JSON.stringify(event, null, 2));

    // Filename shape: security-<eventType>-<slug>-<YYYYMMDD-HHMMSS>.jsonl (slug is word-capped, NOT char).
    const base = (rel as string).split("/").pop() as string;
    expect(base).toMatch(/^security-block-.+-\d{8}-\d{6}\.jsonl$/);
  });

  test("a logging failure never throws (posture: must not block operations)", () => {
    // Point PAI_DIR at a path whose parent is a file → mkdir fails → the try/catch swallows it.
    process.env.PAI_DIR = "/dev/null/cannot/mkdir/here";
    expect(() => logSecurityEvent(event)).not.toThrow();
  });
});
