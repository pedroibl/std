import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultFramesDir,
  main,
  parseObservationCount,
  updateFrame,
  type UpdateResult,
} from "./wisdom-frame-updater";

// Fixed clock so every date stamp is deterministic (isoDate is UTC).
const NOW = new Date("2026-07-12T09:30:00Z");
const DATE = "2026-07-12";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wisdom-frame-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (domain: string) => readFileSync(join(dir, `${domain}.md`), "utf-8");

// The exact bytes an evolution-type create must emit — the cross-tool read contract that
// WisdomCrossFrameSynthesizer / WisdomDomainClassifier parse. Reproduced independently here.
const expectedEvolutionFrame = (domain: string, observation: string) =>
  `# Frame: ${domain.charAt(0).toUpperCase() + domain.slice(1)} Domain

## Meta
- **Domain:** ${domain}
- **Confidence:** 50%
- **Observation Count:** 1
- **Last Crystallized:** ${DATE}
- **Source:** Auto-created from observation

---

## Core Principles

*No crystallized principles yet. Observations accumulating.*

---

## Contextual Rules

*None yet.*

---

## Predictive Model

| Request Pattern | Predicted Want | Confidence |
|----------------|---------------|------------|


---

## Anti-Patterns (from observations)

*None yet.*

---

## Cross-Frame Connections

*To be discovered through cross-frame synthesis.*

---

## Evolution Log
- ${DATE}: Frame created with initial observation: ${observation}
`;

describe("create (frame does not exist)", () => {
  test("emits the byte-exact template + correct envelope", () => {
    const res = updateFrame(dir, "communication", "Pedro prefers bullets", "evolution", NOW);
    expect(res).toEqual({
      success: true,
      domain: "communication",
      type: "evolution",
      message: `Created new frame for domain "communication" with initial observation`,
      framePath: join(dir, "communication.md"),
    });
    expect(read("communication")).toBe(
      expectedEvolutionFrame("communication", "Pedro prefers bullets"),
    );
  });

  test("contextual-rule create seeds the rule line", () => {
    updateFrame(dir, "dev", "Ask before refactor", "contextual-rule", NOW);
    expect(read("dev")).toContain(`## Contextual Rules\n\n- Ask before refactor (learned ${DATE})`);
  });

  test("prediction create seeds a table row", () => {
    updateFrame(dir, "dev", "User asks X", "prediction", NOW);
    expect(read("dev")).toContain("| User asks X | To be refined | 60% |");
  });

  test("anti-pattern create seeds the anti-pattern block", () => {
    updateFrame(dir, "dev", "Silent deploy", "anti-pattern", NOW);
    const md = read("dev");
    expect(md).toContain("### Silent deploy");
    expect(md).toContain("- **Severity:** Medium");
  });
});

describe("getMetaField round-trip", () => {
  test("write a frame → read its observation count back", () => {
    updateFrame(dir, "communication", "obs one", "evolution", NOW);
    expect(parseObservationCount(read("communication"))).toBe(1);

    // Second observation increments the count in-place.
    updateFrame(dir, "communication", "obs two", "evolution", NOW);
    expect(parseObservationCount(read("communication"))).toBe(2);

    updateFrame(dir, "communication", "obs three", "evolution", NOW);
    expect(parseObservationCount(read("communication"))).toBe(3);
  });

  test("parseObservationCount is 0 when the field is absent", () => {
    expect(parseObservationCount("# Frame with no meta")).toBe(0);
  });
});

