// dashkit plugin-contract tests (Story 8.4 AC1, AC7, AC8, AC9). The contract shape + mechanical invariants
// + the identity-free `why`-string scan + the promoted comparator applied across dashkit's contract, and a
// non-vacuous source scan proving `plugins.ts` carries no bundle-reaching import.
//
// A green run here proves the comparator against dashkit's DATA; it is NOT evidence the reader works against
// the real note-report vault — that is AC5's one live contact run (`std dashkit verify --vault …`). Fixtures
// test your assertions; contact tests your assumptions.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type VaultPlugins, verifyPlugins } from '../core/plugin-contract';
import {
  DASHKIT_SCAN_POLICY,
  SHARED_IMPORT_EVASIONS,
  externalImportViolations,
  stripComments,
} from '../cli/edge-deploy.test-helpers';
import { DASHKIT_PLUGIN_CONTRACT } from './plugins';

/** dashkit's own view of a healthy vault: every declared id enabled at its observed version. */
function healthyVault(): VaultPlugins {
  const enabled: string[] = [];
  const versions: Record<string, string> = {};
  for (const e of DASHKIT_PLUGIN_CONTRACT) {
    if (e.observedVersion === null) continue; // no such row today — but the type keeps the case
    enabled.push(e.id);
    versions[e.id] = e.observedVersion;
  }
  return { enabled, versions };
}

/** Severity for one id, or `undefined` if the comparator produced no finding for it at all. */
function sev(findings: ReturnType<typeof verifyPlugins>, id: string): string | undefined {
  return findings.find((f) => f.id === id)?.severity;
}

