/**
 * notifications.ts — Session timing + ntfy push notifications
 *
 * Session timing is used by LoadContext.hook.ts to record session start.
 * ntfy push is available for hooks that need mobile/desktop notifications.
 *
 * Story 13.7 split: session-timing fs → fsx (atomicWrite / readIfExists; the `/tmp` path stays
 * caller-local); sendPush's fetch+AbortSignal.timeout → http.fetchWithTimeout (raw Response, the `.ok`
 * boolean return preserved); loadNtfyConfig's raw read → fsx.readIfExists with the `${VAR}` env-subst +
 * ntfy topic identity kept caller-local. Optional injection seams (a `file` path; a `deps` fetcher/config)
 * are backward-compatible defaults so the callers (LoadContext) are unaffected and the tests stay hermetic.
 */

import { getSettingsPath } from './paths';
import { atomicWrite, readIfExists } from 'std/fsx';
import { fetchWithTimeout, type FetchOpts } from 'std/http';

// ============================================================================
// Session Timing
// ============================================================================

const SESSION_START_FILE = '/tmp/pai-session-start.txt';

export function recordSessionStart(file: string = SESSION_START_FILE): void {
  try { atomicWrite(file, Date.now().toString()); } catch {}
}

export function getSessionDurationMinutes(file: string = SESSION_START_FILE): number {
  try {
    const raw = readIfExists(file);
    if (raw !== null) {
      const startTime = parseInt(raw);
      return (Date.now() - startTime) / 1000 / 60;
    }
  } catch {}
  return 0;
}

// ============================================================================
// ntfy Push (fire-and-forget)
// ============================================================================

export type NotificationPriority = 'min' | 'low' | 'default' | 'high' | 'urgent';

export interface NotificationOptions {
  title?: string;
  priority?: NotificationPriority;
  tags?: string[];
}

export interface NtfyConfig {
  enabled: boolean;
  topic: string;
  server: string;
}

/** Test/override seams for sendPush — defaults keep the production behaviour byte-for-byte. */
export interface SendPushDeps {
  loadConfig?: () => NtfyConfig;
  fetcher?: (url: string, init: FetchOpts) => Promise<{ ok: boolean }>;
}

function loadNtfyConfig(): NtfyConfig {
  try {
    const settingsPath = getSettingsPath();
    const rawContent = readIfExists(settingsPath);
    if (rawContent === null) return { enabled: false, topic: '', server: 'ntfy.sh' };

    const raw = rawContent.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] || '');
    const settings = JSON.parse(raw);
    const ntfy = settings.notifications?.ntfy;
    return {
      enabled: ntfy?.enabled ?? false,
      topic: ntfy?.topic ?? '',
      server: ntfy?.server ?? 'ntfy.sh',
    };
  } catch {
    return { enabled: false, topic: '', server: 'ntfy.sh' };
  }
}

export async function sendPush(
  message: string,
  options: NotificationOptions = {},
  deps: SendPushDeps = {}
): Promise<boolean> {
  const config = (deps.loadConfig ?? loadNtfyConfig)();
  if (!config.enabled || !config.topic) return false;

  const fetcher = deps.fetcher ?? fetchWithTimeout;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
    if (options.title) headers['Title'] = options.title;
    if (options.priority) {
      const map: Record<NotificationPriority, string> = {
        min: '1', low: '2', default: '3', high: '4', urgent: '5',
      };
      headers['Priority'] = map[options.priority] || '3';
    }
    if (options.tags?.length) headers['Tags'] = options.tags.join(',');

    const response = await fetcher(`https://${config.server}/${config.topic}`, {
      method: 'POST',
      headers,
      body: message,
      timeout: 5000,
    });
    return response.ok;
  } catch {
    return false;
  }
}