describe("update (existing frame)", () => {
  const seed = (domain: string, type: Parameters<typeof updateFrame>[3] = "evolution") =>
    updateFrame(dir, domain, "seed observation", type, NOW);

  test("increments count and refreshes the crystallized date", () => {
    // Seed with a stale crystallized date, then update with NOW.
    seed("dev");
    const stale = read("dev").replace(`**Last Crystallized:** ${DATE}`, "**Last Crystallized:** 2020-01-01");
    writeFileSync(join(dir, "dev.md"), stale);

    updateFrame(dir, "dev", "later observation", "evolution", NOW);
    const md = read("dev");
    expect(md).toContain("**Observation Count:** 2");
    expect(md).toContain(`**Last Crystallized:** ${DATE}`);
    expect(md).not.toContain("2020-01-01");
  });

  test("evolution update appends to the Evolution Log and preserves other sections", () => {
    seed("dev");
    updateFrame(dir, "dev", "a new evolution", "evolution", NOW);
    const md = read("dev");
    expect(md).toContain(`- ${DATE}: a new evolution`);
    // Original seed line still present.
    expect(md).toContain("Frame created with initial observation: seed observation");
    // Section headings intact (cross-tool contract).
    expect(md).toContain("## Cross-Frame Connections");
    expect(md).toContain("## Predictive Model");
  });

  test("anti-pattern update splices a block AND logs an evolution entry", () => {
    seed("dev");
    const res = updateFrame(dir, "dev", "pushed without tests", "anti-pattern", NOW);
    const md = read("dev");
    expect(md).toContain("### pushed without tests");
    expect(md).toContain(`- ${DATE}: New anti-pattern observed: pushed without tests`);
    // The new block lands inside Anti-Patterns, before Cross-Frame.
    expect(md.indexOf("### pushed without tests")).toBeLessThan(md.indexOf("## Cross-Frame Connections"));
    expect(res.type).toBe("anti-pattern");
  });

  test("contextual-rule update splices a rule AND logs evolution", () => {
    seed("dev");
    updateFrame(dir, "dev", "always confirm scope", "contextual-rule", NOW);
    const md = read("dev");
    expect(md).toContain(`- always confirm scope (learned ${DATE})`);
    expect(md).toContain(`- ${DATE}: New contextual rule: always confirm scope`);
    // Rule sits inside Contextual Rules, before Predictive Model.
    expect(md.indexOf("always confirm scope (learned")).toBeLessThan(md.indexOf("## Predictive Model"));
  });

  test("prediction update adds a table row AND logs evolution", () => {
    seed("dev");
    updateFrame(dir, "dev", "user requests a summary", "prediction", NOW);
    const md = read("dev");
    expect(md).toContain("| user requests a summary | To be refined | 60% |");
    expect(md).toContain(`- ${DATE}: New prediction added: user requests a summary`);
    // Row sits inside the Predictive Model table, before Anti-Patterns.
    expect(md.indexOf("user requests a summary | To be refined")).toBeLessThan(
      md.indexOf("## Anti-Patterns"),
    );
  });

  test("principle update logs an evolution entry only", () => {
    seed("dev");
    const before = read("dev");
    updateFrame(dir, "dev", "verify before claiming", "principle", NOW);
    const md = read("dev");
    expect(md).toContain(`- ${DATE}: Principle candidate observed: verify before claiming`);
    // No new anti-pattern / rule / prediction row was added.
    expect(md).not.toContain("### verify before claiming");
    // Count still bumped.
    expect(before).toContain("**Observation Count:** 1");
    expect(md).toContain("**Observation Count:** 2");
  });

  test("multiple evolution appends stack in order", () => {
    seed("dev");
    updateFrame(dir, "dev", "second", "evolution", NOW);
    updateFrame(dir, "dev", "third", "evolution", NOW);
    const md = read("dev");
    expect(md.indexOf("seed observation")).toBeLessThan(md.indexOf("second"));
    expect(md.indexOf("second")).toBeLessThan(md.indexOf("third"));
    expect(parseObservationCount(md)).toBe(3);
  });
});

