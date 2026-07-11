#!/usr/bin/env bun
/**
 * MigrateApprove — Story 12.4 rewrite onto the std substrate (proof/ consumer; live cutover to
 * ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). Behavior preserved byte-for-byte; the re-rolled
 * fs/arg/date/slug plumbing now imports tested std primitives:
 *   - loadQueue  → parseNdjson(readIfExists(...) ?? "")   (std/core parse + std/fsx)
 *   - saveQueue  → ensureDir + atomicWrite                 (std/fsx, tmp+rename)
 *   - new-file / append writes → atomicWrite / readIfExists+atomicWrite  (std/fsx)
 *   - slug ×2    → slugify(section, 40)                    (std/core)
 *   - ISO dates  → isoDate(now) for `created:` (YYYY-MM-DD); now.toISOString() for full stamps
 *   - committed.jsonl → report.appendAudit                 (genuine append-only audit log, FR9)
 *   - command ladder → dispatch                            (std/core)
 *
 * WIRE FORMAT FROZEN + KEPT CALLER-LOCAL (D4): the `Proposal` shape + status enum
 * (pending|approved|rejected|modified), the NDJSON framing, resolveTargetPath's PAI/MEMORY/TELOS/USER
 * label→path mapping (incl. `${HARNESS_USER_DIR}` + the memory/feedback special-case), the 3-branch
 * commit logic, and both frontmatter templates all stay byte-preserved in THIS file. Paths + `now` are
 * injected via `ctx` so tests are hermetic (mkdtempSync roots + fixed clock).
 *
 * Paired with MigrateScan.ts which enqueues proposals.
 *
 * Usage:
 *   bun migrate-approve.ts --review                   Show all pending proposals
 *   bun migrate-approve.ts --summary                  High-level routing summary
 *   bun migrate-approve.ts --approve <id>             Commit single proposal
 *   bun migrate-approve.ts --modify <id> --target X   Change target then commit
 *   bun migrate-approve.ts --reject <id>              Drop single proposal
 *   bun migrate-approve.ts --approve-target <target>  Bulk approve all proposals for target
 *   bun migrate-approve.ts --approve-all              Commit every pending proposal
 *   bun migrate-approve.ts --reset                    Clear queue (use carefully)
 */

import { join, dirname } from "node:path";
import { dispatch, isoDate, parseNdjson, slugify } from "std/core";
import { atomicWrite, ensureDir, exists, readIfExists } from "std/fsx";
import { appendAudit } from "std/report";

// ─── Wire format (FROZEN — caller-local, D4) ───

type Proposal = {
  id: string;
  timestamp: string;
  source_file: string;
  source_section: string;
  content_preview: string;
  content_full: string;
  proposed_target: string;
  classification_confidence: number;
  classification_reasons: string[];
  alternatives: string[];
  status: "pending" | "approved" | "rejected" | "modified";
};

// ─── Injected edge context (identity + clock, D4) ───

export type Ctx = {
  home: string;
  paiDir: string;
  queueFile: string;
  committedLog: string;
  now: Date;
};

export function defaultCtx(now: Date = new Date()): Ctx {
  const home = process.env.HOME || "";
  const paiDir = process.env.PAI_DIR || join(home, ".claude", "PAI");
  return {
    home,
    paiDir,
    queueFile: join(paiDir, "MEMORY", "MIGRATION", "migration-proposals.jsonl"),
    committedLog: join(paiDir, "MEMORY", "MIGRATION", "committed.jsonl"),
    now,
  };
}

// ─── Queue I/O (std substrate) ───

export function loadQueue(ctx: Ctx): Proposal[] {
  return parseNdjson<Proposal>(readIfExists(ctx.queueFile) ?? "");
}

export function saveQueue(ctx: Ctx, queue: Proposal[]): void {
  ensureDir(dirname(ctx.queueFile));
  atomicWrite(ctx.queueFile, queue.map((p) => JSON.stringify(p)).join("\n") + (queue.length ? "\n" : ""));
}

