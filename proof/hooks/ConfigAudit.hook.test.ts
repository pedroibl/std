import { describe, expect, test } from "bun:test";

import { buildEvent, diffSettings } from "./ConfigAudit.hook";

const HOOK = `${import.meta.dir}/ConfigAudit.hook.ts`;

/** Run the hook as the harness would — `bun ConfigAudit.hook.ts` with `input` piped to stdin. */
async function fire(input: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

describe("diffSettings — pure top-level + one-level-deep diff (sentinels preserved verbatim)", () => {
  test("empty snapshot → 'initial' sentinel", () => {
    const r = diffSettings({}, { a: 1 });
    expect(r.changedKeys).toEqual(["initial"]);
    expect(r.summary).toBe("initial snapshot (no prior to diff)");
  });

  test("identical objects → 'unchanged' sentinel", () => {
    const r = diffSettings({ a: 1, b: { x: 1 } }, { a: 1, b: { x: 1 } });
    expect(r.changedKeys).toEqual(["unchanged"]);
    expect(r.summary).toBe("no diff detected (possible race)");
  });

  test("top-level key added", () => {
    const r = diffSettings({ a: 1 }, { a: 1, b: 2 });
    expect(r.changedKeys).toEqual(["b"]);
    expect(r.summary).toBe("b: added");
  });

  test("top-level key removed", () => {
    const r = diffSettings({ a: 1, b: 2 }, { a: 1 });
    expect(r.changedKeys).toEqual(["b"]);
    expect(r.summary).toBe("b: removed");
  });

  test("primitive value change → truncated newStr (→ form)", () => {
    const r = diffSettings({ model: "opus" }, { model: "sonnet" });
    expect(r.changedKeys).toEqual(["model"]);
    expect(r.summary).toBe('model: → "sonnet"');
  });

  test("nested object change ≤3 sub-keys → {sub} modified", () => {
    const r = diffSettings(
      { permissions: { allow: [], deny: [] } },
      { permissions: { allow: ["x"], deny: [] } },
    );
    expect(r.changedKeys).toEqual(["permissions"]);
    expect(r.summary).toBe("permissions.{allow}: modified");
  });

  test("nested object change >3 sub-keys → count summary", () => {
    const r = diffSettings(
      { env: { A: 0, B: 0, C: 0, D: 0 } },
      { env: { A: 1, B: 1, C: 1, D: 1 } },
    );
    expect(r.changedKeys).toEqual(["env"]);
    expect(r.summary).toBe("env: 4 sub-keys modified");
  });
});

describe("buildEvent — pure event shaping (P3 isoOffset + frozen event shape)", () => {
  test("stamps a tz-offset ISO timestamp and preserves the 6-field shape", () => {
    const event = buildEvent(
      { session_id: "s-42", transcript_path: "", hook_event_name: "ConfigChange", config_path: "settings.json" },
      ["permissions", "hooks"],
      "permissions: added; hooks: added",
      new Date("2026-07-13T15:00:00Z"),
      "Australia/Melbourne",
    );
    // P3 assertion: UTC → Melbourne AEST (+10:00), day rolls over.
    expect(event.timestamp).toBe("2026-07-14T01:00:00+10:00");
    expect(event.event).toBe("config_change");
    expect(event.session_id).toBe("s-42");
    expect(event.config_path).toBe("settings.json");
    expect(event.config_key).toBe("permissions,hooks");
    expect(event.change_summary).toBe("permissions: added; hooks: added");
    expect(Object.keys(event)).toEqual([
      "timestamp", "event", "session_id", "config_path", "config_key", "change_summary",
    ]);
  });

  test("config_path defaults to settings.json when absent", () => {
    const event = buildEvent(
      { session_id: "s-1", transcript_path: "", hook_event_name: "ConfigChange" },
      ["initial"],
      "initial snapshot (no prior to diff)",
      new Date("2026-07-13T15:00:00Z"),
      "Australia/Melbourne",
    );
    expect(event.config_path).toBe("settings.json");
  });
});

describe("fail-open posture (AD-9.4 Rule 2 — PRESERVED) — null stdin → exit 0", () => {
  test("empty stdin → exit 0 before any write", async () => {
    const { code } = await fire("");
    expect(code).toBe(0);
  });

  test("malformed JSON stdin → exit 0, std imports resolved (single exit flushes past the await)", async () => {
    const { code, stderr } = await fire("{not json");
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
  });
});
