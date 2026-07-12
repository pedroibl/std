#!/usr/bin/env bun
/**
 * AlgorithmPhaseReport.ts — writes algorithm state to algorithm-phase.json (dashboard state feed).
 * Story 12.2 rewrite onto the std substrate (proof/ consumer; live cutover staged for Pedro). Behavior
 * preserved; the re-rolled plumbing now imports the tested std primitives:
 *   - fs/json  → fsx.loadJson (readState) / fsx.ensureDir + fsx.saveJson (writeState). saveJson makes the
 *                write ATOMIC and adds a trailing "\n" (the documented 1-byte diff). writeState keeps its
 *                silent try/catch (non-blocking) around the now-fail-loud fsx calls.
 *   - args     → core/args flagValue (the getArg indexOf idiom; flagValue is a --k=v superset) + dispatch
 *                for the switch(command).
 *   - --params → core.extractJson (a CLI-arg JSON string, NOT a file — so extractJson, not loadJson).
 *
 * AC6 corrections recorded here:
 *   (a) this tool has ONE loadJson (readState), not the "×4-5 at :73" the extraction map claimed.
 *   (c) the dead `import { parseArgs } from "util"` (never used) is REMOVED.
 *
 * Kept CALLER-LOCAL / unchanged (D4):
 *   - `Date.now()` epoch-millis timestamps are numeric BY DESIGN — `isoDate` (date-only) does NOT apply.
 *   - the `AlgorithmState` schema and the injected `~/.claude/PAI/MEMORY/STATE` root (consumer identity).
 *   - No bar/counts/glyph here — this tool has no render layer.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { dispatch, extractJson, flagValue } from "std/core";
import { ensureDir, loadJson, resolveFrameworkDir, saveJson } from "std/fsx";

const STATE_DIR = join(resolveFrameworkDir(homedir()), "MEMORY", "STATE");

export function stateFile(dir = STATE_DIR): string {
  return join(dir, "algorithm-phase.json");
}

export interface AlgorithmState {
  active: boolean;
  sessionId: string;
  taskDescription: string;
  currentPhase: string;
  phaseStartedAt: number;
  algorithmStartedAt: number;
  sla: string;
  criteria: Array<{
    id: string;
    description: string;
    type: string;
    status: string;
    evidence?: string;
    createdInPhase: string;
  }>;
  agents: Array<{
    name: string;
    agentType: string;
    status: string;
    task?: string;
    phase: string;
  }>;
  capabilities: string[];
  prdPath?: string;
  phaseHistory: Array<{
    phase: string;
    startedAt: number;
    completedAt?: number;
    criteriaCount: number;
    agentCount: number;
  }>;
  qualityGate?: Record<string, boolean>;
  algorithmConfig?: {
    preset: string | null;
    focus: number | null;
    params: Record<string, number | string>;
    mode: string;
    lockedParams?: string[];
  };
  metaLearnerAdjustments?: Array<{
    cycle: number;
    parameter: string;
    previousValue: number;
    newValue: number;
    rationale: string;
  }>;
}

function defaultState(): AlgorithmState {
  return {
    active: false,
    sessionId: "",
    taskDescription: "",
    currentPhase: "IDLE",
    phaseStartedAt: Date.now(), // epoch-millis by design — NOT isoDate (D4/kept)
    algorithmStartedAt: Date.now(),
    sla: "Standard",
    criteria: [],
    agents: [],
    capabilities: [],
    phaseHistory: [],
  };
}

// The ONE loadJson (AC6 correction a). fsx.loadJson covers missing / empty-file / corrupt → default.
// The extra caller-local guard replicates the original's `raw === "{}"`/degenerate reset: a parsed-but-
// shapeless state (no `currentPhase`) resets to DEFAULT, exactly as before. `{}` would otherwise parse
// clean and slip through loadJson.
export function readState(dir = STATE_DIR): AlgorithmState {
  const loaded = loadJson<AlgorithmState | null>(stateFile(dir), null);
  if (!loaded || !loaded.currentPhase) return defaultState();
  return loaded;
}

// mkdirSync+writeFileSync → fsx.ensureDir + fsx.saveJson, keeping the original silent/non-blocking guard.
export function writeState(state: AlgorithmState, dir = STATE_DIR): void {
  try {
    ensureDir(dir);
    saveJson(stateFile(dir), state);
  } catch {
    // Silent on error — non-blocking (faithful to the original)
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

export function main(argv = process.argv.slice(2), dir = STATE_DIR): number {
  const [command, ...rest] = argv;

  if (!command) {
    console.log(
      "Usage: AlgorithmPhaseReport.ts <phase|criterion|agent|capabilities|config|meta-adjust> [options]",
    );
    return 0;
  }

  const state = readState(dir);

  const handlers: Record<string, () => number> = {
    phase: () => {
      const phase = flagValue(rest, "phase");
      const task = flagValue(rest, "task");
      const sla = flagValue(rest, "sla");
      const sessionId = flagValue(rest, "session");
      const prdPath = flagValue(rest, "prd");

      if (!phase) {
        console.error("--phase required");
        return 1;
      }

      // Close previous phase in history
      if (state.currentPhase && state.currentPhase !== "IDLE" && state.currentPhase !== phase) {
        const prevEntry = state.phaseHistory.find(
          (h) => h.phase === state.currentPhase && !h.completedAt,
        );
        if (prevEntry) {
          prevEntry.completedAt = Date.now();
          prevEntry.criteriaCount = state.criteria.length;
          prevEntry.agentCount = state.agents.length;
        }
      }

      state.active = phase !== "IDLE" && phase !== "COMPLETE";
      state.currentPhase = phase;
      state.phaseStartedAt = Date.now();

      if (task) state.taskDescription = task;
      if (sla) state.sla = sla;
      if (sessionId) state.sessionId = sessionId;
      if (prdPath) state.prdPath = prdPath;

      if (!state.algorithmStartedAt || phase === "OBSERVE") {
        state.algorithmStartedAt = Date.now();
      }

      state.phaseHistory.push({
        phase,
        startedAt: Date.now(),
        criteriaCount: state.criteria.length,
        agentCount: state.agents.length,
      });

      return 0;
    },

    criterion: () => {
      const id = flagValue(rest, "id");
      const desc = flagValue(rest, "desc");
      const type = flagValue(rest, "type");
      const status = flagValue(rest, "status");
      const evidence = flagValue(rest, "evidence");

      if (!id) {
        console.error("--id required");
        return 1;
      }

      const existing = state.criteria.find((c) => c.id === id);
      if (existing) {
        if (desc) existing.description = desc;
        if (type) existing.type = type;
        if (status) existing.status = status;
        if (evidence) existing.evidence = evidence;
      } else {
        state.criteria.push({
          id,
          description: desc ?? "",
          type: type ?? "criterion",
          status: status ?? "pending",
          evidence,
          createdInPhase: state.currentPhase,
        });
      }
      return 0;
    },

    agent: () => {
      const name = flagValue(rest, "name");
      const agentType = flagValue(rest, "type");
      const status = flagValue(rest, "status");
      const task = flagValue(rest, "task");

      if (!name) {
        console.error("--name required");
        return 1;
      }

      const existing = state.agents.find((a) => a.name === name);
      if (existing) {
        if (agentType) existing.agentType = agentType;
        if (status) existing.status = status;
        if (task) existing.task = task;
        existing.phase = state.currentPhase;
      } else {
        state.agents.push({
          name,
          agentType: agentType ?? "general-purpose",
          status: status ?? "active",
          task,
          phase: state.currentPhase,
        });
      }
      return 0;
    },

    capabilities: () => {
      const list = flagValue(rest, "list");
      if (list) {
        state.capabilities = list.split(",").map((s) => s.trim());
      }
      return 0;
    },

    config: () => {
      const preset = flagValue(rest, "preset");
      const focusStr = flagValue(rest, "focus");
      const mode = flagValue(rest, "mode");
      const paramsJson = flagValue(rest, "params");

      if (!state.algorithmConfig) {
        state.algorithmConfig = {
          preset: null,
          focus: null,
          params: {},
          mode: "standard",
        };
      }

      if (preset !== undefined) state.algorithmConfig.preset = preset;
      if (focusStr !== undefined) state.algorithmConfig.focus = parseFloat(focusStr);
      if (mode) state.algorithmConfig.mode = mode;

      if (paramsJson) {
        const parsed = extractJson<Record<string, number | string>>(paramsJson);
        if (parsed === null) {
          console.error("Invalid JSON for --params");
          return 1;
        }
        state.algorithmConfig.params = { ...state.algorithmConfig.params, ...parsed };
      }
      return 0;
    },

    "meta-adjust": () => {
      const param = flagValue(rest, "param");
      const fromStr = flagValue(rest, "from");
      const toStr = flagValue(rest, "to");
      const cycleStr = flagValue(rest, "cycle");
      const rationale = flagValue(rest, "rationale");

      if (!param || fromStr === undefined || toStr === undefined || !cycleStr) {
        console.error("--param, --from, --to, and --cycle are required");
        return 1;
      }

      if (!state.metaLearnerAdjustments) {
        state.metaLearnerAdjustments = [];
      }

      state.metaLearnerAdjustments.push({
        cycle: parseInt(cycleStr, 10),
        parameter: param,
        previousValue: parseFloat(fromStr),
        newValue: parseFloat(toStr),
        rationale: rationale ?? "",
      });
      return 0;
    },
  };

  const code = dispatch(command, handlers, (c) => {
    console.error(`Unknown command: ${c}`);
    return 1;
  });

  // Original wrote state only on a successful case (never on a validation error / unknown command).
  if (code === 0) writeState(state, dir);
  return code;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch {
    // Silent on error — non-blocking (faithful to the original outer try/catch)
    process.exit(0);
  }
}
