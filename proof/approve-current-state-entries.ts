#!/usr/bin/env bun
/**
 * ApproveCurrentStateEntries — Story 12.4 rewrite onto the std substrate (proof/ consumer; live cutover
 * to ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). Behavior preserved byte-for-byte; the re-rolled
 * queue plumbing now imports tested std primitives:
 *   - loadQueue  → parseNdjson(readIfExists(path) ?? "")   (std/core + std/fsx)
 *   - saveQueue  → fsx.atomicWrite                         (std/fsx)
 *   - the target-commit read/exists/write → fsx.readIfExists / exists / atomicWrite
 *   - flag command routing → core.hasFlag + core.dispatch
 *
 * This is the SECOND record shape run through the queue plumbing (the CurrentState proposal record vs the
 * Migrate pair). That two-shape evidence is exactly what justifies DEFERRING a generic `queue` slice —
 * the two callers share no wire format, only the NDJSON framing that `parseNdjson` already owns.
 *
 * Kept caller-local (D4 — identity/format/vocab never crosses into src): the CurrentState record shape
 * `{id, timestamp, source, target, payload, status}` + the `pending|approved|rejected` status enum, the
 * `~/.claude/PAI/USER/TELOS/CURRENT_STATE` paths (injected at the edge), `formatPayload`, the YAML-list
 * commit rendering + `<!-- approved … -->` audit comment, every console string (glyphs, headers, usage),
 * and the `{{PRINCIPAL_NAME}}` doctrine reference.
 */
import { dispatch, hasFlag, parseNdjson } from "std/core";
import { atomicWrite, exists, readIfExists, resolveFrameworkDir } from "std/fsx";
import { join } from "node:path";

// ─── Identity / paths — caller-local (D4), injected for hermetic tests ───
export type Paths = { queueFile: string; currentStateDir: string };

export function defaultPaths(): Paths {
  const HOME = process.env.HOME || "";
  const PAI_DIR = process.env.LIFEOS_DIR || process.env.PAI_DIR || resolveFrameworkDir(HOME);
  const currentStateDir = join(PAI_DIR, "USER", "TELOS", "CURRENT_STATE");
  return {
    queueFile: join(currentStateDir, "proposals.jsonl"),
    currentStateDir,
  };
}

// ─── Wire format — FROZEN, caller-local (D4) ───
export type Proposal = {
  id: string;
  timestamp: string;
  source: string;
  target: string;
  payload: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
};

// ─── Queue plumbing (now on std substrate) ───
export function loadQueue(queueFile: string): Proposal[] {
  return parseNdjson<Proposal>(readIfExists(queueFile) ?? "");
}

export function saveQueue(queueFile: string, queue: Proposal[]): void {
  atomicWrite(queueFile, queue.map((p) => JSON.stringify(p)).join("\n") + (queue.length ? "\n" : ""));
}

// ─── Payload rendering — caller-local, byte-preserved ───
export function formatPayload(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .map(([k, v]) => `    ${k}: ${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`)
    .join("\n");
}

export function reviewQueue(paths: Paths): void {
  const queue = loadQueue(paths.queueFile);
  const pending = queue.filter((p) => p.status === "pending");
  if (pending.length === 0) {
    console.log("✅ No pending proposals.");
    return;
  }
  console.log(`═══ Pending proposals (${pending.length}) ═══\n`);
  for (const p of pending) {
    console.log(`ID: ${p.id}`);
    console.log(`  Source: ${p.source}    Target: ${p.target}    At: ${p.timestamp}`);
    console.log(`  Payload:`);
    console.log(formatPayload(p.payload));
    console.log("");
  }
  console.log(`Approve: bun ApproveCurrentStateEntries.ts --approve <id>`);
  console.log(`Reject:  bun ApproveCurrentStateEntries.ts --reject <id>`);
  console.log(`Bulk:    bun ApproveCurrentStateEntries.ts --approve-all`);
}

