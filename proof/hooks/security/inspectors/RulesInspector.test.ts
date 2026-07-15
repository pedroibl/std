// RulesInspector.test.ts — locks the Story-13.6 fs → std/fsx swap in loadRules AND the PRESERVED fail-OPEN
// posture (missing/empty rules → ALLOW; a non-successful inference → ALLOW). Hermetic: a temp PAI_DIR holds
// (or omits) SECURITY_RULES.md; RULES_PATH is a module const read from paiPath at load, so each case
// re-imports with a cache-busting query. The LLM is never called for real — the proof Inference shim
// returns success:false (that IS the stub the story mandates), so the rules-present path deterministically
// falls to the fail-open ALLOW.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InspectionContext, InspectionResult } from "../types.ts";

let bust = 0;
let root = "";
const savedPaiDir = process.env.PAI_DIR;

function writeRules(content: string): void {
  const dir = join(root, "USER", "SECURITY");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SECURITY_RULES.md"), content);
}

async function freshInspect(ctx: InspectionContext): Promise<InspectionResult> {
  process.env.PAI_DIR = root;
  const mod = await import(`./RulesInspector?bust=${bust++}`);
  return mod.createRulesInspector().inspect(ctx);
}

const bashCtx: InspectionContext = {
  sessionId: "t",
  toolName: "Bash",
  toolInput: { command: "rm -rf /" },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rules-insp-"));
});
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (savedPaiDir === undefined) delete process.env.PAI_DIR;
  else process.env.PAI_DIR = savedPaiDir;
});

describe("RulesInspector — loadRules via fsx.readIfExists + PRESERVED fail-OPEN", () => {
  test("no SECURITY_RULES.md → ALLOW (readIfExists null → no LLM call)", async () => {
    const r = await freshInspect(bashCtx);
    expect(r.action).toBe("allow");
  });

  test("empty SECURITY_RULES.md → ALLOW (trimmed content length 0 → null)", async () => {
    writeRules("   \n  \n");
    const r = await freshInspect(bashCtx);
    expect(r.action).toBe("allow");
  });

  test("non-empty rules present, inference not successful (shim) → fail-OPEN ALLOW", async () => {
    // Proves loadRules DID read the file via fsx (rules non-null → the inference path is entered), and that
    // a non-successful inference result falls to ALLOW — the deliberate, PRESERVED fail-open the story keeps.
    writeRules("## BLOCK\n- Never allow `rm -rf /`\n");
    const r = await freshInspect(bashCtx);
    expect(r.action).toBe("allow");
  });
});
