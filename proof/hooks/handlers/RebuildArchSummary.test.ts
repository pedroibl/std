import { describe, expect, test } from "bun:test";

import { decideRebuild, isTracked, type RebuildProbe } from "./RebuildArchSummary";

// Hermetic: every probe is injected — no real fs, no spawn. The pure `decideRebuild` carries the
// mtime-newer-than-output trigger; the real-fs lister + spawnCapture wiring live only in the impure shell.

/** Build a RebuildProbe from an in-memory {path → mtime} table + a per-dir tracked-file map. */
function fakeProbe(
  mtimes: Record<string, number>,
  filesByDir: Record<string, string[]> = {},
): RebuildProbe {
  return {
    listTrackedFiles: (dir) => filesByDir[dir] ?? [],
    mtime: (p) => mtimes[p] ?? 0,
    exists: (p) => p in mtimes,
  };
}

const OUTPUT = "/pai/DOCUMENTATION/PAI_ARCHITECTURE_SUMMARY.md";

describe("isTracked — the trackedExtensions predicate (verbatim live quirk)", () => {
  test("accepts the 6 tracked extensions on a basename", () => {
    for (const ext of [".ts", ".md", ".yaml", ".yml", ".sh", ".json"]) {
      expect(isTracked(`/pai/DOCUMENTATION/file${ext}`)).toBe(true);
    }
  });
  test("rejects untracked extensions", () => {
    expect(isTracked("/pai/x/file.txt")).toBe(false);
    expect(isTracked("/pai/x/file.png")).toBe(false);
  });
  test("no-dot basename slices its last char → never a tracked ext (skipped, matches live)", () => {
    expect(isTracked("/pai/Makefile")).toBe(false);
    expect(isTracked("/pai/LICENSE")).toBe(false);
  });
});

describe("decideRebuild — output-missing branch", () => {
  test("output absent → rebuild, reason missing-output, no scan needed", () => {
    const d = decideRebuild(["/pai"], ["/root/CLAUDE.md"], OUTPUT, fakeProbe({}));
    expect(d).toEqual({ rebuild: true, reason: "missing-output", newestFile: "", newestMtime: 0 });
  });
});

describe("decideRebuild — the mtime-newer-than-output trigger", () => {
  test("a tracked-dir file newer than output → rebuild, reason system-changed, newestFile named", () => {
    const changed = "/pai/DOCUMENTATION/HookSystem.md";
    const d = decideRebuild(
      ["/pai/DOCUMENTATION"],
      [],
      OUTPUT,
      fakeProbe(
        { [OUTPUT]: 1000, [changed]: 2000, "/pai/DOCUMENTATION/old.md": 500 },
        { "/pai/DOCUMENTATION": [changed, "/pai/DOCUMENTATION/old.md"] },
      ),
    );
    expect(d.rebuild).toBe(true);
    expect(d.reason).toBe("system-changed");
    expect(d.newestFile).toBe(changed);
    expect(d.newestMtime).toBe(2000);
  });

  test("all tracked files older than output → no rebuild, reason current", () => {
    const d = decideRebuild(
      ["/pai/DOCUMENTATION"],
      [],
      OUTPUT,
      fakeProbe(
        { [OUTPUT]: 5000, "/pai/DOCUMENTATION/a.md": 100, "/pai/DOCUMENTATION/b.ts": 200 },
        { "/pai/DOCUMENTATION": ["/pai/DOCUMENTATION/a.md", "/pai/DOCUMENTATION/b.ts"] },
      ),
    );
    expect(d.rebuild).toBe(false);
    expect(d.reason).toBe("current");
    expect(d.newestFile).toBe("/pai/DOCUMENTATION/b.ts");
    expect(d.newestMtime).toBe(200);
  });

  test("equal mtime is NOT newer (strict > trigger) → current", () => {
    const d = decideRebuild(
      ["/pai/DOCUMENTATION"],
      [],
      OUTPUT,
      fakeProbe(
        { [OUTPUT]: 3000, "/pai/DOCUMENTATION/a.md": 3000 },
        { "/pai/DOCUMENTATION": ["/pai/DOCUMENTATION/a.md"] },
      ),
    );
    expect(d.rebuild).toBe(false);
    expect(d.reason).toBe("current");
  });
});

describe("decideRebuild — the 2 extra files (settings.json / CLAUDE.md)", () => {
  test("an extra file newer than output wins over older tracked-dir files", () => {
    const claude = "/root/CLAUDE.md";
    const d = decideRebuild(
      ["/pai/DOCUMENTATION"],
      ["/root/settings.json", claude],
      OUTPUT,
      fakeProbe(
        { [OUTPUT]: 1000, "/pai/DOCUMENTATION/a.md": 900, "/root/settings.json": 800, [claude]: 4000 },
        { "/pai/DOCUMENTATION": ["/pai/DOCUMENTATION/a.md"] },
      ),
    );
    expect(d.rebuild).toBe(true);
    expect(d.reason).toBe("system-changed");
    expect(d.newestFile).toBe(claude);
    expect(d.newestMtime).toBe(4000);
  });

  test("a missing extra file is skipped, not counted (matches live existsSync guard)", () => {
    const d = decideRebuild(
      [],
      ["/root/settings.json", "/root/CLAUDE.md"],
      OUTPUT,
      // only settings.json exists (older); CLAUDE.md absent from the table → skipped
      fakeProbe({ [OUTPUT]: 1000, "/root/settings.json": 500 }),
    );
    expect(d.rebuild).toBe(false);
    expect(d.reason).toBe("current");
    // settings.json IS present (older than output) → recorded as the newest system file, but not newer
    // than the output → no rebuild. CLAUDE.md is absent → skipped (never counted), matching the live
    // existsSync guard. This mirrors the live control flow, which sets newestSystemFile regardless of
    // whether it ultimately beats the output mtime.
    expect(d.newestFile).toBe("/root/settings.json");
  });
});