// ─── YAML-list commit — caller-local, byte-preserved (read/exists/write on fsx) ───
export function appendToTarget(
  currentStateDir: string,
  target: string,
  payload: Record<string, unknown>,
  source: string,
  now: () => Date = () => new Date(),
): void {
  const targetFile = join(currentStateDir, `${target}.md`);
  if (!exists(targetFile)) {
    console.error(`Target file does not exist: ${targetFile}`);
    return;
  }
  const existing = readIfExists(targetFile) ?? "";
  const entry = [
    "",
    `<!-- approved ${now().toISOString()} from ${source} -->`,
    "- " +
      Object.entries(payload)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`)
        .join("\n  "),
  ].join("\n");
  atomicWrite(targetFile, existing + entry + "\n");
}

export function approve(paths: Paths, id: string, now: () => Date = () => new Date()): void {
  const queue = loadQueue(paths.queueFile);
  const idx = queue.findIndex((p) => p.id === id && p.status === "pending");
  if (idx === -1) {
    console.error(`No pending proposal with id: ${id}`);
    return;
  }
  const p = queue[idx];
  appendToTarget(paths.currentStateDir, p.target, p.payload, p.source, now);
  queue.splice(idx, 1);
  saveQueue(paths.queueFile, queue);
  console.log(`✅ Approved and committed: ${id} → ${p.target}`);
}

export function reject(paths: Paths, id: string): void {
  const queue = loadQueue(paths.queueFile);
  const before = queue.length;
  const filtered = queue.filter((p) => !(p.id === id && p.status === "pending"));
  if (filtered.length === before) {
    console.error(`No pending proposal with id: ${id}`);
    return;
  }
  saveQueue(paths.queueFile, filtered);
  console.log(`🗑️  Rejected: ${id}`);
}

export function approveAll(paths: Paths, now: () => Date = () => new Date()): void {
  const queue = loadQueue(paths.queueFile);
  const pending = queue.filter((p) => p.status === "pending");
  if (pending.length === 0) {
    console.log("No pending proposals.");
    return;
  }
  console.log(`Approving ${pending.length} proposals...`);
  for (const p of pending) {
    appendToTarget(paths.currentStateDir, p.target, p.payload, p.source, now);
  }
  const remaining = queue.filter((p) => p.status !== "pending");
  saveQueue(paths.queueFile, remaining);
  console.log(`✅ ${pending.length} proposals approved and committed.`);
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  bun ApproveCurrentStateEntries.ts --review");
  console.log("  bun ApproveCurrentStateEntries.ts --approve <id>");
  console.log("  bun ApproveCurrentStateEntries.ts --reject <id>");
  console.log("  bun ApproveCurrentStateEntries.ts --approve-all");
}

export function main(
  argv: string[] = process.argv.slice(2),
  paths: Paths = defaultPaths(),
  now: () => Date = () => new Date(),
): number {
  // Flag → command routing preserves the original if/else-if priority order exactly.
  const command = hasFlag(argv, "review")
    ? "review"
    : hasFlag(argv, "approve-all")
      ? "approve-all"
      : hasFlag(argv, "approve")
        ? "approve"
        : hasFlag(argv, "reject")
          ? "reject"
          : "";

  const handlers: Record<string, () => number> = {
    review: () => {
      reviewQueue(paths);
      return 0;
    },
    "approve-all": () => {
      approveAll(paths, now);
      return 0;
    },
    // Space-form id extraction, byte-faithful to the original `args[indexOf+1]`.
    approve: () => {
      approve(paths, argv[argv.indexOf("--approve") + 1], now);
      return 0;
    },
    reject: () => {
      reject(paths, argv[argv.indexOf("--reject") + 1]);
      return 0;
    },
  };

  return dispatch(command, handlers, () => {
    printUsage();
    return 0;
  });
}

if (import.meta.main) {
  process.exit(main());
}