describe('DASHKIT_PLUGIN_CONTRACT — the declared envelope (AC1, AC8)', () => {
  test('declares the nine enabled note-report plugins, three of them foundations', () => {
    // The exact id set measured live from the vault at reconciliation (AC1). A snapshot is an inventory;
    // the invariants below make it a RULE.
    expect(DASHKIT_PLUGIN_CONTRACT.map((e) => e.id)).toEqual([
      'fix-require-modules',
      'js-engine',
      'dataview',
      'callout-manager',
      'callout-integrator',
      'project-manager',
      'markwhen',
      'table-editor-obsidian',
      'color-folders-files',
    ]);
    const foundations = DASHKIT_PLUGIN_CONTRACT.filter((e) => e.role === 'foundation');
    expect(foundations.map((e) => e.id)).toEqual(['fix-require-modules', 'js-engine', 'dataview']);
  });

  test('ids are UNIQUE — the invariant is mechanical, not implied by the id snapshot (D-5)', () => {
    const ids = DASHKIT_PLUGIN_CONTRACT.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('`required` tracks `role: "foundation"` exactly on every row (D-5)', () => {
    // The severity mapping keys on role; a required-but-ambient row (or the reverse) would be silently
    // un-enforced. This is the mechanical half of D-1: all three foundations required, all six ambient not.
    for (const e of DASHKIT_PLUGIN_CONTRACT) expect(e.required).toBe(e.role === 'foundation');
  });

  test('every declared plugin is genuinely installed — no observedVersion:null row here (unlike cn)', () => {
    // cn declares `js-engine` absent-on-purpose (observedVersion null); note-report actually HAS js-engine,
    // so dashkit's contract has no "declared absent" member. The type keeps `string | null` — that is core
    // vocabulary now, not a dashkit-shaped field — but every row carries a real version.
    for (const e of DASHKIT_PLUGIN_CONTRACT) expect(e.observedVersion).not.toBeNull();
  });

  test('names no vault anywhere — a vault literal here is a D4/NFR3 violation (AC7)', () => {
    // Test files are exempt from check:no-consumer-ids by design (fixtures plant identifiers), which is
    // exactly what lets this assertion NAME the vaults and therefore be able to fail. It catches the half
    // the gate cannot: a home-relative or iCloud-shaped path fragment in prose. (Vault-relative literals
    // like `/Scripts/dashkit.js` are allowed — they name no particular vault.)
    for (const e of DASHKIT_PLUGIN_CONTRACT) {
      const blob = `${e.id} ${e.name} ${e.why}`;
      expect(blob).not.toMatch(/~|\.obsidian|CloudDocs|Mobile Documents|zDrafts|note-report/);
    }
  });
});

describe('verifyPlugins over DASHKIT_PLUGIN_CONTRACT — the role-keyed severity table', () => {
  test('a healthy vault -> 3 ok foundations + 6 info ambients, no error, no warn', () => {
    const findings = verifyPlugins(healthyVault(), DASHKIT_PLUGIN_CONTRACT, 'dashkit');
    expect(findings.filter((f) => f.severity === 'ok').map((f) => f.id)).toEqual([
      'fix-require-modules',
      'js-engine',
      'dataview',
    ]);
    expect(findings.filter((f) => f.severity === 'info')).toHaveLength(6);
    expect(findings.some((f) => f.severity === 'error' || f.severity === 'warn')).toBe(false);
  });

  test('a missing foundation -> error, and says dashkit cannot run', () => {
    const v = healthyVault();
    const findings = verifyPlugins(
      {
        enabled: v.enabled.filter((id) => id !== 'js-engine'),
        versions: Object.fromEntries(Object.entries(v.versions).filter(([id]) => id !== 'js-engine')),
      },
      DASHKIT_PLUGIN_CONTRACT,
      'dashkit',
    );
    expect(sev(findings, 'js-engine')).toBe('error');
    expect(findings.find((f) => f.id === 'js-engine')!.message).toContain('dashkit cannot run without it');
  });

  test('a foundation at a drifted version -> warn, never error (AD-6: no hard pins)', () => {
    const v = healthyVault();
    const findings = verifyPlugins(
      { enabled: v.enabled, versions: { ...v.versions, 'fix-require-modules': '99.0.0' } },
      DASHKIT_PLUGIN_CONTRACT,
      'dashkit',
    );
    expect(sev(findings, 'fix-require-modules')).toBe('warn');
    expect(findings.some((f) => f.severity === 'error')).toBe(false);
    expect(findings.find((f) => f.id === 'fix-require-modules')!.message).toContain('13.3.2');
  });

  test('an ambient at ANY version is info — versions are never compared', () => {
    const v = healthyVault();
    const findings = verifyPlugins(
      { enabled: v.enabled, versions: { ...v.versions, 'project-manager': '9.9.9' } },
      DASHKIT_PLUGIN_CONTRACT,
      'dashkit',
    );
    expect(sev(findings, 'project-manager')).toBe('info');
    expect(sev(findings, 'markwhen')).toBe('info');
  });

  test('an enabled FOUNDATION with no manifest -> error (registered, not installed)', () => {
    const v = healthyVault();
    const findings = verifyPlugins(
      {
        enabled: v.enabled,
        versions: Object.fromEntries(Object.entries(v.versions).filter(([id]) => id !== 'dataview')),
      },
      DASHKIT_PLUGIN_CONTRACT,
      'dashkit',
    );
    expect(sev(findings, 'dataview')).toBe('error');
    expect(findings.find((f) => f.id === 'dataview')!.message).toContain('no manifest.json');
  });

  test('an enabled id absent from the contract -> info, rendered last', () => {
    const v = healthyVault();
    const findings = verifyPlugins(
      { enabled: [...v.enabled, 'obsidian-git'], versions: { ...v.versions, 'obsidian-git': '2.24.0' } },
      DASHKIT_PLUGIN_CONTRACT,
      'dashkit',
    );
    expect(sev(findings, 'obsidian-git')).toBe('info');
    expect(findings[findings.length - 1]!.id).toBe('obsidian-git');
    expect(findings.find((f) => f.id === 'obsidian-git')!.message).toContain("not in dashkit's contract");
  });

  test('an empty vault -> all three foundations error, six ambients info', () => {
    const findings = verifyPlugins({ enabled: [], versions: {} }, DASHKIT_PLUGIN_CONTRACT, 'dashkit');
    expect(findings.filter((f) => f.severity === 'error').map((f) => f.id)).toEqual([
      'fix-require-modules',
      'js-engine',
      'dataview',
    ]);
    expect(findings.filter((f) => f.severity === 'info')).toHaveLength(6);
    expect(findings.some((f) => f.severity === 'ok')).toBe(false);
  });
});

describe('src/dashkit/plugins.ts is not a bundle-reaching source (AC9)', () => {
  test('its only module edge is a type-only core import — no external/cross-slice import', () => {
    // The whole-source scan (the post-#56 form) over THIS file, masked for comments, under dashkit's policy
    // (value imports from core are legal; a type-only one certainly is). The blanket src/dashkit/*.ts scan
    // in cli/dashkit-deploy.test.ts already covers this file too; this is the focused, per-file assertion.
    const src = stripComments(readFileSync(join(import.meta.dir, 'plugins.ts'), 'utf-8'));
    expect(externalImportViolations(src, DASHKIT_SCAN_POLICY)).toEqual([]);
  });

  test('the scanner is NOT vacuous — it flags every shared evasion form', () => {
    // Per memory bundle-output-greps-are-tautologies: a scan that passes on everything is a test that cannot
    // fail. Prove it catches the real evasions (multi-line import, default-value `type`, re-export, external
    // value import, cross-slice edge, bare side-effect, external require/dynamic-import).
    expect(SHARED_IMPORT_EVASIONS.length).toBeGreaterThan(0);
    for (const evasion of SHARED_IMPORT_EVASIONS) {
      expect(externalImportViolations(evasion, DASHKIT_SCAN_POLICY)).not.toEqual([]);
    }
  });
});
