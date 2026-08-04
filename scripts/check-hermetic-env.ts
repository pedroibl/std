// Enforcement harness — a test that redirects a framework root must pin the WHOLE precedence chain.
//
// WHY THIS GATE EXISTS. proof/ tools resolve their estate root as
// `LIFEOS_DIR || PAI_DIR || resolveFrameworkDir(HOME)` (RT-2 / AD-9.3). A test that sets only the
// LOWER key believes it is hermetic while an ambient higher key silently outranks it — and several
// of these tests call `main()`, which WRITES. Three did exactly that: they appended to the caller's
// real WISDOM frame and rewrote two real reports, then failed because they asserted against the tmp
// dir the tool never used. The failures had been dismissed as "pre-existing and unrelated" through
// four separate story reviews, because a red test reads as a broken test rather than as a tool
// writing somewhere it should not.
//
// The rule: within a single test file, any assignment to a lower-precedence key must be accompanied
// by an explicit PIN of every key that outranks it. Order is highest-first. A pin is either
// `process.env.K = <tmp>` or a bare `delete process.env.K` — see `pinCount` for why the delete form
// counts and why the `=== undefined` restore form does not.
//
// This scans TEXT, not behaviour, so it is a cheap tripwire rather than a proof — the durable proof
// is that each redirected test asserts against its own tmp dir. It exists to make the drift LOUD at
// the moment it is written, which is the part that failed last time.

import { stripStringsAndComments } from "./lib/specifiers";

/** Highest precedence first — the order the resolver reads them in. */
export const ROOT_KEYS = ["LIFEOS_DIR", "PAI_DIR"] as const;

export type EnvFinding = { line: number; key: string; missing: string[] };

/**
 * How many times this source PINS the key — assigns it, or deliberately unsets it.
 *
 * COUNTS, NOT PRESENCE — and that distinction is the whole gate. A correct block controls each key
 * TWICE: once to pin it at the tmp root, once to put the caller's value back in `afterEach`/`finally`.
 * A presence check therefore passes on the restore alone, so a file that only ever restores the
 * higher key reads as compliant. The first draft of this gate did exactly that and could not fail —
 * caught by reverting a known-good fix and watching it stay green. Requiring the higher key to be
 * pinned at least as often as the lower one distinguishes "pinned and restored" from "restored only".
 *
 * WHY `delete` COUNTS. Unsetting the higher key is the OTHER way to make the lower one authoritative,
 * and for a precedence test it is the only way: `test("PAI_DIR honored when LIFEOS_DIR unset")` must
 * `delete process.env.LIFEOS_DIR` and then set PAI_DIR alone. Counting assignments only, this gate
 * read every such test as an exposure and reported 12 of them across 12 files — all of which already
 * controlled the whole chain, several by the very `delete` the gate refused to see. 12/12 false
 * positives is not a tuning problem; it is the gate disagreeing with the idiom its own corpus uses.
 * A gate that cries wolf gets ignored, which is how the bug this gate exists for survived four
 * story reviews.
 *
 * WHY THE RESTORE FORM DOES NOT. `if (prev === undefined) delete process.env.K;` is a restore, not a
 * pin — it hands the key BACK to the caller. Counting it would let a file that pins the lower key and
 * merely restores the higher one balance out, which is precisely the "restored only" shape above. The
 * two forms are told apart by the `undefined` guard that every restore branch carries and no pin does.
 */
function pinCount(src: string, key: string): number {
  const assigns = src.match(new RegExp(`process\\.env\\.${key}\\s*=`, "g"))?.length ?? 0;
  const deletes = (src.match(new RegExp(`^.*\\bdelete\\s+process\\.env\\.${key}\\b.*$`, "gm")) ?? [])
    .filter((line) => !line.includes("undefined")).length;
  return assigns + deletes;
}

/**
 * Pure: report every lower-precedence root key a source redirects without also pinning the keys
 * that outrank it. Comments and strings are masked first, so prose naming a key is not a finding.
 */
export function scanSource(src: string): EnvFinding[] {
  const clean = stripStringsAndComments(src);
  const out: EnvFinding[] = [];

  ROOT_KEYS.forEach((key, i) => {
    const higher = ROOT_KEYS.slice(0, i);
    if (higher.length === 0) return; // the top key outranks nothing
    const lowerCount = pinCount(clean, key);
    if (lowerCount === 0) return;
    // Under-pinned means the higher key is missing at least one PIN, not merely present.
    const missing = higher.filter((h) => pinCount(clean, h) < lowerCount);
    if (missing.length === 0) return;
    const first = new RegExp(`process\\.env\\.${key}\\s*=`).exec(clean);
    out.push({ line: clean.slice(0, first?.index ?? 0).split("\n").length, key, missing });
  });

  return out;
}

// SCOPE, and why it is not `proof/**`. The chain only exists for the estate tools that call
// `resolveFrameworkDir` — `proof/*.test.ts`. The `proof/hooks/**` tree reads PAI_DIR alone (verified:
// none of its sources mentions LIFEOS_DIR), so pinning PAI_DIR there IS hermetic and flagging it
// would be 10 false positives. A gate that cries wolf gets ignored, which is how the bug this gate
// exists for survived four story reviews. Widen this glob only for a tool that actually reads the
// higher key.
const SCAN_GLOB = "proof/*.test.ts";

async function main(): Promise<void> {
  const findings: Array<{ file: string; f: EnvFinding }> = [];
  let scanned = 0;

  for await (const file of new Bun.Glob(SCAN_GLOB).scan(".")) {
    scanned++;
    for (const f of scanSource(await Bun.file(file).text())) findings.push({ file, f });
  }

  if (scanned === 0) {
    console.error(`✗ hermetic-env scope is vacuous: ${SCAN_GLOB} matched 0 files`);
    process.exit(1);
  }

  if (findings.length > 0) {
    console.error("✗ non-hermetic test env (RT-2/AD-9.3):");
    for (const { file, f } of findings) {
      console.error(
        `  ${file}:${f.line}  redirects ${f.key} but never pins ${f.missing.join(", ")} — ` +
          "an ambient value outranks it and the tool will use the REAL estate",
      );
    }
    console.error(
      `\n${findings.length} site(s) — pin every key that outranks the one you set ` +
        `(order: ${ROOT_KEYS.join(" > ")}), and restore them all in afterEach/finally.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ every redirected framework root pins its full precedence chain across ${scanned} test file(s) ` +
      `(${ROOT_KEYS.join(" > ")}) — no test can reach the caller's real estate (RT-2/AD-9.3)`,
  );
}

if (import.meta.main) await main();
