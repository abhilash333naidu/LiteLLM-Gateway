import { createHash } from 'node:crypto';
import type { Db } from '../db/types.js';
import { getDb, getSetting, setSetting } from '../db/index.js';
import type { Scheduler } from '../lib/scheduler.js';

// ── Scheduled live-model discovery ───────────────────────────────────────────
//
// Reconciles the local `models` table with providers' CURRENT model rosters:
// whatever free models OpenRouter / OpenCode Zen / Groq actually serve today.
// This never touches the paid/subscription catalog system — it only ever
// creates, disables or reinstates rows with source='live'.

export interface LiveDiscoveryCounts {
  added: number;
  reinstated: number;
  deprecated: number;
  skipped: number;
  paidSkipped: number;
  tombstoned: number;
}

export interface LiveDiscoveryResult {
  ok: boolean;
  platforms: string[];
  counts: LiveDiscoveryCounts;
  failures: Array<{ platform: string; error: string }>;
  fingerprint: string;
  durationMs: number;
}

export interface LiveDiscoveryState {
  enabled: boolean;
  lastRunMs: number | null;
  lastError: string | null;
  lastResult: LiveDiscoveryResult | null;
}

/** One provider roster entry that survived free/modality filtering. Capability
 *  fields are evidence-only: undefined means "the upstream said nothing". */
export interface CollectedLiveModel {
  id: string;
  tools: boolean | undefined;
  vision: boolean | undefined;
  contextWindow: number | undefined;
}

/** Default: twice a day. The bundled free roster drifts fast; daily is stale. */
const DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Keyless OpenRouter plus the keyed free-tier gateways, in fetch order. */
const DEFAULT_PLATFORMS = ['openrouter', 'opencode', 'groq'];

const SETTING_LAST_RUN_MS = 'live_discovery_last_run_ms';
const SETTING_LAST_ERROR = 'live_discovery_last_error';
const SETTING_LAST_RESULT_JSON = 'live_discovery_last_result_json';

/** Interval in ms from `LIVE_MODEL_SYNC_INTERVAL_MS`; 0 disables the pass,
 *  anything unset or malformed falls back to the 12h default. */
export function liveDiscoveryIntervalMs(): number {
  const raw = process.env.LIVE_MODEL_SYNC_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_INTERVAL_MS;
}

/** Comma-separated platform list from `LIVE_MODEL_SYNC_PLATFORMS`. */
function liveDiscoveryPlatforms(): string[] {
  const raw = process.env.LIVE_MODEL_SYNC_PLATFORMS;
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_PLATFORMS];
  const list = raw.split(',').map(p => p.trim().toLowerCase()).filter(p => p.length > 0);
  return list.length > 0 ? [...new Set(list)] : [...DEFAULT_PLATFORMS];
}

let lastRunMs: number | null = null;
let lastError: string | null = null;
let lastResult: LiveDiscoveryResult | null = null;

function readSetting(key: string): string | undefined {
  try {
    return getSetting(key);
  } catch {
    return undefined;
  }
}

export function getLiveDiscoveryState(): LiveDiscoveryState {
  if (lastRunMs === null) {
    const raw = readSetting(SETTING_LAST_RUN_MS);
    const ms = raw === undefined ? NaN : Number(raw);
    if (Number.isFinite(ms)) lastRunMs = ms;
  }
  if (lastError === null) {
    const raw = readSetting(SETTING_LAST_ERROR);
    if (raw !== undefined && raw !== '') lastError = raw;
  }
  if (lastResult === null) {
    const raw = readSetting(SETTING_LAST_RESULT_JSON);
    if (raw !== undefined) {
      try {
        lastResult = JSON.parse(raw) as LiveDiscoveryResult;
      } catch {
        lastResult = null;
      }
    }
  }
  return { enabled: liveDiscoveryIntervalMs() > 0, lastRunMs, lastError, lastResult };
}

/** Keyless OpenRouter roster (slice 2). */
async function fetchOpenRouterModels(): Promise<CollectedLiveModel[]> {
  throw new Error('openrouter collector not implemented');
}

