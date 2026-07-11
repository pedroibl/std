#!/usr/bin/env bun
/**
 * Session Progress CLI — multi-session continuity files (Anthropic's claude-progress.txt pattern).
 * Story 12.2 rewrite onto the std substrate (proof/ consumer; live cutover staged for Pedro). Behavior
 * preserved; the re-rolled fs/arg plumbing now imports the tested std primitives:
 *   - fs/json  → fsx.loadJson / fsx.saveJson  (saveJson makes the write ATOMIC — the original was not —
 *                and adds one trailing "\n": the documented 1-byte diff)
 *   - dir list → fsx.walkFiles  (the flat PROGRESS_DIR has no subdirs and these tools never nest a
 *                progress file, so on a flat dir walkFiles yields the same files in the same order as the
 *                old readdirSync().filter(); the recursion is a benign, unreachable superset here)
 *   - dispatch → core/args dispatch  (there are no --flags on this CLI — only positional/variadic args)
 *
 * Kept CALLER-LOCAL (D4/AD-2, AC4 — NOT converged onto core.Counts/statusLine/GLYPH):
 *   - the 3-state status `active|completed|blocked` and its emoji map (`🔵 ✅ 🔴`) — domain vocab.
 *   - the `resume` briefing template, the `${project}-progress.json` filename convention,
 *     `toLocaleDateString()` (a locale format, NOT date-kit), and the injected
 *     `~/.claude/PAI/MEMORY/STATE/progress` root (consumer identity — never enters std).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "std/core";
import { loadJson, saveJson, walkFiles } from "std/fsx";

interface Decision {
  timestamp: string;
  decision: string;
  rationale: string;
}

interface WorkItem {
  timestamp: string;
  description: string;
  artifacts: string[];
}

interface Blocker {
  timestamp: string;
  blocker: string;
  resolution: string | null;
}

export interface SessionProgress {
  project: string;
  created: string;
  updated: string;
  status: "active" | "completed" | "blocked";
  objectives: string[];
  decisions: Decision[];
  work_completed: WorkItem[];
  blockers: Blocker[];
  handoff_notes: string;
  next_steps: string[];
}

// Injected estate root — consumer identity, stays at the edge (D4).
const PROGRESS_DIR = join(process.env.HOME || "", ".claude", "PAI", "MEMORY", "STATE", "progress");

export function getProgressPath(project: string, dir = PROGRESS_DIR): string {
  return join(dir, `${project}-progress.json`);
}

// existsSync→readFileSync+JSON.parse→null collapses onto fsx.loadJson (missing OR corrupt → null).
export function loadProgress(project: string, dir = PROGRESS_DIR): SessionProgress | null {
  const loaded = loadJson<SessionProgress | null>(getProgressPath(project, dir), null);
  if (!loaded || !loaded.status || !loaded.objectives) return null;
  return loaded;
}

// writeFileSync(JSON.stringify(...,2)) → fsx.saveJson: same content, now atomic + trailing "\n".
export function saveProgress(progress: SessionProgress, dir = PROGRESS_DIR): void {
  progress.updated = new Date().toISOString();
  saveJson(getProgressPath(progress.project, dir), progress);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export function createProgress(project: string, objectives: string[], dir = PROGRESS_DIR): void {
  const path = getProgressPath(project, dir);
  if (existsSync(path)) {
    console.log(`Progress file already exists for ${project}`);
    console.log(`Use 'session-progress resume ${project}' to continue`);
    return;
  }

  const progress: SessionProgress = {
    project,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    status: "active",
    objectives,
    decisions: [],
    work_completed: [],
    blockers: [],
    handoff_notes: "",
    next_steps: [],
  };

  saveProgress(progress, dir);
  console.log(`Created progress file: ${path}`);
  console.log(`Objectives: ${objectives.join(", ")}`);
}

export function addDecision(project: string, decision: string, rationale: string, dir = PROGRESS_DIR): void {
  const progress = loadProgress(project, dir);
  if (!progress) {
    console.error(`No progress file for ${project}`);
    process.exit(1);
  }

  progress.decisions.push({
    timestamp: new Date().toISOString(),
    decision,
    rationale,
  });

  saveProgress(progress, dir);
  console.log(`Added decision: ${decision}`);
}

export function addWork(project: string, description: string, artifacts: string[], dir = PROGRESS_DIR): void {
  const progress = loadProgress(project, dir);
  if (!progress) {
    console.error(`No progress file for ${project}`);
    process.exit(1);
  }

  progress.work_completed.push({
    timestamp: new Date().toISOString(),
    description,
    artifacts,
  });

  saveProgress(progress, dir);
  console.log(`Added work: ${description}`);
}

export function addBlocker(project: string, blocker: string, resolution?: string, dir = PROGRESS_DIR): void {
  const progress = loadProgress(project, dir);
  if (!progress) {
    console.error(`No progress file for ${project}`);
    process.exit(1);
  }

  progress.blockers.push({
    timestamp: new Date().toISOString(),
    blocker,
    resolution: resolution || null,
  });

  progress.status = "blocked";
  saveProgress(progress, dir);
  console.log(`Added blocker: ${blocker}`);
}

export function setNextSteps(project: string, steps: string[], dir = PROGRESS_DIR): void {
  const progress = loadProgress(project, dir);
  if (!progress) {
    console.error(`No progress file for ${project}`);
    process.exit(1);
  }

  progress.next_steps = steps;
  saveProgress(progress, dir);
  console.log(`Set ${steps.length} next steps`);
}

export function setHandoff(project: string, notes: string, dir = PROGRESS_DIR): void {
  const progress = loadProgress(project, dir);
  if (!progress) {
    console.error(`No progress file for ${project}`);
    process.exit(1);
  }

  progress.handoff_notes = notes;
  saveProgress(progress, dir);
  console.log(`Set handoff notes`);
}

export function resumeProgress(project: string, dir = PROGRESS_DIR): void {
  const progress = loadProgress(project, dir);
  if (!progress) {
    console.error(`No progress file for ${project}`);
    process.exit(1);
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`SESSION RESUME: ${project}`);
  console.log(`${"═".repeat(60)}\n`);

  console.log(`Status: ${progress.status}`);
  console.log(`Last Updated: ${progress.updated}\n`);

  console.log(`OBJECTIVES:`);
  progress.objectives.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));

  if (progress.decisions.length > 0) {
    console.log(`\nKEY DECISIONS:`);
    progress.decisions.slice(-3).forEach((d) => {
      console.log(`  • ${d.decision}`);
      console.log(`    Rationale: ${d.rationale}`);
    });
  }

  if (progress.work_completed.length > 0) {
    console.log(`\nRECENT WORK:`);
    progress.work_completed.slice(-5).forEach((w) => {
      console.log(`  • ${w.description}`);
      if (w.artifacts.length > 0) {
        console.log(`    Artifacts: ${w.artifacts.join(", ")}`);
      }
    });
  }

  if (progress.blockers.length > 0) {
    const unresolvedBlockers = progress.blockers.filter((b) => !b.resolution);
    if (unresolvedBlockers.length > 0) {
      console.log(`\n⚠️ ACTIVE BLOCKERS:`);
      unresolvedBlockers.forEach((b) => {
        console.log(`  • ${b.blocker}`);
      });
    }
  }

  if (progress.handoff_notes) {
    console.log(`\n📝 HANDOFF NOTES:`);
    console.log(`  ${progress.handoff_notes}`);
  }

  if (progress.next_steps.length > 0) {
    console.log(`\n➡️ NEXT STEPS:`);
    progress.next_steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  }

  console.log(`\n${"═".repeat(60)}\n`);
}

export function listActive(dir = PROGRESS_DIR): void {
  if (!existsSync(dir)) {
    console.log("No progress files found");
    return;
  }

  // Single-level listing preserved: PROGRESS_DIR is flat, so walkFiles (recursive) returns the same
  // files in the same order as the old readdirSync().filter(); the `-progress.json` predicate also
  // excludes the sibling `-features.json` registry files, exactly as before.
  const files = walkFiles(dir, (p) => p.endsWith("-progress.json"));

  if (files.length === 0) {
    console.log("No active progress files");
    return;
  }

  console.log(`\nActive Progress Files:\n`);

  for (const file of files) {
    const progress = loadJson<SessionProgress | null>(file, null);
    if (!progress) continue; // a corrupt/vanished file is skipped, not a hard throw (loadJson)
    const statusIcon = {
      active: "🔵",
      completed: "✅",
      blocked: "🔴",
    }[progress.status];

    console.log(`${statusIcon} ${progress.project} (${progress.status})`);
    console.log(`   Updated: ${new Date(progress.updated).toLocaleDateString()}`);
    console.log(`   Work items: ${progress.work_completed.length}`);
    if (progress.next_steps.length > 0) {
      console.log(`   Next: ${progress.next_steps[0]}`);
    }
    console.log("");
  }
}

export function completeProgress(project: string, dir = PROGRESS_DIR): void {
  const progress = loadProgress(project, dir);
  if (!progress) {
    console.error(`No progress file for ${project}`);
    process.exit(1);
  }

  progress.status = "completed";
  progress.handoff_notes = `Completed at ${new Date().toISOString()}`;
  saveProgress(progress, dir);
  console.log(`Marked ${project} as completed`);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const HELP = `
Session Progress CLI - Multi-session continuity management

Commands:
  create <project> [objectives...]    Create new progress file
  decision <project> <decision> <rationale>  Record a decision
  work <project> <description> [artifacts...]  Record completed work
  blocker <project> <blocker> [resolution]    Add blocker
  next <project> <step1> <step2>...   Set next steps
  handoff <project> <notes>           Set handoff notes
  resume <project>                    Display context for resuming
  list                                List all active progress files
  complete <project>                  Mark project as completed

Examples:
  session-progress create auth-feature "Implement user authentication"
  session-progress decision auth-feature "Using JWT" "Simpler than sessions for our API"
  session-progress work auth-feature "Created User model" src/models/user.ts
  session-progress next auth-feature "Write auth tests" "Implement login endpoint"
  session-progress resume auth-feature
`;

function usage(msg: string): number {
  console.error(`Usage: ${msg}`);
  return 1;
}

export function main(argv = process.argv.slice(2)): number {
  const command = argv[0] ?? "";
  const rest = argv.slice(1);

  const handlers: Record<string, () => number> = {
    create: () => {
      if (!rest[0]) return usage("session-progress create <project> [objective1] [objective2] ...");
      createProgress(rest[0], rest.slice(1));
      return 0;
    },
    decision: () => {
      if (!rest[0] || !rest[1]) {
        return usage('session-progress decision <project> "<decision>" "<rationale>"');
      }
      addDecision(rest[0], rest[1], rest[2] || "");
      return 0;
    },
    work: () => {
      if (!rest[0] || !rest[1]) {
        return usage('session-progress work <project> "<description>" [artifact1] [artifact2] ...');
      }
      addWork(rest[0], rest[1], rest.slice(2));
      return 0;
    },
    blocker: () => {
      if (!rest[0] || !rest[1]) {
        return usage('session-progress blocker <project> "<blocker>" ["resolution"]');
      }
      addBlocker(rest[0], rest[1], rest[2]);
      return 0;
    },
    next: () => {
      if (!rest[0]) return usage("session-progress next <project> <step1> <step2> ...");
      setNextSteps(rest[0], rest.slice(1));
      return 0;
    },
    handoff: () => {
      if (!rest[0] || !rest[1]) return usage('session-progress handoff <project> "<notes>"');
      setHandoff(rest[0], rest[1]);
      return 0;
    },
    resume: () => {
      if (!rest[0]) return usage("session-progress resume <project>");
      resumeProgress(rest[0]);
      return 0;
    },
    list: () => {
      listActive();
      return 0;
    },
    complete: () => {
      if (!rest[0]) return usage("session-progress complete <project>");
      completeProgress(rest[0]);
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