function logCommit(ctx: Ctx, entry: Record<string, unknown>): void {
  // Genuine append-only audit log with size rotation (FR9 best-effort) — appendAudit is correct here.
  appendAudit(ctx.committedLog, entry);
}

export function resolveTargetPath(ctx: Ctx, target: string): string {
  // Map target label to absolute file path.
  if (target.startsWith("TELOS/") || target.startsWith("USER/") || target.startsWith("MEMORY/")) {
    return join(ctx.paiDir, target.startsWith("USER/") ? target : target);
  }
  if (target === "memory/feedback") {
    // Feedback memories live outside PAI dir in projects/${HARNESS_USER_DIR}/memory/
    return join(ctx.home, ".claude", "projects", "${HARNESS_USER_DIR}", "memory");
  }
  return join(ctx.paiDir, target);
}

// ─── Commit (3-branch logic FROZEN) ───

export function commitProposal(ctx: Ctx, p: Proposal): boolean {
  if (p.proposed_target === "UNCLEAR") {
    console.error(`Cannot commit UNCLEAR proposal. Use --modify first.`);
    return false;
  }

  const targetPath = resolveTargetPath(ctx, p.proposed_target);

  const provenance = `\n<!-- migrated ${ctx.now.toISOString()} from ${p.source_file} :: ${p.source_section} -->\n`;
  const entry = `${provenance}${p.content_full}\n`;

  // Feedback memories = new file per chunk
  if (p.proposed_target === "memory/feedback") {
    ensureDir(targetPath);
    const slug = slugify(p.source_section, 40);
    const filePath = join(targetPath, `feedback_migrated_${slug}_${p.id.slice(0, 8)}.md`);
    const content = `---
name: ${slug}
description: Migrated from ${p.source_file}
type: feedback
created: ${isoDate(ctx.now)}
---

${p.content_full}
`;
    atomicWrite(filePath, content);
    logCommit(ctx, { ...p, committed_at: ctx.now.toISOString(), target_path: filePath });
    console.log(`✅ Committed to ${filePath}`);
    return true;
  }

  // Knowledge dir = new file per chunk
  if (p.proposed_target.startsWith("MEMORY/KNOWLEDGE/")) {
    ensureDir(targetPath);
    const slug = slugify(p.source_section, 40);
    const filePath = join(targetPath, `migrated_${slug}_${p.id.slice(0, 8)}.md`);
    const type = p.proposed_target.split("/").pop()?.toLowerCase().replace(/s$/, "") || "idea";
    const content = `---
title: ${p.source_section}
type: ${type}
tags: [migrated]
created: ${isoDate(ctx.now)}
source: "${p.source_file}"
---

${p.content_full}
`;
    atomicWrite(filePath, content);
    logCommit(ctx, { ...p, committed_at: ctx.now.toISOString(), target_path: filePath });
    console.log(`✅ Committed to ${filePath}`);
    return true;
  }

  // Regular TELOS / USER files = append
  if (!exists(targetPath)) {
    console.error(`Target file does not exist: ${targetPath}`);
    return false;
  }
  const existing = readIfExists(targetPath) ?? "";
  atomicWrite(targetPath, existing + entry);
  logCommit(ctx, { ...p, committed_at: ctx.now.toISOString(), target_path: targetPath });
  console.log(`✅ Committed to ${targetPath}`);
  return true;
}

// ─── Commands ───

