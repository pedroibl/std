#!/usr/bin/env bun
/**
 * Feature Registry CLI — JSON-based feature tracking for complex multi-feature tasks.
 * Story 12.2 rewrite onto the std substrate (proof/ consumer; live cutover to ~/.claude/PAI/TOOLS
 * staged for Pedro). Behavior is preserved; the only change is that the re-rolled fs/arg plumbing now
 * imports the tested std primitives:
 *   - fs/json  → fsx.loadJson / fsx.saveJson / fsx.ensureDir  (saveJson also makes writes ATOMIC — an
 *                upgrade the original lacked — and adds a single trailing "\n": the one legitimate 1-byte
 *                diff, same class 12.1 documented)
 *   - args     → core/args flagValue + dispatch  (flagValue is a superset of the old indexOf idiom:
 *                it also accepts --flag=value)
 *
 * Kept CALLER-LOCAL (D4/AD-2, AC4 — NOT converged onto core.Counts/statusLine/GLYPH):
 *   - `calculateSummary` — a 4-bucket record over a 5-STATE union: `in_progress` is in `Feature.status`
 *     but is SILENTLY UNCOUNTED by the summary (faithful to the original; recorded as a substrate finding,
 *     not fixed here). Its shape (pending|passing|failing|blocked) is not `ok|error|warn|info`.
 *   - the status→glyph maps (`○ ◐ ✓ ✗ ⊘`, `✅ ❌`, `✓ ✗ ○`) — domain vocab, not core.GLYPH.
 *   - the `Progress: X/Y … | … | …` line, the `${project}-features.json` filename convention, and the
 *     injected `~/.claude/PAI/MEMORY/STATE/progress` root (consumer identity — never enters std).
 *
 * Usage:
 *   bun feature-registry.ts <command> [options]
 * Commands:
 *   init <project> · add <project> <name> [--description d] [--priority P1|P2|P3]
 *   update <project> <id> [status] [--note n] · list <project> · verify <project> · next <project>
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { dispatch, flagValue } from "std/core";
import { ensureDir, loadJson, resolveFrameworkDir, saveJson } from "std/fsx";

export interface TestStep {
  step: string;
  status: "pending" | "passing" | "failing";
}

export interface Feature {
  id: string;
  name: string;
  description: string;
  priority: "P1" | "P2" | "P3";
  status: "pending" | "in_progress" | "passing" | "failing" | "blocked";
  test_steps: TestStep[];
  acceptance_criteria: string[];
  blocked_by: string[];
  started_at: string | null;
  completed_at: string | null;
  notes: string[];
}

export interface FeatureRegistry {
  project: string;
  created: string;
  updated: string;
  version: string;
  features: Feature[];
  completion_summary: {
    total: number;
    passing: number;
    failing: number;
    pending: number;
    blocked: number;
  };
}

// Injected estate root — consumer identity, stays at the edge (D4).
const REGISTRY_DIR = join(resolveFrameworkDir(process.env.HOME || ""), "MEMORY", "STATE", "progress");

export function getRegistryPath(project: string, dir = REGISTRY_DIR): string {
  return join(dir, `${project}-features.json`);
}

// existsSync→readFileSync+JSON.parse→null collapses onto fsx.loadJson (missing OR corrupt → fallback).
// Corrupt→null is fsx.loadJson's graceful-degrade contract (the original threw on corrupt); every caller
// already branches on a null registry, so this is a safe convergence, not a behavior regression.
export function loadRegistry(project: string, dir = REGISTRY_DIR): FeatureRegistry | null {
  const loaded = loadJson<FeatureRegistry | null>(getRegistryPath(project, dir), null);
  if (!loaded || !loaded.features) return null;
  return loaded;
}

// writeFileSync(JSON.stringify(...,2)) → fsx.saveJson: same content, now ATOMIC + a trailing "\n".
export function saveRegistry(registry: FeatureRegistry, dir = REGISTRY_DIR): void {
  const path = getRegistryPath(registry.project, dir);
  registry.updated = new Date().toISOString();
  registry.completion_summary = calculateSummary(registry.features);
  saveJson(path, registry);
}

// CALLER-LOCAL 4-bucket summary (AC4). NOTE: `Feature.status` is 5-state, but `in_progress` is not
// tallied here — this is faithful to the original and recorded as an extraction-map/substrate finding.
export function calculateSummary(features: Feature[]): FeatureRegistry["completion_summary"] {
  return {
    total: features.length,
    passing: features.filter((f) => f.status === "passing").length,
    failing: features.filter((f) => f.status === "failing").length,
    pending: features.filter((f) => f.status === "pending").length,
    blocked: features.filter((f) => f.status === "blocked").length,
  };
}

export function generateId(features: Feature[]): string {
  const maxId = features.reduce((max, f) => {
    const num = parseInt(f.id.replace("feat-", ""));
    return num > max ? num : max;
  }, 0);
  return `feat-${maxId + 1}`;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export function initRegistry(project: string, dir = REGISTRY_DIR): void {
  ensureDir(dir); // mkdirSync recursive → fsx.ensureDir (idempotent, no exists-check needed)

  const path = getRegistryPath(project, dir);
  if (existsSync(path)) {
    console.log(`Registry already exists for ${project}`);
    return;
  }

  const registry: FeatureRegistry = {
    project,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    version: "1.0.0",
    features: [],
    completion_summary: { total: 0, passing: 0, failing: 0, pending: 0, blocked: 0 },
  };

  saveRegistry(registry, dir);
  console.log(`Initialized feature registry: ${path}`);
}

export function addFeature(
  project: string,
  name: string,
  description = "",
  priority: "P1" | "P2" | "P3" = "P2",
  criteria: string[] = [],
  steps: string[] = [],
  dir = REGISTRY_DIR,
): void {
  const registry = loadRegistry(project, dir);
  if (!registry) {
    console.error(`No registry found for ${project}. Run: feature-registry init ${project}`);
    process.exit(1);
  }

  const feature: Feature = {
    id: generateId(registry.features),
    name,
    description,
    priority,
    status: "pending",
    test_steps: steps.map((s) => ({ step: s, status: "pending" as const })),
    acceptance_criteria: criteria,
    blocked_by: [],
    started_at: null,
    completed_at: null,
    notes: [],
  };

  registry.features.push(feature);
  saveRegistry(registry, dir);
  console.log(`Added feature ${feature.id}: ${name}`);
}

export function updateFeature(
  project: string,
  featureId: string,
  status?: Feature["status"],
  note?: string,
  dir = REGISTRY_DIR,
): void {
  const registry = loadRegistry(project, dir);
  if (!registry) {
    console.error(`No registry found for ${project}`);
    process.exit(1);
  }

  const feature = registry.features.find((f) => f.id === featureId);
  if (!feature) {
    console.error(`Feature ${featureId} not found`);
    process.exit(1);
  }

  if (status) {
    feature.status = status;
    if (status === "in_progress" && !feature.started_at) {
      feature.started_at = new Date().toISOString();
    }
    if (status === "passing") {
      feature.completed_at = new Date().toISOString();
    }
  }

  if (note) {
    feature.notes.push(`[${new Date().toISOString()}] ${note}`);
  }

  saveRegistry(registry, dir);
  console.log(`Updated ${featureId}: status=${feature.status}`);
}

export function listFeatures(project: string, dir = REGISTRY_DIR): void {
  const registry = loadRegistry(project, dir);
  if (!registry) {
    console.error(`No registry found for ${project}`);
    process.exit(1);
  }

  console.log(`\nFeature Registry: ${project}`);
  console.log(`Updated: ${registry.updated}`);
  console.log(`─────────────────────────────────────`);

  const summary = registry.completion_summary;
  console.log(`Progress: ${summary.passing}/${summary.total} passing`);
  console.log(`  Pending: ${summary.pending} | Failing: ${summary.failing} | Blocked: ${summary.blocked}`);
  console.log(`─────────────────────────────────────\n`);

  const byPriority = {
    P1: registry.features.filter((f) => f.priority === "P1"),
    P2: registry.features.filter((f) => f.priority === "P2"),
    P3: registry.features.filter((f) => f.priority === "P3"),
  };

  for (const [priority, features] of Object.entries(byPriority)) {
    if (features.length === 0) continue;
    console.log(`${priority} Features:`);
    for (const f of features) {
      const statusIcon = {
        pending: "○",
        in_progress: "◐",
        passing: "✓",
        failing: "✗",
        blocked: "⊘",
      }[f.status];
      console.log(`  ${statusIcon} [${f.id}] ${f.name} (${f.status})`);
    }
    console.log("");
  }
}

export function verifyFeatures(project: string, dir = REGISTRY_DIR): void {
  const registry = loadRegistry(project, dir);
  if (!registry) {
    console.error(`No registry found for ${project}`);
    process.exit(1);
  }

  console.log(`\nVerification Report: ${project}`);
  console.log(`═══════════════════════════════════════\n`);

  let allPassing = true;

  for (const feature of registry.features) {
    const icon = feature.status === "passing" ? "✅" : "❌";
    console.log(`${icon} ${feature.id}: ${feature.name}`);

    if (feature.status !== "passing") {
      allPassing = false;
      console.log(`   Status: ${feature.status}`);
      if (feature.blocked_by.length > 0) {
        console.log(`   Blocked by: ${feature.blocked_by.join(", ")}`);
      }
    }

    for (const step of feature.test_steps) {
      const stepIcon = step.status === "passing" ? "✓" : step.status === "failing" ? "✗" : "○";
      console.log(`   ${stepIcon} ${step.step}`);
    }
    console.log("");
  }

  console.log(`═══════════════════════════════════════`);
  if (allPassing) {
    console.log(`✅ ALL FEATURES PASSING - Ready for completion`);
  } else {
    console.log(`❌ INCOMPLETE - Some features not passing`);
  }
}

export function nextFeature(project: string, dir = REGISTRY_DIR): void {
  const registry = loadRegistry(project, dir);
  if (!registry) {
    console.error(`No registry found for ${project}`);
    process.exit(1);
  }

  const inProgress = registry.features.find((f) => f.status === "in_progress");
  if (inProgress) {
    console.log(`\nCurrent: [${inProgress.id}] ${inProgress.name}`);
    console.log(`Status: ${inProgress.status}`);
    console.log(`Started: ${inProgress.started_at}`);
    return;
  }

  for (const priority of ["P1", "P2", "P3"] as const) {
    const next = registry.features.find((f) => f.priority === priority && f.status === "pending");
    if (next) {
      console.log(`\nNext: [${next.id}] ${next.name} (${next.priority})`);
      console.log(`Description: ${next.description || "None"}`);
      console.log(`\nTo start: feature-registry update ${project} ${next.id} in_progress`);
      return;
    }
  }

  console.log(`\nNo pending features. All features processed!`);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const HELP = `
Feature Registry CLI - JSON-based feature tracking

Commands:
  init <project>              Initialize feature registry
  add <project> <name>        Add feature (--description, --priority P1|P2|P3)
  update <project> <id>       Update status (pending|in_progress|passing|failing|blocked)
  list <project>              List all features with status
  verify <project>            Run verification report
  next <project>              Show next priority feature

Examples:
  feature-registry init my-app
  feature-registry add my-app "User Authentication" --priority P1
  feature-registry update my-app feat-1 in_progress
  feature-registry list my-app
  feature-registry verify my-app
`;

function usage(msg: string): number {
  console.error(`Usage: ${msg}`);
  return 1;
}

export function main(argv = process.argv.slice(2)): number {
  const command = argv[0] ?? "";
  const rest = argv.slice(1);

  const handlers: Record<string, () => number> = {
    init: () => {
      if (!rest[0]) return usage("feature-registry init <project>");
      initRegistry(rest[0]);
      return 0;
    },
    add: () => {
      if (!rest[0] || !rest[1]) {
        return usage(
          'feature-registry add <project> <feature-name> [--description "desc"] [--priority P1|P2|P3]',
        );
      }
      const desc = flagValue(rest, "description") ?? "";
      const prio = (flagValue(rest, "priority") as "P1" | "P2" | "P3") ?? "P2";
      addFeature(rest[0], rest[1], desc, prio);
      return 0;
    },
    update: () => {
      if (!rest[0] || !rest[1]) {
        return usage('feature-registry update <project> <feature-id> [status] [--note "note"]');
      }
      const validStatuses = ["pending", "in_progress", "passing", "failing", "blocked"];
      const statusArg =
        rest[2] !== undefined && validStatuses.includes(rest[2])
          ? (rest[2] as Feature["status"])
          : undefined;
      const noteArg = flagValue(rest, "note");
      updateFeature(rest[0], rest[1], statusArg, noteArg);
      return 0;
    },
    list: () => {
      if (!rest[0]) return usage("feature-registry list <project>");
      listFeatures(rest[0]);
      return 0;
    },
    verify: () => {
      if (!rest[0]) return usage("feature-registry verify <project>");
      verifyFeatures(rest[0]);
      return 0;
    },
    next: () => {
      if (!rest[0]) return usage("feature-registry next <project>");
      nextFeature(rest[0]);
      return 0;
    },
  };

  return dispatch(command, handlers, () => {
    console.log(HELP);
    return 0;
  });
}

if (import.meta.main) {
  process.exit(main());
}
