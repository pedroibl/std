import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { iscSummary, titleSlug } from "./WorkCompletionLearning.hook";

const HOOK = `${import.meta.dir}/WorkCompletionLearning.hook.ts`;

/** Fire the hook with `input` on stdin and `PAI_DIR` pointed at an empty tree (no active work). */
async function fire(input: string, paiDir: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PAI_DIR: paiDir },
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

describe("titleSlug — std/core slugify(,30) (DISCLOSED delta vs the old hand-roll)", () => {
  test("emoji-led + trailing-punctuation 13.N title: emoji dropped, '.' dropped → '133', '-' trimmed", () => {
    // Old hand-roll (toLowerCase/[^a-z0-9]+→-/slice) → "-story-13-3-done" (leading '-', '.'→'-').
    // std/core slugify → "story-133-done": drops the emoji + the '.', trims the leading '-'. Intentional.
    expect(titleSlug("🏁 Story 13.3 DONE.")).toBe("story-133-done");
  });

  test("plain title slugifies conventionally and caps at 30", () => {
    expect(titleSlug("Refactor the memory cluster")).toBe("refactor-the-memory-cluster");
    expect(titleSlug("x".repeat(50)).length).toBeLessThanOrEqual(30);
  });
});

describe("iscSummary — std/core extractSection (H1 boundary caveat, tested BOTH ways)", () => {
  test("H2-only ISA (the live shape): counts checkboxes up to the next H2, excludes later sections", () => {
    const isa = `# Work Title
## IDEAL STATE CRITERIA
- [x] one
- [x] two
- [ ] three
## Next Section
- [x] not counted
`;
    // Live ISAs are H2-only (verified: no intervening H1) → count is identical to the old H2-only regex.
    expect(iscSummary(isa)).toBe("**ISC:** 2/3 criteria passing");
  });

  test("intervening H1 (does NOT occur in live ISAs) — extractSection stops at the shallower H1", () => {
    const isa = `# Work Title
## IDEAL STATE CRITERIA
- [x] one
# Intervening H1
- [x] two
## Next
`;
    // same-or-shallower boundary stops at the H1 → body = "- [x] one" → 1/1. (The old H2-only regex would
    // have captured through to "## Next" → 2/2.) Documented caveat; never hit because live ISAs are H2-only.
    expect(iscSummary(isa)).toBe("**ISC:** 1/1 criteria passing");
  });

  test("absent section → '' ; section with no checkboxes → ''", () => {
    expect(iscSummary("# Title\n## Other\n- [x] x\n")).toBe("");
    expect(iscSummary("## IDEAL STATE CRITERIA\nprose, no boxes\n## Next\n")).toBe("");
  });
});

describe("fail-OPEN posture (AD-9.4 Rule 2) — UNIQUE null action: PROCEED, not exit-0-on-null", () => {
  test("empty stdin → PROCEEDS to the disk check (No active work session), exits 0, std import resolved", async () => {
    const empty = mkdtempSync(join(tmpdir(), "wcl-"));
    const { code, stderr } = await fire("", empty);
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
    // The distinguishing assertion: null stdin did NOT exit at a guard — it PROCEEDED to findStateFile,
    // which found no state → this message. An `if (!data) exit 0` would never reach it.
    expect(stderr).toContain("No active work session");
    rmSync(empty, { recursive: true, force: true });
  });
});
