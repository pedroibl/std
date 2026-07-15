// PatternInspector.test.ts — locks the two Story-13.6 swaps: (1) config load via std/fsx, and (2) the
// path-glob metachar-escape via std/core escapeRegExp (EN4 equivalence), plus the PRESERVED fail-closed
// deny on a missing patterns file (:200 — the one existing fail-closed site).
//
// Hermetic: a temp PAI_DIR holds a crafted PATTERNS.yaml. The module reads USER_PATTERNS_PATH from paiPath
// at load, so each case re-imports with a cache-busting query to re-evaluate that const under the current
// PAI_DIR (the feature-registry.test idiom). Absolute (non-tilde) patterns avoid any homedir() coupling.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InspectionContext, InspectionResult } from "../types";

let bust = 0;
let root = "";
const savedPaiDir = process.env.PAI_DIR;

function writePatterns(yaml: string): void {
  const dir = join(root, "USER", "SECURITY");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PATTERNS.yaml"), yaml);
}

/** Fresh module eval under the current PAI_DIR — returns an inspector reading the temp PATTERNS.yaml. */
async function freshInspect(ctx: InspectionContext): Promise<InspectionResult> {
  process.env.PAI_DIR = root;
  const mod = await import(`./PatternInspector?bust=${bust++}`);
  return mod.createPatternInspector().inspect(ctx);
}

const write = (filePath: string): InspectionContext => ({
  sessionId: "t",
  toolName: "Write",
  toolInput: { file_path: filePath },
});
const read = (filePath: string): InspectionContext => ({
  sessionId: "t",
  toolName: "Read",
  toolInput: { file_path: filePath },
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pattern-insp-"));
});
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (savedPaiDir === undefined) delete process.env.PAI_DIR;
  else process.env.PAI_DIR = savedPaiDir;
});

describe("PatternInspector — PRESERVED fail-closed (:200, the crux)", () => {
  test("missing patterns file → deny('…fail-closed'), NOT allow", async () => {
    // No PATTERNS.yaml written, and PAI_DIR points at a temp dir with no Patterns.example.yaml either.
    const r = await freshInspect(write("/tmp/anything.txt"));
    expect(r.action).toBe("deny");
    expect(r.reason).toContain("fail-closed");
  });
});

describe("PatternInspector — path glob via escapeRegExp (EN4 equivalence)", () => {
  test("`**` still matches anywhere under the prefix (DOUBLESTAR → .*)", async () => {
    writePatterns(`paths:\n  zeroAccess:\n    - "/tmp/zz-secrets/**"\n`);
    const r = await freshInspect(read("/tmp/zz-secrets/nested/id_rsa"));
    expect(r.action).toBe("deny");
    expect(r.reason).toContain("Zero access");
  });

  test("`*` matches within one segment only (SINGLESTAR → [^/]*)", async () => {
    writePatterns(`paths:\n  zeroAccess:\n    - "/tmp/zz-keys/*.key"\n`);
    const hit = await freshInspect(read("/tmp/zz-keys/prod.key"));
    expect(hit.action).toBe("deny");
    const miss = await freshInspect(read("/tmp/zz-keys/sub/prod.key"));
    expect(miss.action).toBe("allow"); // `*` must NOT cross the `/`
  });

  test("`.` is escaped to a LITERAL dot (the escapeRegExp win over a naive matcher)", async () => {
    writePatterns(`paths:\n  zeroAccess:\n    - "/tmp/zz.secret/**"\n`);
    const literal = await freshInspect(read("/tmp/zz.secret/x"));
    expect(literal.action).toBe("deny"); // literal '.' matches '.'
    const notWildcard = await freshInspect(read("/tmp/zzXsecret/x"));
    expect(notWildcard.action).toBe("allow"); // '.' is NOT a wildcard — 'X' must not match
  });

  test("a non-glob path pattern uses the exact/prefix branch, no regex", async () => {
    writePatterns(`paths:\n  readOnly:\n    - "/tmp/zz-ro"\n`);
    const inside = await freshInspect(write("/tmp/zz-ro/file.txt"));
    expect(inside.action).toBe("deny");
    const outside = await freshInspect(write("/tmp/zz-ro-sibling/file.txt"));
    expect(outside.action).toBe("allow");
  });
});
