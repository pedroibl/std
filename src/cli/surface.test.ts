import { describe, expect, test } from "bun:test";

import { bmadHandlers } from "../bmad/cli";
import { defaultBmadDeps, type BmadDeps } from "../bmad/deps";
import { CN_SPEC } from "./cn-deploy";
import { DASHKIT_SPEC } from "./dashkit-deploy";
import {
  BMAD_FLAG_GROUPS,
  HELP_OPTION_BLOCKS,
  SURFACE,
  flagEnum,
  flagNames,
  renderAliasUsage,
  subNames,
  type BmadSub,
  type CommandSurface,
} from "./surface";

/** `bmadHandlers` only builds closures — nothing is dispatched here, only the map's KEYS are read. */
function fakeDeps(): BmadDeps {
  return defaultBmadDeps({});
}

const S: CommandSurface = SURFACE;

describe("SURFACE is validated, serializable DATA (AC1)", () => {
  // `toStrictEqual`, NOT `toEqual`: `toEqual` treats an `undefined`-valued key as equal to an absent one,
  // which is half of what this assert is for. A function value (`desc: () => "…"`) is dropped by
  // `JSON.stringify` and fails the round-trip; so is an explicitly-`undefined` optional key — which is
  // why optional keys must be ABSENT, the same conditional-assignment discipline `parseBmadOpts` uses.
  test("round-trips through JSON unchanged — no function values, no undefined-valued keys", () => {
    expect(JSON.parse(JSON.stringify(SURFACE))).toStrictEqual(SURFACE as unknown as object);
  });

  // The one guard that proves AC5 is not inert. If `SURFACE` were written `: CommandSurface` instead of
  // `as const satisfies CommandSurface`, every `name` widens to `string` and `BmadSub` resolves to
  // `never` — and `Record<never, …>` accepts a handler map with missing AND extra keys. Both degenerate
  // forms (`never` and `string`) break the pair of lines below, so this fires either way.
  test("BmadSub is a real string-literal union, not `never` and not `string`", () => {
    const _subsAreLiterals: BmadSub = "install";
    // @ts-expect-error — fires ONLY if BmadSub is a real 4-member literal union
    const _notAnySub: BmadSub = "TOTALLY_MADE_UP";
    expect(_subsAreLiterals).toBe("install");
    // Compared via `typeof`: a direct `.toBe("TOTALLY_MADE_UP")` is itself a type error under the real
    // union, and it sits outside the one line the `@ts-expect-error` above covers.
    expect(typeof _notAnySub).toBe("string");
  });

  test("the four commands, in shipped order", () => {
    expect(S.commands.map((c) => c.name)).toEqual(["alias", "cn", "dashkit", "bmad"]);
    expect(subNames(S, "alias")).toEqual([]);
    expect(subNames(S, "cn")).toEqual(["deploy", "verify"]);
    expect(subNames(S, "dashkit")).toEqual(["deploy", "verify"]);
    expect(subNames(S, "bmad")).toEqual(["install", "update", "deploy", "verify"]);
  });

  // 3.2's addition: the completer's top-level `_describe` needs one line per COMMAND, and `HELP` renders
  // none (its `commands:` block is keyed by help group). Required rather than optional, so a fifth
  // command cannot land without one and complete as a bare name.
  test("every command carries its own non-empty desc, and none names a vault", () => {
    for (const c of S.commands) {
      expect(c.desc.length, c.name).toBeGreaterThan(0);
      // `check:no-consumer-ids` globs `src/**` skipping only `*.test.ts`, so `surface.ts` IS scanned and
      // two of its six denylisted names are vaults. A vault-named description here is a RED BUILD, not
      // a style question — this pins the intent next to the data, ahead of the gate.
      expect(c.desc, c.name).not.toMatch(/zDrafts|note-report/);
    }
  });

  test("every subcommand carries its own non-empty desc", () => {
    for (const c of S.commands) {
      for (const sub of c.subcommands) {
        expect(sub.desc.length, `${c.name} ${sub.name}`).toBeGreaterThan(0);
      }
    }
  });

  test("every flag carries a non-empty desc, and a `value` flag carries a metavar", () => {
    for (const c of S.commands) {
      for (const f of [...(c.flags ?? []), ...c.subcommands.flatMap((s) => s.flags)]) {
        expect(f.desc.length, `${c.name} ${f.name}`).toBeGreaterThan(0);
        if (f.arity === "value") expect(f.metavar, `${c.name} ${f.name}`).toBeDefined();
      }
    }
  });
});

