import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as doc from "./doc-check";
import * as ref from "./reference-check";
import { runRefCheck } from "./ref-check";

// ── A hermetic synthetic ~/.claude tree exercising every finding class + parity invariant. ──
// Referrer/target mtimes are pinned so the freshness rule is deterministic (no wall-clock reads).
const REFERRER = new Date("2026-06-01T00:00:00Z"); // Main.md / mod.ts
const OLDER = new Date("2026-05-31T00:00:00Z"); // valid targets — older than referrer → never stale
const NEWER = new Date("2026-06-06T00:00:00Z"); // Stale.md — 5 days newer than referrer → stale

// Main.md: a valid ref, a missing ref, two referenced targets, a FENCED missing ref (skip in
// reference-check, reported in doc-check), and a section-rooted markdown link under `paths under
// \`PAI/USER/\``. Backticks are the ref delimiters + the code fence — safe inside a double-quoted JS string.
const MAIN_MD = [
  "# Main",
  "",
  "Valid: `PAI/DOCUMENTATION/Guide.md`",
  "Missing: `PAI/DOCUMENTATION/Ghost.md`",
  "Points at `PAI/Referenced.md` and `PAI/Stale.md`.",
  "",
  "```example",
  "Fenced: `PAI/DOCUMENTATION/Fenced.md`",
  "```",
  "",
  "## Routing (paths under `PAI/USER/`)",
  "",
  "See [guide](sectioned.md) for section-rooted resolution.",
  "",
].join("\n");

// A .ts referrer: only `from "…"` imports are extracted (ts-narrow); the backtick path in the comment
// must be IGNORED. One import resolves, one is missing.
const MOD_TS = [
  'import { x } from "./sibling.ts";',
  'import { y } from "./ghost.ts";',
  "// see docs at `PAI/DOCUMENTATION/Guide.md` — must NOT be extracted from a .ts file",
  "export const z = 1;",
].join("\n");

function buildTree(): { root: string; env: { claudeDir: string; paiDir: string; hooksDir: string } } {
  const root = mkdtempSync(join(tmpdir(), "std-refcheck-"));
  const claudeDir = join(root, ".claude");
  const paiDir = join(claudeDir, "PAI");
  const hooksDir = join(claudeDir, "hooks");
  mkdirSync(join(paiDir, "DOCUMENTATION"), { recursive: true });
  mkdirSync(join(paiDir, "USER"), { recursive: true });

  const write = (rel: string, body: string) => writeFileSync(join(claudeDir, rel), body);
  write("PAI/Main.md", MAIN_MD);
  // Guide.md references PAI/Main.md so Main.md is not itself an orphan; keeps the orphan set = {Orphan.md}.
  write("PAI/DOCUMENTATION/Guide.md", "# Guide\n\nback to `PAI/Main.md`\n");
  write("PAI/Referenced.md", "# Referenced\n");
  write("PAI/Stale.md", "# Stale\n");
  write("PAI/Orphan.md", "# Orphan — nothing references me\n");
  write("PAI/USER/sectioned.md", "# Sectioned target\n");
  write("PAI/mod.ts", MOD_TS);
  write("PAI/sibling.ts", "export const x = 1;\n");

  // Pin mtimes AFTER writing. Stale.md is newer than its referrer (Main.md); every other target is older.
  const setTime = (rel: string, d: Date) => utimesSync(join(claudeDir, rel), d, d);
  setTime("PAI/Main.md", REFERRER);
  setTime("PAI/mod.ts", REFERRER);
  setTime("PAI/Stale.md", NEWER);
  // Guide.md and Main.md reference each other, so they share Main's mtime — a strict `>` means an equal
  // mtime is never stale in either direction, isolating Stale.md as the sole stale finding.
  setTime("PAI/DOCUMENTATION/Guide.md", REFERRER);
  for (const rel of ["PAI/Referenced.md", "PAI/Orphan.md", "PAI/USER/sectioned.md", "PAI/sibling.ts"]) {
    setTime(rel, OLDER);
  }
  return { root, env: { claudeDir, paiDir, hooksDir } };
}

