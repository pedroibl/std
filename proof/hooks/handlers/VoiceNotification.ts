/**
 * VoiceNotification.ts - Voice Notification Handler
 *
 * PURPOSE:
 * Sends completion messages to the voice server for TTS playback.
 * Extracts the 🗣️ voice line from responses and sends to ElevenLabs via voice server.
 *
 * Pure handler: receives pre-parsed transcript data, sends to voice server.
 * No I/O for transcript reading - that's done by VoiceCompletion.hook.ts.
 *
 * Story 13.7: the dual-sink JSONL log moves onto report.appendJsonlEvent (TWO calls — the global voice log
 * AND the per-work voice.jsonl — kept separate, NOT collapsed); getActiveWorkDir's read → fsx.readIfExists /
 * exists; the voice-server POST → http.fetchWithTimeout (raw Response, .ok/.status/.statusText preserved).
 * The Pulse URL (localhost:31337), voice IDs and VoiceEvent schema stay caller-local (D4). An optional
 * `fetcher` seam keeps the callers unaffected while the test stays hermetic (no real network).
 */

import { appendJsonlEvent } from 'std/report';
import { fetchWithTimeout, type FetchOpts } from 'std/http';
import { exists, readIfExists } from 'std/fsx';
import { paiPath } from '../lib/paths';
import { getIdentity, type VoicePersonality } from '../lib/identity';
import { getISOTimestamp } from '../lib/time';
import { isValidVoiceCompletion, getVoiceFallback } from '../lib/output-validators';

import type { ParsedTranscript } from '../../PAI/TOOLS/TranscriptParser';

const DA_IDENTITY = getIdentity();

// ElevenLabs voice notification payload
interface ElevenLabsNotificationPayload {
  message: string;
  title?: string;
  voice_enabled?: boolean;
  voice_id?: string;
  voice_settings?: {
    stability: number;
    similarity_boost: number;
    style: number;
    speed: number;
    use_speaker_boost: boolean;
  };
  volume?: number;
}

interface VoiceEvent {
  timestamp: string;
  session_id: string;
  event_type: 'sent' | 'failed' | 'skipped';
  message: string;
  character_count: number;
  voice_engine: 'elevenlabs';
  voice_id: string;
  status_code?: number;
  error?: string;
}

/** Minimal response shape sendNotification needs — Response satisfies this structurally. */
type NotifyResponse = { ok: boolean; status: number; statusText: string };
/** Test/override seam — defaults keep the production behaviour byte-for-byte. */
export interface VoiceDeps {
  fetcher?: (url: string, init: FetchOpts) => Promise<NotifyResponse>;
}

const CURRENT_WORK_PATH = paiPath('MEMORY', 'STATE', 'current-work.json');

function getActiveWorkDir(): string | null {
  try {
    const content = readIfExists(CURRENT_WORK_PATH);
    if (content === null) return null;
    const state = JSON.parse(content);
    if (state.work_dir) {
      const workPath = paiPath('MEMORY', 'WORK', state.work_dir);
      if (exists(workPath)) return workPath;
    }
  } catch {
    // Silent fail
  }
  return null;
}

function logVoiceEvent(event: VoiceEvent): void {
  // DUAL-WRITE (two sinks, kept separate — do NOT collapse):
  //   sink 1 — the global voice-events log; sink 2 — the active work dir's voice.jsonl (when present).
  // appendJsonlEvent creates the dir + appends JSON+'\n', best-effort/never-throws (size-rotates at 1 MiB).
  appendJsonlEvent(paiPath('MEMORY', 'VOICE'), 'voice-events.jsonl', event);

  const workDir = getActiveWorkDir();
  if (workDir) {
    appendJsonlEvent(workDir, 'voice.jsonl', event);
  }
}

async function sendNotification(
  payload: ElevenLabsNotificationPayload,
  sessionId: string,
  deps: VoiceDeps = {}
): Promise<void> {
  const voiceId = payload.voice_id || DA_IDENTITY.mainDAVoiceID;
  const fetcher = deps.fetcher ?? fetchWithTimeout;

  const baseEvent: Omit<VoiceEvent, 'event_type' | 'status_code' | 'error'> = {
    timestamp: getISOTimestamp(),
    session_id: sessionId,
    message: payload.message,
    character_count: payload.message.length,
    voice_engine: 'elevenlabs',
    voice_id: voiceId,
  };

  try {
    // Use ElevenLabs voice server /notify endpoint. 10s timeout — ElevenLabs TTS takes ~4s, need headroom.
    const response = await fetcher('http://localhost:31337/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 10000,
    });

    if (!response.ok) {
      console.error('[Voice] Server error:', response.statusText);
      logVoiceEvent({
        ...baseEvent,
        event_type: 'failed',
        status_code: response.status,
        error: response.statusText,
      });
    } else {
      logVoiceEvent({
        ...baseEvent,
        event_type: 'sent',
        status_code: response.status,
      });

    }
  } catch (error) {
    console.error('[Voice] Failed to send:', error);
    logVoiceEvent({
      ...baseEvent,
      event_type: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Handle voice notification with pre-parsed transcript data.
 * Uses ElevenLabs TTS via the voice server.
 */
export async function handleVoice(parsed: ParsedTranscript, sessionId: string, deps: VoiceDeps = {}): Promise<void> {
  let voiceCompletion = parsed.voiceCompletion;

  // Validate voice completion
  if (!isValidVoiceCompletion(voiceCompletion)) {
    console.error(`[Voice] Invalid completion: "${voiceCompletion.slice(0, 50)}..."`);
    voiceCompletion = getVoiceFallback();
  }

  // Skip empty or too-short messages
  if (!voiceCompletion || voiceCompletion.length < 5) {
    console.error('[Voice] Skipping - message too short or empty');
    return;
  }

  // Get voice settings from DA identity in settings.json
  const voiceId = DA_IDENTITY.mainDAVoiceID;
  const voiceSettings = DA_IDENTITY.voice;

  const payload: ElevenLabsNotificationPayload = {
    message: voiceCompletion,
    title: `${DA_IDENTITY.name} says`,
    voice_enabled: true,
    voice_id: voiceId,
    voice_settings: voiceSettings ? {
      stability: voiceSettings.stability ?? 0.5,
      similarity_boost: voiceSettings.similarityBoost ?? 0.75,
      style: voiceSettings.style ?? 0.0,
      speed: voiceSettings.speed ?? 1.0,
      use_speaker_boost: voiceSettings.useSpeakerBoost ?? true,
    } : undefined,
  };

  await sendNotification(payload, sessionId, deps);
}