export function cmdReview(ctx: Ctx): void {
  const queue = loadQueue(ctx);
  const pending = queue.filter((p) => p.status === "pending");
  if (pending.length === 0) {
    console.log("✅ No pending proposals.");
    return;
  }
  console.log(`═══ ${pending.length} pending proposals ═══\n`);
  for (const p of pending) {
    const conf = Math.round(p.classification_confidence * 100);
    const icon = p.proposed_target === "UNCLEAR" ? "❓" : conf >= 60 ? "✅" : "⚠️";
    console.log(`${icon}  ${p.id.slice(0, 8)}  →  ${p.proposed_target}  (${conf}%)`);
    console.log(`    Source: ${p.source_file} :: ${p.source_section}`);
    console.log(`    Preview: ${p.content_preview}${p.content_full.length > 160 ? "..." : ""}`);
    if (p.alternatives.length) console.log(`    Alternatives: ${p.alternatives.slice(0, 3).join(", ")}`);
    console.log(``);
  }
  console.log(`Approve: bun MigrateApprove.ts --approve <id>`);
  console.log(`Modify:  bun MigrateApprove.ts --modify <id> --target <new_target>`);
  console.log(`Reject:  bun MigrateApprove.ts --reject <id>`);
  console.log(`Bulk:    bun MigrateApprove.ts --approve-target <target>`);
}

export function cmdSummary(ctx: Ctx): void {
  const queue = loadQueue(ctx);
  const pending = queue.filter((p) => p.status === "pending");
  const by: Record<string, { count: number; avg_conf: number }> = {};
  for (const p of pending) {
    by[p.proposed_target] = by[p.proposed_target] || { count: 0, avg_conf: 0 };
    by[p.proposed_target].count += 1;
    by[p.proposed_target].avg_conf += p.classification_confidence;
  }
  console.log(`═══ Migration Queue Summary ═══\n`);
  console.log(`Total pending: ${pending.length}\n`);
  for (const [target, { count, avg_conf }] of Object.entries(by).sort((a, b) => b[1].count - a[1].count)) {
    const conf = Math.round((avg_conf / count) * 100);
    console.log(`  ${target.padEnd(38)}  ${String(count).padStart(3)} chunks  (${conf}% avg confidence)`);
  }
}

export function cmdApprove(ctx: Ctx, id: string): void {
  if (!id) {
    console.error("Error: Approve command requires an ID.");
    return;
  }
  const queue = loadQueue(ctx);
  const idx = queue.findIndex((p) => p.id.startsWith(id) && p.status === "pending");
  if (idx === -1) {
    console.error(`No pending proposal matching id: ${id}`);
    return;
  }
  if (commitProposal(ctx, queue[idx])) {
    queue.splice(idx, 1);
    saveQueue(ctx, queue);
  }
}

export function cmdModify(ctx: Ctx, id: string, newTarget: string): void {
  if (!id) {
    console.error("Error: Modify command requires an ID.");
    return;
  }
  if (!newTarget) {
    console.error("Error: Modify command requires a target.");
    return;
  }
  const queue = loadQueue(ctx);
  const idx = queue.findIndex((p) => p.id.startsWith(id) && p.status === "pending");
  if (idx === -1) {
    console.error(`No pending proposal matching id: ${id}`);
    return;
  }
  queue[idx].proposed_target = newTarget;
  queue[idx].status = "modified";
  if (commitProposal(ctx, queue[idx])) {
    queue.splice(idx, 1);
    saveQueue(ctx, queue);
  }
}

export function cmdReject(ctx: Ctx, id: string): void {
  if (!id) {
    console.error("Error: Reject command requires an ID.");
    return;
  }
  const queue = loadQueue(ctx);
  const idx = queue.findIndex((p) => p.id.startsWith(id) && p.status === "pending");
  if (idx === -1) {
    console.error(`No pending proposal matching id: ${id}`);
    return;
  }
  queue.splice(idx, 1);
  saveQueue(ctx, queue);
  console.log(`🗑️  Rejected ${id}`);
}

export function cmdApproveTarget(ctx: Ctx, target: string): void {
  if (!target) {
    console.error("Error: Approve-target command requires a target.");
    return;
  }
  const queue = loadQueue(ctx);
  const matching = queue.filter((p) => p.proposed_target === target && p.status === "pending");
  if (matching.length === 0) {
    console.log(`No pending proposals for target ${target}`);
    return;
  }
  console.log(`Committing ${matching.length} proposals for ${target}...`);
  // Only drop proposals that ACTUALLY committed — a failed commitProposal keeps
  // its proposal pending rather than losing the chunk silently.
  const committed = new Set(matching.filter((p) => commitProposal(ctx, p)));
  const remaining = queue.filter((p) => !committed.has(p));
  saveQueue(ctx, remaining);
  console.log(`✅ Committed ${committed.size}/${matching.length} proposals for ${target}`);
}

