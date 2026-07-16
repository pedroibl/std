/**
 * Central Identity Loader
 * Single source of truth for DA (Digital Assistant) and Principal identity
 *
 * Reads from settings.json - the programmatic way, not markdown parsing.
 * All hooks and tools should import from here.
 *
 * Story 13.7: loadSettings() now reads settings.json via the tested `fsx.loadJson` (missing-file and
 * unparseable-JSON both soften to the `{}` fallback, exactly as the hand-rolled try/catch did). Behavior
 * delta (disclosed, deferred-work §13-7): a GENUINE fs fault (e.g. EACCES) now surfaces per fsx fail-loud
 * instead of being swallowed to `{}` — a strict improvement (a broken FS no longer masquerades as empty
 * settings), and unreachable in practice for a $HOME/.claude/settings.json the owner controls. Everything
 * else is caller-local identity (voice IDs, DA name, DEFAULT_PRINCIPAL.timezone='UTC' fallback).
 */

import { join } from 'path';
import { loadJson } from 'std/fsx';

const HOME = process.env.HOME!;
const SETTINGS_PATH = join(HOME, '.claude/settings.json');

// Default identity (fallback if settings.json doesn't have identity section)
const DEFAULT_IDENTITY = {
  name: 'PAI',
  fullName: 'Personal AI',
  displayName: 'PAI',
  mainDAVoiceID: '',
  color: '#3B82F6',
};

const DEFAULT_PRINCIPAL = {
  name: 'User',
  pronunciation: '',
  timezone: 'UTC',
};

export interface VoiceProsody {
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
  useSpeakerBoost: boolean;
  volume?: number;
}

export interface VoicePersonality {
  baseVoice: string;
  enthusiasm: number;
  energy: number;
  expressiveness: number;
  resilience: number;
  composure: number;
  optimism: number;
  warmth: number;
  formality: number;
  directness: number;
  precision: number;
  curiosity: number;
  playfulness: number;
}

export interface Identity {
  name: string;
  fullName: string;
  displayName: string;
  mainDAVoiceID: string;
  color: string;
  voice?: VoiceProsody;
  personality?: VoicePersonality;
}

export interface Principal {
  name: string;
  pronunciation: string;
  timezone: string;
}

export interface ObservabilityTarget {
  name: string;
  type: 'http' | 'cloudflare-kv';
  url?: string;
  headers?: Record<string, string>;
}

export interface ObservabilityConfig {
  targets: ObservabilityTarget[];
  server?: { port: number; enabled: boolean };
}

export interface Settings {
  daidentity?: Partial<Identity>;
  principal?: Partial<Principal>;
  env?: Record<string, string>;
  observability?: ObservabilityConfig;
  [key: string]: unknown;
}

let cachedSettings: Settings | null = null;

/**
 * Load settings.json (cached)
 */
function loadSettings(): Settings {
  if (cachedSettings) return cachedSettings;
  // fsx.loadJson: missing file OR unparseable JSON → `{}` fallback (faithful to the old try/catch);
  // a genuine fs fault surfaces (fail-loud) rather than masquerading as empty settings.
  cachedSettings = loadJson<Settings>(SETTINGS_PATH, {});
  return cachedSettings;
}

/**
 * Get DA (Digital Assistant) identity from settings.json
 */
export function getIdentity(): Identity {
  const settings = loadSettings();

  // Prefer settings.daidentity, fall back to env.DA for backward compat
  const daidentity = settings.daidentity || {};
  const envDA = settings.env?.DA;

  // Support both old (daidentity.voice) and new (daidentity.voices.main) structures
  const voices = (daidentity as any).voices || {};
  const voiceConfig = voices.main || (daidentity as any).voice;

  return {
    name: daidentity.name || envDA || DEFAULT_IDENTITY.name,
    fullName: daidentity.fullName || daidentity.name || envDA || DEFAULT_IDENTITY.fullName,
    displayName: daidentity.displayName || daidentity.name || envDA || DEFAULT_IDENTITY.displayName,
    mainDAVoiceID: voiceConfig?.voiceId || (daidentity as any).voiceId || daidentity.mainDAVoiceID || DEFAULT_IDENTITY.mainDAVoiceID,
    color: daidentity.color || DEFAULT_IDENTITY.color,
    voice: voiceConfig as VoiceProsody | undefined,
    personality: (daidentity as any).personality as VoicePersonality | undefined,
  };
}