describe("main() CLI", () => {
  let out: string;
  let err: string;
  let origOut: typeof process.stdout.write;
  let origErr: typeof console.error;
  let origLog: typeof console.log;

  beforeEach(() => {
    out = "";
    err = "";
    origOut = process.stdout.write.bind(process.stdout);
    origErr = console.error;
    origLog = console.log;
    // emitJson writes via process.stdout.write; --help prints via console.log (a separate path in Bun).
    (process.stdout.write as unknown) = (chunk: string) => {
      out += chunk;
      return true;
    };
    console.log = (msg?: unknown) => {
      out += `${String(msg ?? "")}\n`;
    };
    console.error = (msg?: unknown) => {
      err += String(msg ?? "");
    };
  });
  afterEach(() => {
    (process.stdout.write as unknown) = origOut;
    console.error = origErr;
    console.log = origLog;
  });

  test("--help returns 0 and prints usage", () => {
    // console.log also routes through stdout.write in Bun.
    const code = main(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("WisdomFrameUpdater - Update Wisdom Frames");
  });

  test("missing required args returns 1 and errors", () => {
    const code = main(["--domain", "communication"]);
    expect(code).toBe(1);
    expect(err).toContain("Required: --domain and --observation");
  });

  test("full run emits the JSON envelope (2-space, trailing newline)", () => {
    // Point the default frames dir at the tmp dir via PAI_DIR so main() stays hermetic.
    const prev = process.env.PAI_DIR;
    process.env.PAI_DIR = dir;
    try {
      const code = main(["--domain", "comms", "--observation", "prefers bullets", "--type", "evolution"]);
      expect(code).toBe(0);
      const parsed = JSON.parse(out) as UpdateResult;
      expect(parsed.success).toBe(true);
      expect(parsed.domain).toBe("comms");
      expect(parsed.type).toBe("evolution");
      expect(out.endsWith("\n")).toBe(true);
      expect(out).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
      // The frame was actually written under $PAI_DIR/MEMORY/WISDOM/FRAMES.
      const written = readFileSync(join(dir, "MEMORY", "WISDOM", "FRAMES", "comms.md"), "utf-8");
      expect(written).toContain("**Observation Count:** 1");
    } finally {
      if (prev === undefined) delete process.env.PAI_DIR;
      else process.env.PAI_DIR = prev;
    }
  });

  test("--type=value equals form is accepted", () => {
    process.stdout.write = origOut; // let updateFrame's write path proceed silently
    const res = updateFrame(dir, "d", "o", "prediction", NOW);
    expect(res.type).toBe("prediction");
  });
});

describe("defaultFramesDir", () => {
  test("resolves under the given base", () => {
    expect(defaultFramesDir("/x/.claude")).toBe(join("/x/.claude", "MEMORY", "WISDOM", "FRAMES"));
  });
});

describe("RT-2 framework-dir resolution (AD-9.3)", () => {
  // ambient shell may export a real PAI_DIR — control LIFEOS_DIR+PAI_DIR+HOME explicitly and restore.
  const KEYS = ["LIFEOS_DIR", "PAI_DIR", "HOME"] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("LIFEOS_DIR wins over PAI_DIR", () => {
    process.env.LIFEOS_DIR = "/life";
    process.env.PAI_DIR = "/pai";
    expect(defaultFramesDir()).toBe(join("/life", "MEMORY", "WISDOM", "FRAMES"));
  });

  test("PAI_DIR honored when LIFEOS_DIR unset", () => {
    delete process.env.LIFEOS_DIR;
    process.env.PAI_DIR = "/pai";
    expect(defaultFramesDir()).toBe(join("/pai", "MEMORY", "WISDOM", "FRAMES"));
  });

  test("neither env set → resolver falls back to LIFEOS under a fresh temp home", () => {
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    const home = mkdtempSync(join(tmpdir(), "rt2-"));
    process.env.HOME = home;
    try {
      expect(defaultFramesDir()).toBe(join(home, ".claude", "LIFEOS", "MEMORY", "WISDOM", "FRAMES"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("legacy PAI tree present → resolver picks PAI", () => {
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    const home = mkdtempSync(join(tmpdir(), "rt2-"));
    mkdirSync(join(home, ".claude", "PAI"), { recursive: true });
    process.env.HOME = home;
    try {
      expect(defaultFramesDir()).toBe(join(home, ".claude", "PAI", "MEMORY", "WISDOM", "FRAMES"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