export function cmdApproveAll(ctx: Ctx): void {
  const queue = loadQueue(ctx);
  const pending = queue.filter((p) => p.status === "pending" && p.proposed_target !== "UNCLEAR");
  if (pending.length === 0) {
    console.log("No pending proposals to bulk-approve.");
    return;
  }
  console.log(`Committing ${pending.length} proposals (skipping UNCLEAR)...`);
  // Drop only what actually committed; failed commits stay pending (not lost).
  const committed = new Set(pending.filter((p) => commitProposal(ctx, p)));
  const remaining = queue.filter((p) => !committed.has(p));
  saveQueue(ctx, remaining);
  const unclearLeft = remaining.filter(
    (p) => p.status === "pending" && p.proposed_target === "UNCLEAR",
  ).length;
  console.log(`✅ Committed ${committed.size}/${pending.length}  —  ${unclearLeft} UNCLEAR left for manual routing`);
}

export function cmdReset(ctx: Ctx): void {
  saveQueue(ctx, []);
  console.log("Queue cleared.");
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  bun MigrateApprove.ts --review");
  console.log("  bun MigrateApprove.ts --summary");
  console.log("  bun MigrateApprove.ts --approve <id>");
  console.log("  bun MigrateApprove.ts --modify <id> --target <new>");
  console.log("  bun MigrateApprove.ts --reject <id>");
  console.log("  bun MigrateApprove.ts --approve-target <target>");
  console.log("  bun MigrateApprove.ts --approve-all");
  console.log("  bun MigrateApprove.ts --reset");
}

// ─── Main (command ladder → dispatch, precedence preserved) ───

const COMMANDS = [
  "--review",
  "--summary",
  "--approve-all",
  "--approve-target",
  "--approve",
  "--modify",
  "--reject",
  "--reset",
] as const;

export function main(argv: string[] = process.argv.slice(2), ctx: Ctx = defaultCtx()): number {
  const args = argv;
  let cmd = "";
  for (const c of COMMANDS) {
    if (args.includes(c)) {
      cmd = c;
      break;
    }
  }
  return dispatch(
    cmd,
    {
      "--review": () => {
        cmdReview(ctx);
        return 0;
      },
      "--summary": () => {
        cmdSummary(ctx);
        return 0;
      },
      "--approve-all": () => {
        cmdApproveAll(ctx);
        return 0;
      },
      "--approve-target": () => {
        const target = args[args.indexOf("--approve-target") + 1];
        if (!target || target.startsWith("-")) {
          console.error("Error: --approve-target requires a target parameter.");
          return 1;
        }
        cmdApproveTarget(ctx, target);
        return 0;
      },
      "--approve": () => {
        const id = args[args.indexOf("--approve") + 1];
        if (!id || id.startsWith("-")) {
          console.error("Error: --approve requires an id parameter.");
          return 1;
        }
        cmdApprove(ctx, id);
        return 0;
      },
      "--modify": () => {
        const id = args[args.indexOf("--modify") + 1];
        const target = args[args.indexOf("--target") + 1];
        if (!id || id.startsWith("-")) {
          console.error("Error: --modify requires an id parameter.");
          return 1;
        }
        if (!target || target.startsWith("-")) {
          console.error("--modify requires --target <new_target>");
          return 1;
        }
        cmdModify(ctx, id, target);
        return 0;
      },
      "--reject": () => {
        const id = args[args.indexOf("--reject") + 1];
        if (!id || id.startsWith("-")) {
          console.error("Error: --reject requires an id parameter.");
          return 1;
        }
        cmdReject(ctx, id);
        return 0;
      },
      "--reset": () => {
        cmdReset(ctx);
        return 0;
      },
    },
    () => {
      printUsage();
      return 0;
    },
  );
}

if (import.meta.main) {
  process.exit(main());
}
