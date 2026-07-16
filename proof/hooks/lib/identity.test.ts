// Story 13.7 — identity.ts: loadSettings() now reads settings.json via fsx.loadJson (missing/unparseable
// → `{}` fallback, faithful to the old try/catch). These assertions are environment-independent: the
// baked DEFAULT_* constants (caller-local identity), the settings-object shape, and the fail-soft loader
// contract (getSettings never throws on a missing/corrupt file — proven exhaustively in the fsx tests).

import { describe, expect, test } from 'bun:test';
import {
  clearCache,
  getDefaultIdentity,
  getDefaultPrincipal,
  getIdentity,
  getObservabilityConfig,
  getPrincipal,
  getSettings,
} from './identity';

describe('baked defaults (caller-local identity — D4)', () => {
  test('DEFAULT_PRINCIPAL fallback is UTC (never the template LA)', () => {
    expect(getDefaultPrincipal()).toEqual({ name: 'User', pronunciation: '', timezone: 'UTC' });
  });
  test('DEFAULT_IDENTITY is the PAI placeholder', () => {
    expect(getDefaultIdentity()).toEqual({
      name: 'PAI',
      fullName: 'Personal AI',
      displayName: 'PAI',
      mainDAVoiceID: '',
      color: '#3B82F6',
    });
  });
});

describe('fsx.loadJson loader contract', () => {
  test('getSettings() returns a settings object, never throws (fail-soft on missing/corrupt)', () => {
    clearCache();
    const s = getSettings();
    expect(typeof s).toBe('object');
    expect(s).not.toBeNull();
  });
  test('getPrincipal() yields the Principal shape (string fields)', () => {
    const p = getPrincipal();
    expect(typeof p.name).toBe('string');
    expect(typeof p.pronunciation).toBe('string');
    expect(typeof p.timezone).toBe('string');
    expect(p.timezone.length).toBeGreaterThan(0); // configured tz OR the UTC fallback — never empty
  });
  test('getIdentity() yields the Identity shape', () => {
    const i = getIdentity();
    expect(typeof i.name).toBe('string');
    expect(typeof i.color).toBe('string');
    expect(typeof i.mainDAVoiceID).toBe('string');
  });
  test('getObservabilityConfig() defaults to a targets array', () => {
    const c = getObservabilityConfig();
    expect(Array.isArray(c.targets)).toBe(true);
    expect(c.targets.length).toBeGreaterThan(0);
  });
});
