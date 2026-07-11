#!/usr/bin/env bun
/**
 * ProposeCurrentStateEntry — Story 12.4 rewrite onto the std substrate (proof/ consumer; live cutover
 * to ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). Pollers and _LIFELOG extractors enqueue
 * CURRENT_STATE proposals here; ApproveCurrentStateEntries.ts consumes the queue and commits approved
 * entries. Behavior preserved (same CLI flags, same stdout/stderr bytes, same exit codes); the re-rolled
 * argv parsing now imports tested std primitives (`flagValue`/`hasFlag`), and the dir-create adopts
 * `fsx.ensureDir`.
 *
 * WIRE FORMAT FROZEN — the queue is NDJSON of `{id, timestamp, source, target, payload, status}` with
 * status ∈ (`pending`|`approved`|`rejected`); the proposer only ever writes `pending`. This shape is a
 * contract with ApproveCurrentStateEntries.ts and must not drift.
 *
 * The per-record queue append stays a PLAIN node:fs `appendFileSync(path, JSON.stringify(x) + "\n")` —
 * it is a functional queue that must never lose or roll records, so it does NOT use report.appendAudit
 * (which rotates). The trailing-`\n` / one-object-per-line framing is preserved verbatim.
 *
 * Kept caller-local (D4): the CURRENT_STATE queue path (`~/.claude` / PAI_DIR / USER/TELOS), the
 * ALLOWED_SOURCES / ALLOWED_TARGETS vocabularies, and the {{PRINCIPAL_NAME}} Decision-#5 semantics.
 * All injected through `ProposeConfig` so the tests are hermetic (a mkdtemp queue dir + fixed clock/id).
 *
 * Usage:
 *   bun propose-current-state-entry.ts --source <src> --target <file> --json '<payload>'
 *
 * Example:
 *   bun propose-current-state-entry.ts \
 *     --source lifelog --target CONSUMPTION \
 *     --json '{"category":"restaurant","name":"Papaya Thai","cuisine":"thai","visited":"2026-04-14"}'
 */

import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { flagValue, hasFlag } from "std/core";
import { ensureDir } from "std/fsx";

// ─── Caller-local identity (D4) — injected via ProposeConfig; never crosses into src/** ───

const ALLOWED_SOURCES = ["lifelog", "calendar", "gmail", "homebridge", "manual", "amazon", "bills"] as const;
const ALLOWED_TARGETS = ["CONSUMPTION", "ACTIVITY", "SOCIAL", "FINANCIAL", "SIGNALS", "SNAPSHOT"] as const;

/** Frozen wire status enum — shared contract with ApproveCurrentStateEntries.ts. */
export type ProposalStatus = "pending" | "approved" | "rejected";

/** Frozen wire record shape — one JSON object per queue line. */
export interface Proposal {
  id: string;
  timestamp: string;
  source: string;
  target: string;
  payload: Record<string, unknown>;
  status: ProposalStatus;
}

/** Everything the tool needs from its edge — injected so tests run against a tmp dir + fixed clock. */
export interface ProposeConfig {
  queueFile: string;
  allowedSources: readonly string[];
  allowedTargets: readonly string[];
  now: Date;
  makeId: () => string;
}

/** The live edge config (reads env identity). Tests build their own hermetic config instead. */
export function defaultConfig(): ProposeConfig {
  const HOME = process.env.HOME || "";
  const PAI_DIR = process.env.PAI_DIR || join(HOME, ".claude", "PAI");
  return {
    queueFile: join(PAI_DIR, "USER", "TELOS", "CURRENT_STATE", "proposals.jsonl"),
    allowedSources: ALLOWED_SOURCES,
    allowedTargets: ALLOWED_TARGETS,
    now: new Date(),
    makeId: randomUUID,
  };
}

type ParsedArgs =
  | { ok: true; source: string; target: string; payload: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * Parse + validate the argv. Faithful to the original: missing any of the three flags → the required-
 * flags error; a source/target outside the allowed vocab → the corresponding "must be one of" error; an
 * unparseable `--json` value → the invalid-payload error. Presence is `--flag` in either the space or
 * `=` form (flagValue) or a bare/last `--flag` token (hasFlag).
 */
export function parseArgs(args: string[], cfg: ProposeConfig): ParsedArgs {
  const present = (name: string): boolean => hasFlag(args, name) || flagValue(args, name) !== undefined;

  if (!present("source") || !present("target") || !present("json")) {
    return { ok: false, message: "Required flags: --source <src> --target <TARGET_FILE> --json '<payload>'" };
  }

  const source = flagValue(args, "source") as string;
  const target = flagValue(args, "target") as string;

  if (!cfg.allowedSources.includes(source)) {
    return { ok: false, message: `source must be one of: ${cfg.allowedSources.join(", ")}` };
  }
  if (!cfg.allowedTargets.includes(target)) {
    return { ok: false, message: `target must be one of: ${cfg.allowedTargets.join(", ")}` };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(flagValue(args, "json")!);
  } catch (err) {
    return { ok: false, message: `Invalid JSON payload: ${(err as Error).message}` };
  }

  return { ok: true, source, target, payload };
}

/** Stamp a pending proposal. `now`/`id` are injected (D1/D4) so the record is deterministic under test. */
export function buildProposal(
  source: string,
  target: string,
  payload: Record<string, unknown>,
  cfg: ProposeConfig,
): Proposal {
  return {
    id: cfg.makeId(),
    // Full ISO-8601 datetime — the frozen wire timestamp. `now` is injected (lifts the ambient clock,
    // D1) but NOT truncated to a date. std's isoDate(now) was the near-fit primitive; it slices to
    // YYYY-MM-DD, which would drop the time-of-day the contract carries, so toISOString stays here.
    timestamp: cfg.now.toISOString(),
    source,
    target,
    payload,
    status: "pending",
  };
}

/**
 * Append one proposal to the NDJSON queue. PLAIN node:fs append (not report.appendAudit) — a functional
 * queue must never lose or rotate records. `ensureDir` (fsx) creates the queue dir; the framing is the
 * verbatim `JSON.stringify(proposal) + "\n"` one-object-per-line.
 */
export function enqueue(queueFile: string, proposal: Proposal): void {
  ensureDir(dirname(queueFile));
  appendFileSync(queueFile, JSON.stringify(proposal) + "\n");
}

export function main(args: string[] = process.argv.slice(2), cfg: ProposeConfig = defaultConfig()): number {
  const parsed = parseArgs(args, cfg);
  if (!parsed.ok) {
    console.error(parsed.message);
    return 1;
  }

  const proposal = buildProposal(parsed.source, parsed.target, parsed.payload, cfg);
  enqueue(cfg.queueFile, proposal);

  console.log(`✅ Proposal ${proposal.id} enqueued (${parsed.source} → ${parsed.target})`);
  console.log(`Review with: bun ApproveCurrentStateEntries.ts --review`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