function inTree(fn: (env: { claudeDir: string; paiDir: string; hooksDir: string }) => void): void {
  const { root, env } = buildTree();
  try {
    fn(env);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Silence a main() invocation's console output; return its exit code. */
function silentMain(fn: () => number): number {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

describe("reference-check mode (superset engine) — findings, envelope, exit codes", () => {
  test("classifies missing / stale / orphan and honors the parity invariants", () => {
    inTree((env) => {
      const result = runRefCheck(ref.buildRefConfig(env, { changedOnly: false, includeStale: true, includeOrphans: true }));
      const envelope = ref.refEnvelope(result, 0);

      const missing = envelope.findings.filter((f) => f.type === "missing").map((f) => f.ref);
      const stale = envelope.findings.filter((f) => f.type === "stale");
      const orphan = envelope.findings.filter((f) => f.type === "orphan").map((f) => f.file);

      // Ghost.md (Main) + ./ghost.ts (mod.ts). Fenced.md is SKIPPED (fence-skip). The backtick path in
      // mod.ts is SKIPPED (ts-narrow). sectioned.md RESOLVES via the `paths under PAI/USER/` section root.
      expect(missing.sort()).toEqual(["./ghost.ts", "PAI/DOCUMENTATION/Ghost.md"]);
      expect(missing).not.toContain("PAI/DOCUMENTATION/Fenced.md"); // fence-skip invariant
      expect(missing).not.toContain("sectioned.md"); // section-root resolution invariant

      expect(stale).toHaveLength(1);
      expect(stale[0].ref).toBe("PAI/Stale.md");
      expect(stale[0].detail).toBe("ref modified 5d after doc");

      expect(orphan).toEqual(["PAI/Orphan.md"]); // Main/Referenced/Stale are referenced → not orphans

      expect(envelope.summary).toEqual({ missing: 2, stale: 1, orphan: 1 });
    });
  });

  test("the .ts referrer yields ONLY its ts-import finding (backtick path ignored — ts-narrow)", () => {
    inTree((env) => {
      const result = runRefCheck(ref.buildRefConfig(env, { changedOnly: false, includeStale: false, includeOrphans: false }));
      const modFindings = result.findings.filter((f) => f.file === "PAI/mod.ts");
      expect(modFindings.map((f) => f.ref)).toEqual(["./ghost.ts"]);
    });
  });

  test("JSON envelope shape is the frozen IntegrityMaintenance contract", () => {
    inTree((env) => {
      const result = runRefCheck(ref.buildRefConfig(env, { changedOnly: false, includeStale: true, includeOrphans: true }));
      const envelope = ref.refEnvelope(result, 42);
      // Top-level keys the consumer parses (IntegrityMaintenance.ts:838/857-866).
      expect(Object.keys(envelope).sort()).toEqual(["elapsedMs", "findings", "scannedFiles", "scannedRefs", "summary"]);
      expect(envelope.elapsedMs).toBe(42);
      expect(envelope.scannedFiles).toBeGreaterThan(0);
      expect(envelope.scannedRefs).toBeGreaterThan(0);
      // Per-finding field names the consumer keys on: type / file / resolved (+ line / ref).
      const miss = envelope.findings.find((f) => f.type === "missing")!;
      expect(Object.keys(miss).sort()).toEqual(["file", "label", "line", "ref", "resolved", "type"]);
      expect(typeof miss.resolved).toBe("string");
    });
  });

  test("--changed on a non-git tree reports no missing/stale (git() fail-soft degradation; orphans are not gated)", () => {
    inTree((env) => {
      // includeOrphans:false isolates the changed-filter — orphan detection walks all files by design
      // (faithful to the original), so it is excluded here to assert the missing/stale degradation cleanly.
      const result = runRefCheck(ref.buildRefConfig(env, { changedOnly: true, includeStale: true, includeOrphans: false }));
      expect(result.findings).toEqual([]);
    });
  });

  test("exit codes: missing → 1, --help → 0", () => {
    inTree((env) => {
      expect(silentMain(() => ref.main(["--json"], env, () => 0))).toBe(1); // Ghost.md + ghost.ts missing
      expect(silentMain(() => ref.main(["--help"], env, () => 0))).toBe(0);
    });
  });

  test("exit 0 on a clean tree", () => {
    const root = mkdtempSync(join(tmpdir(), "std-refcheck-clean-"));
    try {
      const claudeDir = join(root, ".claude");
      const paiDir = join(claudeDir, "PAI");
      mkdirSync(paiDir, { recursive: true });
      writeFileSync(join(paiDir, "Only.md"), "# Only\n\nno refs here\n");
      const env = { claudeDir, paiDir };
      expect(silentMain(() => ref.main(["--json"], env, () => 0))).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("doc-check mode (curated scope) — narrower extraction, own envelope", () => {
  test("reports the fenced ref AND the real missing ref (no fence-skip); Stale.md is stale", () => {
    inTree((env) => {
      const result = runRefCheck(doc.buildDocConfig(env, { changedOnly: false }));
      const envelope = doc.docEnvelope(result);

      const missing = envelope.findings.filter((f) => f.type === "missing").map((f) => f.ref);
      const stale = envelope.findings.filter((f) => f.type === "stale");

      // DocCheck does NOT skip fences → Fenced.md IS reported, unlike reference-check.
      expect(missing).toContain("PAI/DOCUMENTATION/Ghost.md");
      expect(missing).toContain("PAI/DOCUMENTATION/Fenced.md");
      expect(stale.map((f) => f.ref)).toContain("PAI/Stale.md");
    });
  });

  test("envelope is DocCheck's { docsChecked, refsChecked, findings } with { doc, ref, line, type }", () => {
    inTree((env) => {
      const result = runRefCheck(doc.buildDocConfig(env, { changedOnly: false }));
      const envelope = doc.docEnvelope(result);
      expect(Object.keys(envelope).sort()).toEqual(["docsChecked", "findings", "refsChecked"]);
      expect(envelope.docsChecked).toBeGreaterThan(0);
      const f = envelope.findings.find((x) => x.type === "missing")!;
      expect(Object.keys(f).sort()).toEqual(["doc", "line", "ref", "type"]);
    });
  });

  test("exit 1 iff any missing (stale alone does not fail)", () => {
    inTree((env) => {
      expect(silentMain(() => doc.main(["--json"], env))).toBe(1);
    });

    // A doc tree with only a STALE ref (no missing) must exit 0.
    const root = mkdtempSync(join(tmpdir(), "std-doccheck-stale-"));
    try {
      const claudeDir = join(root, ".claude");
      const paiDir = join(claudeDir, "PAI");
      mkdirSync(paiDir, { recursive: true });
      writeFileSync(join(paiDir, "Doc.md"), "points at `PAI/Fresh.md`\n");
      writeFileSync(join(paiDir, "Fresh.md"), "# Fresh\n");
      utimesSync(join(paiDir, "Doc.md"), REFERRER, REFERRER);
      utimesSync(join(paiDir, "Fresh.md"), NEWER, NEWER); // newer → stale, but not missing
      const env = { claudeDir, paiDir, hooksDir: join(claudeDir, "hooks") };
      const result = runRefCheck(doc.buildDocConfig(env, { changedOnly: false }));
      const envelope = doc.docEnvelope(result);
      expect(envelope.findings.some((f) => f.type === "stale")).toBe(true);
      expect(envelope.findings.some((f) => f.type === "missing")).toBe(false);
      expect(doc.docExitCode(envelope)).toBe(0); // stale never fails
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Category 5 (RT-2, AD-9.3): defaultEnv derives the framework dir via resolveFrameworkDir, then the
// claude-home via dirname(). hooks/ and the archived-ALGORITHM walk keep hanging off the claude-home.
describe("RT-2 framework-dir resolution — defaultEnv (doc-check + reference-check)", () => {
  test("doc.defaultEnv: fresh tree → paiDir under .claude/LIFEOS, claudeDir = its parent, hooksDir off claude-home", () => {
    const home = mkdtempSync(join(tmpdir(), "dc-rt2-"));
    try {
      const env = doc.defaultEnv(home);
      expect(env.paiDir).toBe(join(home, ".claude", "LIFEOS"));
      expect(env.claudeDir).toBe(join(home, ".claude"));
      expect(env.hooksDir).toBe(join(home, ".claude", "hooks"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("ref.defaultEnv: legacy PAI tree present → paiDir under .claude/PAI, claudeDir = its parent", () => {
    const home = mkdtempSync(join(tmpdir(), "rc-rt2-"));
    mkdirSync(join(home, ".claude", "PAI"), { recursive: true });
    try {
      const env = ref.defaultEnv(home);
      expect(env.paiDir).toBe(join(home, ".claude", "PAI"));
      expect(env.claudeDir).toBe(join(home, ".claude"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// OQ-2 / AC5: USER/ is (on the real estate) a SYMLINK that points OUT of the framework dir. reference-check
// walks the whole claude tree; the walk must follow USER/ through the symlink, read the files there, and
// TERMINATE (realpath escapes LIFEOS/, so it is not a cycle). If the walk skipped or looped on the symlink,
// the broken ref inside the symlinked file would never be reported (or the test would hang).
describe("RT-2 symlinked USER/ (OQ-2, AC5) — the walk follows USER/ out of LIFEOS/ and reads through it", () => {
  test("a broken ref inside a file under the symlinked USER/ is scanned and reported (walk terminates)", () => {
    const home = mkdtempSync(join(tmpdir(), "sym-rt2-"));
    const fwDir = join(home, ".claude", "LIFEOS"); // fresh tree → defaultEnv resolves here
    const userReal = join(home, ".config", "LIFEOS", "USER"); // USER lives OUTSIDE the framework dir
    mkdirSync(fwDir, { recursive: true });
    mkdirSync(userReal, { recursive: true });
    symlinkSync(userReal, join(fwDir, "USER")); // <framework>/USER → <home>/.config/LIFEOS/USER
    // a markdown file UNDER the symlinked USER with a broken framework-relative ref — only surfaces if walked.
    writeFileSync(join(userReal, "sym-note.md"), "# note\n\nBroken: `USER/ghost-does-not-exist.md`\n");
    try {
      const env = ref.defaultEnv(home);
      expect(env.paiDir).toBe(fwDir); // sanity: the fresh LIFEOS tree resolved
      const result = runRefCheck(ref.buildRefConfig(env, { changedOnly: false, includeStale: false, includeOrphans: false }));
      const envelope = ref.refEnvelope(result, 0);
      // The file under the symlinked USER was scanned and its broken ref reported — proof the walk read through it.
      expect(
        envelope.findings.some(
          (f) => f.file === join("LIFEOS", "USER", "sym-note.md") && f.ref === "USER/ghost-does-not-exist.md",
        ),
      ).toBe(true);
      expect(envelope.scannedFiles).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