/**
 * Get Principal (human owner) identity from settings.json
 */
export function getPrincipal(): Principal {
  const settings = loadSettings();

  // Prefer settings.principal, fall back to env.PRINCIPAL for backward compat
  const principal = settings.principal || {};
  const envPrincipal = settings.env?.PRINCIPAL;

  return {
    name: principal.name || envPrincipal || DEFAULT_PRINCIPAL.name,
    pronunciation: principal.pronunciation || DEFAULT_PRINCIPAL.pronunciation,
    timezone: principal.timezone || DEFAULT_PRINCIPAL.timezone,
  };
}

/**
 * Clear cache (useful for testing or when settings.json changes)
 */
export function clearCache(): void {
  cachedSettings = null;
}

/**
 * Get just the DA name (convenience function)
 */
export function getDAName(): string {
  return getIdentity().name;
}

/**
 * Get the user-customized startup catchphrase the install wizard collected,
 * with `{name}` placeholder substitution against the active DA name.
 *
 * Read order:
 *   1. settings.daidentity.startupCatchphrase (set by PAI-Install wizard)
 *   2. fallback default: `<name> here, ready to go.`
 *
 * Callers should prefer this over hand-rolling `${getDAName()} here, ready
 * to go.` so the install's collected catchphrase is actually honored.
 */
export function getStartupCatchphrase(): string {
  const settings = loadSettings();
  const stored = (settings.daidentity as any)?.startupCatchphrase as string | undefined;
  const name = getDAName();
  const template = (stored && stored.trim()) || "{name} here, ready to go.";
  return template.replace(/\{name\}/gi, name);
}

/**
 * Get just the Principal name (convenience function)
 */
export function getPrincipalName(): string {
  return getPrincipal().name;
}

/**
 * Get just the voice ID (convenience function)
 */
export function getVoiceId(): string {
  return getIdentity().mainDAVoiceID;
}

/**
 * Get the full settings object (for advanced use)
 */
export function getSettings(): Settings {
  return loadSettings();
}

/**
 * Get observability config from settings.json.
 * Defaults to local-only target if not configured.
 */
export function getObservabilityConfig(): ObservabilityConfig {
  const settings = loadSettings();
  return {
    targets: settings.observability?.targets ?? [{ type: 'http' as const, url: 'http://localhost:31337', name: 'local' }],
    server: settings.observability?.server ?? { port: 31337, enabled: true },
  };
}

/**
 * Get the default identity (for documentation/testing)
 */
export function getDefaultIdentity(): Identity {
  return { ...DEFAULT_IDENTITY };
}

/**
 * Get the default principal (for documentation/testing)
 */
export function getDefaultPrincipal(): Principal {
  return { ...DEFAULT_PRINCIPAL };
}

/**
 * Get algorithm voice settings from settings.json → daidentity.voices.algorithm
 * Returns { voiceId, voiceName, stability, similarity_boost, style, speed, use_speaker_boost, volume }
 * or null if not configured.
 */
export function getAlgorithmVoice(): { voiceId: string; voiceName: string; stability: number; similarityBoost: number; style: number; speed: number; useSpeakerBoost: boolean; volume?: number } | null {
  const settings = loadSettings();
  const voices = (settings.daidentity as any)?.voices;
  if (!voices?.algorithm?.voiceId) return null;
  return voices.algorithm;
}

/**
 * Get voice prosody settings (convenience function) - legacy ElevenLabs
 */
export function getVoiceProsody(): VoiceProsody | undefined {
  return getIdentity().voice;
}

/**
 * Get voice personality settings (convenience function) - Qwen3-TTS
 */
export function getVoicePersonality(): VoicePersonality | undefined {
  return getIdentity().personality;
}
