import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import {
  runLiveModelSync,
  startLiveModelSync,
  getLiveDiscoveryState,
  liveDiscoveryIntervalMs,
} from '../../services/live-model-sync.js';

// Slice 1: contract shell — env parsing, state, scheduler wiring. No network.

const ORIG_INTERVAL = process.env.LIVE_MODEL_SYNC_INTERVAL_MS;
const ORIG_PLATFORMS = process.env.LIVE_MODEL_SYNC_PLATFORMS;

function restoreEnv(): void {
  if (ORIG_INTERVAL === undefined) delete process.env.LIVE_MODEL_SYNC_INTERVAL_MS;
  else process.env.LIVE_MODEL_SYNC_INTERVAL_MS = ORIG_INTERVAL;
  if (ORIG_PLATFORMS === undefined) delete process.env.LIVE_MODEL_SYNC_PLATFORMS;
  else process.env.LIVE_MODEL_SYNC_PLATFORMS = ORIG_PLATFORMS;
}

describe('live-model-sync contract', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    getDb().exec(
      'DELETE FROM profile_models; DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests; DELETE FROM catalog_model_tombstones; DELETE FROM model_overrides;',
    );
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'live_discovery_%'").run();
    vi.clearAllMocks();
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('defaults the interval to 12h, honors explicit values, 0 disables', async () => {
    const mod = await import('../../services/live-model-sync.js');
    delete process.env.LIVE_MODEL_SYNC_INTERVAL_MS;
    expect(mod.liveDiscoveryIntervalMs()).toBe(12 * 60 * 60 * 1000);
    process.env.LIVE_MODEL_SYNC_INTERVAL_MS = '3600000';
    expect(mod.liveDiscoveryIntervalMs()).toBe(3600000);
    process.env.LIVE_MODEL_SYNC_INTERVAL_MS = '0';
    expect(mod.liveDiscoveryIntervalMs()).toBe(0);
    process.env.LIVE_MODEL_SYNC_INTERVAL_MS = 'garbage';
    expect(mod.liveDiscoveryIntervalMs()).toBe(12 * 60 * 60 * 1000);
  });

  it('returns null from startLiveModelSync when disabled', () => {
    process.env.LIVE_MODEL_SYNC_INTERVAL_MS = '0';
    const after = vi.fn();
    const every = vi.fn();
    expect(startLiveModelSync(getDb(), { after, every } as never)).toBeNull();
    expect(after).not.toHaveBeenCalled();
    expect(every).not.toHaveBeenCalled();
  });

  it('schedules one delayed run plus the interval pass when enabled', () => {
    process.env.LIVE_MODEL_SYNC_INTERVAL_MS = '3600000';
    const after = vi.fn(() => () => {});
    const every = vi.fn(() => () => {});
    const cancel = startLiveModelSync(getDb(), { after, every } as never);
    expect(cancel).not.toBeNull();
    expect(after).toHaveBeenCalledTimes(1);
    expect(after.mock.calls[0]![0]).toBe(30_000);
    expect(every).toHaveBeenCalledTimes(1);
    expect(every.mock.calls[0]![0]).toBe(3600000);
    expect(every.mock.calls[0]![2]).toEqual({ name: 'live-model-sync' });
    (cancel as () => void)();
  });

  it('runLiveModelSync returns the contracted shape and persists settings', async () => {
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'groq';
    const result = await runLiveModelSync(getDb());
    expect(result).toMatchObject({
      ok: expect.any(Boolean),
      platforms: expect.any(Array),
      failures: expect.any(Array),
      fingerprint: expect.any(String),
      durationMs: expect.any(Number),
    });
    expect(result.counts).toMatchObject({
      added: expect.any(Number),
      reinstated: expect.any(Number),
      deprecated: expect.any(Number),
      skipped: expect.any(Number),
      paidSkipped: expect.any(Number),
      tombstoned: expect.any(Number),
    });
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const state = getLiveDiscoveryState();
    expect(state.lastRunMs).not.toBeNull();
    expect(state.lastResult?.fingerprint).toBe(result.fingerprint);
  });
});