describe("accessors — the unknown-name contract (AC1)", () => {
  // A SPECIFIED contract, not an accident: every absence assertion in AC6/AC7 rests on it, and 3.2's
  // completer probe rests on telling "no flags here" apart from "no such path".
  test("an unresolved name returns empty, never throws", () => {
    expect(subNames(S, "nope")).toEqual([]);
    expect(flagNames(S, "nope", "x")).toEqual([]);
    expect(flagNames(S, "cn", "nope")).toEqual([]);
    expect(flagEnum(S, "cn", "deploy", "--nope")).toBeUndefined();
    expect(flagEnum(S, "nope", "deploy", "--format")).toBeUndefined();
    expect(() => subNames(S, "nope")).not.toThrow();
    expect(() => flagNames(S, "nope")).not.toThrow();
    expect(() => flagEnum(S, "nope", "nope", "nope")).not.toThrow();
  });

  // `sub` is optional because `alias` carries flags and no subcommands — the two-shape split the
  // completer faces. Omitting it reads the COMMAND's own flags.
  test("flagNames resolves a flags-only command when `sub` is omitted", () => {
    expect(flagNames(S, "alias")).toEqual(["--install"]);
    expect(flagNames(S, "bmad")).toEqual([]); // bmad's flags live on its subcommands
  });
});

describe("the bmad flag matrix is represented EXACTLY (AC6)", () => {
  const ALL8 = [
    "--apply",
    "--push",
    "--force-track",
    "--repos",
    "--tools",
    "--set",
    "--skills",
    "--json",
  ];

  test("install and update accept all eight", () => {
    expect(flagNames(S, "bmad", "install")).toEqual(ALL8);
    expect(flagNames(S, "bmad", "update")).toEqual(ALL8);
  });

  // The load-bearing assertion. `deploy --repos` exits 2 — the BM-1 family USAGE code, not 1 — logged
  // and returned before anything is read (`deploy.ts:60`, pinned by `cli-dryrun.test.ts`'s refusal
  // test). A model that offered it would complete a flag the command rejects outright.
  test("deploy REFUSES --repos, so the model must not offer it (BM-19)", () => {
    expect(flagNames(S, "bmad", "deploy")).not.toContain("--repos");
    expect(flagNames(S, "bmad", "deploy")).toEqual(ALL8.filter((f) => f !== "--repos"));
  });

  // The other absence, and the quieter one: `verify --apply` raises NO error at all. `cli.ts` calls
  // `parseBmadOpts(rest)` for verify too, so it is literally parsed and then never read (`VerifyOpts`
  // has no such field). Offering it in a completer is silent nonsense rather than a visible failure —
  // which is exactly why it has to be asserted here rather than left to a runtime probe.
  test("verify accepts only its own three — exact set AND order", () => {
    expect(flagNames(S, "bmad", "verify")).toEqual(["--repos", "--skills", "--json"]);
    expect(flagNames(S, "bmad", "verify")).not.toContain("--apply");
  });

  test("--set is the one repeatable flag; the three selectors are comma-lists", () => {
    const install = S.commands.find((c) => c.name === "bmad")!.subcommands[0]!.flags;
    expect(install.filter((f) => f.repeatable).map((f) => f.name)).toEqual(["--set"]);
    expect(install.filter((f) => f.value === "list").map((f) => f.name)).toEqual([
      "--repos",
      "--tools",
      "--skills",
    ]);
  });

  // The union that renders BMAD_USAGE's flat flag block is only order-independent while the eight are
  // shared const references. The day someone inlines one, duplicate names stop carrying identical text
  // and the block silently depends on which subcommand is visited first.
  test("a flag name shared across bmad subcommands carries one identical desc", () => {
    const seen = new Map<string, string>();
    for (const sub of S.commands.find((c) => c.name === "bmad")!.subcommands) {
      for (const f of sub.flags) {
        if (seen.has(f.name)) expect(f.desc, f.name).toBe(seen.get(f.name)!);
        else seen.set(f.name, f.desc);
      }
    }
    expect(seen.size).toBe(8);
  });

  test("every bmad flag's group is a listed heading, and every heading is non-empty", () => {
    const groups = new Set(
      S.commands
        .find((c) => c.name === "bmad")!
        .subcommands.flatMap((s) => s.flags.map((f) => f.group)),
    );
    const headings: readonly string[] = BMAD_FLAG_GROUPS;
    for (const g of groups) expect(headings).toContain(g!);
    for (const heading of BMAD_FLAG_GROUPS) expect(groups.has(heading)).toBe(true);
  });
});