/** Keyed free-tier gateway roster (slice 3). */
async function fetchKeyedPlatformModels(_db: Db, platform: string): Promise<CollectedLiveModel[]> {
  throw new Error(`keyed collector not implemented for ${platform}`);
}

/** sha256 over canonical sorted JSON of {platform → sorted model ids} seen. */
function fingerprintSeen(seen: Record<string, string[]>): string {
  const canonical: Record<string, string[]> = {};
  for (const platform of Object.keys(seen).sort()) {
    canonical[platform] = [...seen[platform]!].sort();
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function persistSettings(runMs: number, result: LiveDiscoveryResult, error: string | null): void {
  setSetting(SETTING_LAST_RUN_MS, String(runMs));
  setSetting(SETTING_LAST_RESULT_JSON, JSON.stringify(result));
  if (error === null) {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(SETTING_LAST_ERROR);
  } else {
    setSetting(SETTING_LAST_ERROR, error);
  }
}

/** Reconcile the `models` table with providers' current rosters. One
 *  platform's failure is recorded and never disables existing rows: an empty
 *  or failed fetch is inconclusive, never evidence of removal. */
export async function runLiveModelSync(db: Db): Promise<LiveDiscoveryResult> {
  const startedAt = Date.now();
  const counts: LiveDiscoveryCounts = { added: 0, reinstated: 0, deprecated: 0, skipped: 0, paidSkipped: 0, tombstoned: 0 };
  const failures: Array<{ platform: string; error: string }> = [];
  const seen: Record<string, string[]> = {};
  void db;

  try {
    for (const platform of liveDiscoveryPlatforms()) {
      try {
        const models = platform === 'openrouter'
          ? await fetchOpenRouterModels()
          : await fetchKeyedPlatformModels(db, platform);
        seen[platform] = models.map(m => m.id);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ platform, error: message });
        console.error(`[live-model-sync] ${platform}: ${message}`);
      }
    }

    const ok = Object.keys(seen).length > 0;
    const error = ok ? null : failures.map(f => `${f.platform}: ${f.error}`).join('; ') || 'no platforms produced a model list';
    const result: LiveDiscoveryResult = {
      ok,
      platforms: Object.keys(seen).sort(),
      counts,
      failures,
      fingerprint: fingerprintSeen(seen),
      durationMs: Date.now() - startedAt,
    };

    lastRunMs = startedAt;
    lastError = error;
    lastResult = result;
    persistSettings(startedAt, result, error);
    console.log(
      `[live-model-sync] ok=${ok} added=${counts.added} reinstated=${counts.reinstated} ` +
      `deprecated=${counts.deprecated} skipped=${counts.skipped} paidSkipped=${counts.paidSkipped} ` +
      `tombstoned=${counts.tombstoned} failures=${failures.length}`,
    );
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const result: LiveDiscoveryResult = {
      ok: false,
      platforms: [],
      counts,
      failures: [...failures, { platform: '*', error: message }],
      fingerprint: fingerprintSeen(seen),
      durationMs: Date.now() - startedAt,
    };
    lastRunMs = startedAt;
    lastError = message;
    lastResult = result;
    try {
      persistSettings(startedAt, result, message);
    } catch {
      // Persistence must never turn a result into a throw.
    }
    console.log(`[live-model-sync] ok=false error=${message}`);
    return result;
  }
}

/** Register the scheduled pass. Returns null when the interval is 0
 *  (disabled); otherwise one delayed run plus the interval pass. */
export function startLiveModelSync(db: Db, scheduler: Scheduler): (() => void) | null {
  const intervalMs = liveDiscoveryIntervalMs();
  if (intervalMs <= 0) return null;
  const run = (): void => {
    void runLiveModelSync(db);
  };
  const cancelOnce = scheduler.after(30_000, run);
  const cancelEvery = scheduler.every(intervalMs, run, { name: 'live-model-sync' });
  return () => {
    cancelOnce();
    cancelEvery();
  };
}
