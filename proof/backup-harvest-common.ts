import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir } from "std/fsx";
import { spawnCapture } from "std/proc";

// ============================================================================
// Constants
// ============================================================================

export const CONTEXT_BLOB_RE = /(PREVIOUS AI RESPONSE|RECENT CONVERSATION|<system-reminder>|CURRENT USER MESSAGE)/;
export const TARBALL_RE = /claude.*\.(tar\.gz|tgz)$/i;
export const DATE_RE = /(\d{4})[-_](\d{2})[-_](\d{2})/;

// ============================================================================
// Types
// ============================================================================

export interface Source {
  label: string;
  sortKey: string;
  kind: "dir" | "tarball";
  pathOnDisk: string;
}

export interface Discovered {
  sources: Source[];
  skipped: string[];
}

// ============================================================================
// Helpers
// ============================================================================

/** message.content may be a string or an array of typed blocks; keep text only. */
export function flattenContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

/** Derive a sortable key (YYYY-MM-DD) from a backup label, else "0000-00-00". */
export function dateFromLabel(label: string): string {
  const m = label.match(DATE_RE);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "0000-00-00";
}

export function dateOf(ts?: string): string {
  if (!ts) return "undated";
  const d = ts.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "undated";
}

/** Parameterized discovery to find dirs and tarballs. */
export function discoverBackupSources(
  backupsDir: string,
  includeTarballs: boolean,
  outDir: string,
  wantLearning = false
): Discovered {
  const sources: Source[] = [];
  const skipped: string[] = [];
  const outBase = path.basename(outDir);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(backupsDir, { withFileTypes: true });
  } catch (e) {
    console.error(`Cannot read backups dir: ${backupsDir}`);
    return { sources, skipped };
  }

  for (const e of entries) {
    const full = path.join(backupsDir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith("_") || e.name === outBase) continue; // our own output
      const projects = path.join(full, "projects");
      const hasProjects = fs.existsSync(projects) && fs.statSync(projects).isDirectory();

      let hasLearning = false;
      if (wantLearning) {
        hasLearning =
          fs.existsSync(path.join(full, "LIFEOS", "MEMORY", "LEARNING")) ||
          fs.existsSync(path.join(full, ".claude", "LIFEOS", "MEMORY", "LEARNING")) ||
          fs.existsSync(path.join(full, "PAI", "MEMORY", "LEARNING")) ||
          fs.existsSync(path.join(full, ".claude", "PAI", "MEMORY", "LEARNING"));
      }

      if (hasProjects || (wantLearning && hasLearning)) {
        sources.push({
          label: e.name,
          sortKey: dateFromLabel(e.name),
          kind: "dir",
          pathOnDisk: full,
        });
      }
    } else if (e.isFile()) {
      if (!includeTarballs) continue;
      if (TARBALL_RE.test(e.name)) {
        sources.push({
          label: e.name,
          sortKey: dateFromLabel(e.name),
          kind: "tarball",
          pathOnDisk: full,
        });
      } else if (/claude.*\.zip$/i.test(e.name)) {
        skipped.push(`${e.name} (.zip — extract manually if its dir twin is absent)`);
      }
    }
  }
  return { sources, skipped };
}

/** Selectively extract files matching includePatterns from a tarball into tmpRoot; return paths. */
export async function extractTarball(
  tarFile: string,
  tmpRoot: string,
  includePatterns: string[]
): Promise<{ projects: string | null; learning: string | null }> {
  ensureDir(tmpRoot);
  const args = ["-xzf", tarFile, "-C", tmpRoot];
  for (const pat of includePatterns) {
    args.push("--include", pat);
  }
  await spawnCapture("tar", args);

  const find = (cands: string[]) => cands.find((c) => fs.existsSync(c)) ?? null;
  return {
    projects: find([path.join(tmpRoot, ".claude", "projects"), path.join(tmpRoot, "projects")]),
    learning: find([
      path.join(tmpRoot, ".claude", "LIFEOS", "MEMORY", "LEARNING"),
      path.join(tmpRoot, "LIFEOS", "MEMORY", "LEARNING"),
      path.join(tmpRoot, ".claude", "PAI", "MEMORY", "LEARNING"),
      path.join(tmpRoot, "PAI", "MEMORY", "LEARNING"),
    ]),
  };
}
