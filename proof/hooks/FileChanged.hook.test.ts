import { describe, expect, test } from "bun:test";

import { buildRecord, isWatched } from "./FileChanged.hook";

const HOOK = `${import.meta.dir}/FileChanged.hook.ts`;

/** Run the hook as the harness would — `bun FileChanged.hook.ts` with `input` piped to stdin. */
async function fire(input: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

describe("isWatched — the watched-pattern gate (only watched files logged)", () => {
  test("matches the 5 watched patterns", () => {
    expect(isWatched("/x/settings.json")).toBe(true);
    expect(isWatched("/x/settings.local.json")).toBe(true);
    expect(isWatched("/x/CLAUDE.md")).toBe(true);
    expect(isWatched("/x/CONTEXT_ROUTING.md")).toBe(true);
    expect(isWatched("/x/Algorithm/v6.3.0.md")).toBe(true);
  });
  test("ignores unwatched files", () => {
    expect(isWatched("/x/notes.md")).toBe(false);
    expect(isWatched("/x/settings.yaml")).toBe(false);
    expect(isWatched("")).toBe(false);
  });
});

describe("buildRecord — pure record shaping (P3 isoOffset + preserved shape)", () => {
  test("stamps a tz-offset ISO ts and preserves {ts,event,file}", () => {
    const r = buildRecord("/x/CLAUDE.md", new Date("2026-07-13T15:00:00Z"), "Australia/Melbourne");
    expect(r.ts).toBe("2026-07-14T01:00:00+10:00"); // AEST +10:00, day rolls over — the UTC→offset delta
    expect(r.event).toBe("FileChanged");
    expect(r.file).toBe("/x/CLAUDE.md");
  });
});

describe("fail-open posture (AD-9.4 Rule 2 — the posture CORRECTION) — null → exit 0", () => {
  // The original fail-CLOSED (sync parse crashed on bad stdin). The rewrite exits 0 BEFORE any write.
  test("empty stdin → exit 0 (was a crash)", async () => {
    const { code } = await fire("");
    expect(code).toBe(0);
  });
  test("malformed JSON stdin → exit 0 (was a crash), std imports resolved", async () => {
    const { code, stderr } = await fire("{not json");
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
  });
});
