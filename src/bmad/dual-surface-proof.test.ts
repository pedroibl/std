// Story 1.2 — the Epic-0 EMPIRICAL PROOF that `bmad install --custom-source <bmad-estate>` renders both
// Surfaces (`.claude/skills` + `.agents/skills`) byte-identically, with `dev-the-loop` absent by default
// and present only when the marketplace `skills` array selects it. This is a TEST HARNESS, not a CLI:
// it shells the REAL `bmad` binary into a throwaway `git init` repo and asserts the render. There is NO
// `src/bmad/install.ts`, no `deps` seam, no `runBmadInstall` here — that command family is all Epic A
// (BM-1/BM-4). The only code this story authors is this test + its `bmad.test-helpers.ts`.
//
// AC7 capability gate: when `bmad` is not on PATH (`resolveBmadBin() === null` — the CI reality), every
// case reports SKIPPED via `test.skipIf`, exit 0, never a 127-red and never a hang. On Pedro's machine
// (`bmad` at `~/.local/bin/bmad`) AC1–AC6 run for real.
//
// std reuse: `spawnCapture` (never-reject/never-hang) for every shell-out — `bmad install`, `diff`, and
// (in the helper) `git init`. No new subprocess infra.

import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCapture } from "../proc/index";
import { makeScratchRepo, resolveBmadBin, resolveEstateModule } from "./bmad.test-helpers";

const bmadBin = resolveBmadBin();
const estate = resolveEstateModule();

// The TWO skills the base marketplace selects (Story 1.1 AC5). AC3 Faithfulness iterates THIS set, NOT
// `readdir(<estate>/skills)` — that on-disk set has THREE dirs and `dev-the-loop` has no installed
// counterpart under a plain install, so a readdir loop would `diff` against a missing dir and manufacture
// a false Faithfulness break (Dev Notes §"The Faithfulness trap", BM-12: compare the SELECTED source).
const SELECTED = ["bmad-agent-epic-the-loop", "bmad-agent-jhon-the-loop"] as const;
// On disk in the module, but NOT in the base marketplace array — the boundary AC5/AC6 pivot on.
const DEV = "bmad-agent-dev-the-loop";

// Bun's default 5s test timeout is far too short for a real `bmad install`; each install case gets 150s.
const INSTALL_TIMEOUT_MS = 150_000;
// spawnCapture guard so a runaway install resolves (code 124) instead of hanging the whole suite.
const SPAWN_TIMEOUT_MS = 120_000;

if (!bmadBin) {
  // Visible breadcrumb in addition to test.skipIf's "skipped" report (AC7).
  console.log("SKIP: bmad binary not on PATH ($BMAD_BIN unset) — dual-surface proof requires a real bmad install");
}

/** The frozen install contract (Dev Notes §"The exact install invocation"). Only `--custom-source` varies. */
function installArgs(scratch: string, source: string): string[] {
  return ["install", "--directory", scratch, "--modules", "core", "--custom-source", source,
    "--tools", "claude-code,antigravity-cli", "--yes"];
}

/** diff -rq via spawnCapture → true iff the two trees are byte-identical (code 0, empty stdout). */
async function treesIdentical(a: string, b: string): Promise<{ ok: boolean; report: string }> {
  const d = await spawnCapture("diff", ["-rq", a, b]);
  return { ok: d.code === 0 && d.stdout.trim() === "", report: d.stdout.trim() || d.stderr.trim() };
}

