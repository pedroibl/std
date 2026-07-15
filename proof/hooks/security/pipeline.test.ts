// pipeline.test.ts — pins the PRESERVED chain semantics (verbatim file, no swap; extractTarget keeps its
// raw .slice(0,500) per validator E4 — NOT core.truncate/collapse). Locks: priority ordering, deny
// short-circuit, require_approval accumulation, all-allow → ALLOW, and inspector-throw → skip+continue.
import { describe, expect, test } from "bun:test";
import type { Inspector, InspectionContext, InspectionResult } from "./types";
import { ALLOW, deny, requireApproval } from "./types";
import { InspectorPipeline } from "./pipeline";

const ctx: InspectionContext = { sessionId: "t", toolName: "Bash", toolInput: { command: "echo hi" } };

function stub(name: string, priority: number, result: InspectionResult | (() => never)): Inspector {
  return {
    name,
    priority,
    inspect: () => (typeof result === "function" ? result() : result),
  };
}

describe("InspectorPipeline — PRESERVED chain semantics", () => {
  test("all allow → ALLOW", async () => {
    const p = new InspectorPipeline([stub("a", 100, ALLOW), stub("b", 50, ALLOW)]);
    expect((await p.run(ctx)).action).toBe("allow");
  });

  test("a deny short-circuits and is returned", async () => {
    const p = new InspectorPipeline([stub("a", 100, deny("blocked")), stub("b", 50, ALLOW)]);
    const r = await p.run(ctx);
    expect(r.action).toBe("deny");
    expect(r.reason).toBe("blocked");
  });

  test("require_approval is accumulated when no deny fires", async () => {
    const p = new InspectorPipeline([stub("a", 100, ALLOW), stub("b", 50, requireApproval("confirm?"))]);
    expect((await p.run(ctx)).action).toBe("require_approval");
  });

  test("higher priority runs first (deny from the high-priority inspector wins)", async () => {
    // 'b' would require_approval, but the higher-priority 'a' denies → deny short-circuits before 'b'.
    const p = new InspectorPipeline([stub("b", 50, requireApproval("confirm?")), stub("a", 100, deny("hard"))]);
    expect((await p.run(ctx)).action).toBe("deny");
  });

  test("an inspector that throws is skipped, pipeline continues", async () => {
    const thrower = stub("boom", 100, () => {
      throw new Error("inspector bug");
    });
    const p = new InspectorPipeline([thrower, stub("b", 50, deny("caught after skip"))]);
    const r = await p.run(ctx);
    expect(r.action).toBe("deny");
    expect(r.reason).toBe("caught after skip");
  });
});
