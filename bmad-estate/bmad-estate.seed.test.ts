import { describe, expect, test } from "bun:test";
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Identity-free: everything resolves from this file's own location, so no
// consumer home path (/Users/...) is ever committed. The golden `diff -rq`
// faithfulness checks are a one-time seed-time verification recorded as
// provenance in SEEDING.md — they are not a committed regression against
// external absolute paths (would violate D4/NFR3 + fail on reclone/CI).
const ESTATE = import.meta.dir;
const SKILLS = join(ESTATE, "skills");

// The two Default-estate skills, in the order the base marketplace lists them.
const DEFAULT_ESTATE = [
  "./skills/bmad-agent-epic-the-loop",
  "./skills/bmad-agent-jhon-the-loop",
];

// Every skill dir present on disk, mapped to its exact expected file set.
const SKILL_TREES: Record<string, string[]> = {
  "bmad-agent-jhon-the-loop": [
    "SKILL.md",
    "customize.toml",
    "references/adversarial-brief-template.md",
    "references/create-brief-template.md",
    "references/dispatch-loop.md",
    "references/validate-brief-template.md",
  ],
  "bmad-agent-epic-the-loop": [
    "SKILL.md",
    "customize.toml",
    "references/arch-escalation.md",
  ],
  "bmad-agent-dev-the-loop": ["SKILL.md", "customize.toml"],
};

// Bound to the LEADING YAML front matter only (the first `---`…`---` block), so a
// stray `name:` line in the body can never be mistaken for the skill's declared name.
function readFrontmatterName(skillMd: string): string | undefined {
  const text = readFileSync(skillMd, "utf8");
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return undefined;
  const match = fm[1].match(/^name:\s*(.+?)\s*$/m);
  return match?.[1];
}

// Recursive relative listing of REGULAR files under root (sorted). Lets the file-set
// assertion enforce the EXACT tree — extra files under references/ are caught, not just
// stray top-level entries.
function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}

// Every regular file under root carrying ANY executable bit (0o111), as relative paths.
// Returns the offending PATHS rather than a boolean so the failure message names what
// broke the mode-uniformity — an empty-set assertion is only useful if it can point.
function executableFilesUnder(root: string): string[] {
  return listFilesRecursive(root).filter(
    (rel) => (statSync(join(root, rel)).mode & 0o111) !== 0,
  );
}

describe("bmad-estate seed", () => {
  test("AC1/AC5 — marketplace.json parses and lists exactly the two Default-estate skills", () => {
    const raw = require("node:fs").readFileSync(
      join(ESTATE, ".claude-plugin/marketplace.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.plugins[0].skills).toEqual(DEFAULT_ESTATE);
  });

  test("AC5 — dev-the-loop dir exists on disk but is NOT in the base marketplace", () => {
    const raw = require("node:fs").readFileSync(
      join(ESTATE, ".claude-plugin/marketplace.json"),
      "utf8",
    );
    const listed: string[] = JSON.parse(raw).plugins[0].skills;
    expect(existsSync(join(SKILLS, "bmad-agent-dev-the-loop"))).toBe(true);
    expect(listed).not.toContain("./skills/bmad-agent-dev-the-loop");
  });

  test("AC2/AC3 — all three skill dirs exist with EXACTLY their expected file set (recursive)", () => {
    for (const [dir, files] of Object.entries(SKILL_TREES)) {
      const root = join(SKILLS, dir);
      expect(existsSync(root)).toBe(true);
      // Exact-set equality over the full recursive tree: catches both missing files and
      // any stray extra (including inside references/), enforcing the verbatim seed shape.
      expect(listFilesRecursive(root)).toEqual([...files].sort());
    }
  });

  test("BM-21 — no file under bmad-estate carries an executable bit", () => {
    // `diff -rq` (FR-16) compares CONTENT, not MODE (bmad-verify.test.ts case 22). That blindness is
    // tolerable ONLY while this payload is mode-uniform: a mode-uniform module gives Faithfulness no
    // mode channel to be blind on. The day a loop skill ships a runnable script, this goes red and the
    // mechanism question reopens by design — do not silence it, rule it.
    expect(executableFilesUnder(ESTATE)).toEqual([]);
  });

  test("AC2/AC3 — each SKILL.md name matches its dir and ^bmad-[a-z0-9-]+$", () => {
    for (const dir of Object.keys(SKILL_TREES)) {
      const name = readFrontmatterName(join(SKILLS, dir, "SKILL.md"));
      expect(name).toBe(dir);
      expect(name).toMatch(/^bmad-[a-z0-9-]+$/);
    }
  });

  test("AC4 — no wrapper (module.yaml / module-help.csv) anywhere under bmad-estate", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
        } else if (
          entry.name === "module.yaml" ||
          entry.name === "module-help.csv" ||
          entry.name.endsWith(".bmb")
        ) {
          offenders.push(p);
        }
      }
    };
    walk(ESTATE);
    expect(offenders).toEqual([]);
  });
});