describe("dual-surface proof (Story 1.2 · FR-2)", () => {
  test.skipIf(!bmadBin)(
    "AC1–AC5: default estate renders both surfaces byte-identically, dev absent",
    async () => {
      const repo = await makeScratchRepo();
      try {
        const claudeSkills = join(repo.dir, ".claude", "skills");
        const agentsSkills = join(repo.dir, ".agents", "skills");

        const install = await spawnCapture(bmadBin!, installArgs(repo.dir, estate), { timeout: SPAWN_TIMEOUT_MS });
        if (install.code !== 0) throw new Error(`bmad install failed (code ${install.code}):\n${install.stderr}`);

        // AC1 — both surfaces populated with BOTH selected loop skills (alongside core).
        for (const surface of [claudeSkills, agentsSkills]) {
          for (const s of SELECTED) expect(existsSync(join(surface, s))).toBe(true);
        }

        // AC2 — Parity: the two surfaces are byte-identical to each other.
        const parity = await treesIdentical(claudeSkills, agentsSkills);
        expect(parity.report).toBe("");
        expect(parity.ok).toBe(true);

        // AC3 — Faithfulness: each SELECTED skill matches its source tree (SELECTED set, not readdir).
        for (const s of SELECTED) {
          const faith = await treesIdentical(join(estate, "skills", s), join(claudeSkills, s));
          expect(faith.report).toBe("");
          expect(faith.ok).toBe(true);
        }

        // AC4 — set-Parity: same skill SET on both surfaces, no surface-only entries.
        expect(readdirSync(claudeSkills).sort()).toEqual(readdirSync(agentsSkills).sort());

        // AC5 — the Default-estate boundary: dev-the-loop absent from BOTH surfaces, though it exists on disk.
        expect(existsSync(join(claudeSkills, DEV))).toBe(false);
        expect(existsSync(join(agentsSkills, DEV))).toBe(false);
      } finally {
        await repo.cleanup();
      }
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!bmadBin)(
    "AC6: the boundary is a gate, not a bug — dev present when the marketplace selects it",
    async () => {
      // ── One-off proof of the BM-12 mechanism ONLY ──────────────────────────────────────────────────
      // We materialize an augmented custom-source whose marketplace `skills` array lists ALL THREE skills,
      // then install it. The ONLY delta from the AC1 install is that array — proving "the skills array is
      // the gate, the on-disk dir is not." This is NOT the Epic-A `src/bmad/install.ts` `--skills` filter
      // (Story A.3); do not grow this staging block into command logic.
      const staging = mkdtempSync(join(tmpdir(), "bmad-staging-"));
      try {
        mkdirSync(join(staging, ".claude-plugin"), { recursive: true });
        const marketplace = JSON.parse(readFileSync(join(estate, ".claude-plugin", "marketplace.json"), "utf8"));
        marketplace.plugins[0].skills = [...SELECTED, DEV].map((s) => `./skills/${s}`);
        writeFileSync(join(staging, ".claude-plugin", "marketplace.json"), JSON.stringify(marketplace, null, 2));
        cpSync(join(estate, "skills"), join(staging, "skills"), { recursive: true });

        const repo = await makeScratchRepo();
        try {
          const claudeSkills = join(repo.dir, ".claude", "skills");
          const agentsSkills = join(repo.dir, ".agents", "skills");

          const install = await spawnCapture(bmadBin!, installArgs(repo.dir, staging), { timeout: SPAWN_TIMEOUT_MS });
          if (install.code !== 0) throw new Error(`bmad install (augmented) failed (code ${install.code}):\n${install.stderr}`);

          // dev now PRESENT in both surfaces (the boundary opened because the array selected it)...
          expect(existsSync(join(claudeSkills, DEV))).toBe(true);
          expect(existsSync(join(agentsSkills, DEV))).toBe(true);

          // ...and byte-faithful to source.
          const devFaith = await treesIdentical(join(estate, "skills", DEV), join(claudeSkills, DEV));
          expect(devFaith.report).toBe("");
          expect(devFaith.ok).toBe(true);

          // Everything else identical — Parity + set-Parity still hold for the augmented install.
          const parity = await treesIdentical(claudeSkills, agentsSkills);
          expect(parity.report).toBe("");
          expect(parity.ok).toBe(true);
          expect(readdirSync(claudeSkills).sort()).toEqual(readdirSync(agentsSkills).sort());
        } finally {
          await repo.cleanup();
        }
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    },
    INSTALL_TIMEOUT_MS,
  );
});