describe("--format is READ from EdgeSpec, never restated (AC7)", () => {
  test("cn deploy's enum IS cn's own formats list", () => {
    expect(flagEnum(S, "cn", "deploy", "--format")).toEqual([...CN_SPEC.formats!]);
  });

  // The other direction. dashkit declares no `formats`, so `edge-deploy` does not parse `--format` for
  // it at all (`edge-deploy.ts:511` gates the whole parse on `spec.formats`) — offering one would be an
  // invented option. Both halves are asserted: the spec's absence AND the model's.
  test("dashkit deploy has no --format at all", () => {
    expect(DASHKIT_SPEC.formats).toBeUndefined();
    expect(flagNames(S, "dashkit", "deploy")).not.toContain("--format");
  });
});

describe("the HELP layout is a partition, not a list (AC1 / §Layout)", () => {
  // The anti-drift property, and D-a's failure mode one level up: a new `bmad` subcommand that nobody
  // documented goes RED here instead of silently vanishing from `--help`.
  test("every subcommand appears in exactly one help group — none missing, none twice, none unknown", () => {
    for (const c of S.commands) {
      const listed = c.helpGroups.flatMap((g) => g.subs ?? []);
      expect(new Set(listed).size, `${c.name}: duplicate in a help group`).toBe(listed.length);
      expect([...listed].sort()).toEqual([...subNames(S, c.name)].sort());
    }
  });

  test("every help group is renderable — it states a desc, or wraps exactly one sub", () => {
    for (const c of S.commands) {
      for (const g of c.helpGroups) {
        const inheritable = g.desc === undefined;
        if (inheritable) expect(g.subs?.length, `${c.name}: blank group`).toBe(1);
        else expect(g.desc!.length).toBeGreaterThan(0);
      }
    }
  });

  test("every option block resolves, and the complement is exactly the undocumented-by-HELP set", () => {
    for (const [cmd, sub] of HELP_OPTION_BLOCKS) {
      expect(subNames(S, cmd), `${cmd} ${sub}`).toContain(sub);
      expect(flagNames(S, cmd, sub).length, `${cmd} ${sub}`).toBeGreaterThan(0);
    }
    const blocked = new Set(HELP_OPTION_BLOCKS.map(([c, s]) => `${c} ${s}`));
    const withFlagsNoBlock: string[] = [];
    for (const c of S.commands) {
      if ((c.flags ?? []).length > 0 && !blocked.has(c.name)) withFlagsNoBlock.push(c.name);
      for (const sub of c.subcommands) {
        if (sub.flags.length > 0 && !blocked.has(`${c.name} ${sub.name}`)) {
          withFlagsNoBlock.push(`${c.name} ${sub.name}`);
        }
      }
    }
    // `alias`'s `--install` shows in its command row; the four bmad subs are documented by BMAD_USAGE.
    // Pinned so a future `cn` subcommand with flags cannot silently miss its block.
    expect(withFlagsNoBlock.sort()).toEqual([
      "alias",
      "bmad deploy",
      "bmad install",
      "bmad update",
      "bmad verify",
    ]);
  });
});

describe("renderAliasUsage — R-3 closed, the line is stated ONCE (3.2 AC9)", () => {
  // The two hand-written copies had ALREADY drifted — `main.ts` said "regenerate repo-nav + _std", and
  // `repo-nav.ts` said "(re)generate repo-nav + _std completion". Neither of the two existing assertions
  // noticed, because both are the loose regex `/usage: std alias --install/`. That is precisely why the
  // FULL line is pinned here: without it the unification lands unenforced and is free to drift again.
  test("renders the full canonical line, byte for byte", () => {
    expect(renderAliasUsage(S)).toBe(
      "usage: std alias --install   # (re)generate repo-nav + the _std completion from ~/.config/std/repos.ts",
    );
  });

  // The text IS the flag's own `desc`, so the usage line and the completer's explanation for the same
  // flag cannot diverge: changing one changes both.
  test("the text is derived from the --install flag's desc, not restated", () => {
    const install = S.commands
      .find((c) => c.name === "alias")!
      .flags!.find((f) => f.name === "--install")!;
    expect(renderAliasUsage(S)).toContain(install.desc);
  });
});

describe("the model's bmad subs EQUAL the handler map that routes (AC5)", () => {
  // Set equality one way, asserted at runtime — an EXTRA key in the map (a `status:` nobody documented)
  // fires here. The other way is `tsc`'s: the map is typed `Record<BmadSub, …>`, so a DELETED key fails
  // `bun run typecheck`. Neither direction alone is enough.
  test("Object.keys(bmadHandlers) === subNames(SURFACE, 'bmad')", () => {
    expect(Object.keys(bmadHandlers([], fakeDeps())).sort()).toEqual([...subNames(S, "bmad")].sort());
  });
});
