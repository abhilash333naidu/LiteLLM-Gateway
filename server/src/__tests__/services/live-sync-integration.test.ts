import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { initDb, getDb } from '../../db/index.js';
import { syncCatalog } from '../../services/catalog-sync.js';
import { premiumRouter } from '../../routes/premium.js';
import {
  runLiveModelSync,
  getLiveDiscoveryState,
} from '../../services/live-model-sync.js';
import type { LiveDiscoveryResult } from '../../services/live-model-sync.js';

// Integration seam: catalog-sync and the premium routes invoke the live pass
// (contract owned by the parallel live-model-sync agent) without letting it
// change base-sync results. The live module is mocked here; only the HOOK is
// under test.
vi.mock('../../services/live-model-sync.js', () => ({
  runLiveModelSync: vi.fn(),
  startLiveModelSync: vi.fn(() => null),
  getLiveDiscoveryState: vi.fn(() => ({
    enabled: false,
    lastRunMs: null,
    lastError: null,
    lastResult: null,
  })),
  liveDiscoveryIntervalMs: vi.fn(() => 0),
}));

function liveResult(over: Partial<LiveDiscoveryResult> = {}): LiveDiscoveryResult {
  return {
    ok: true,
    platforms: ['groq'],
    counts: { added: 1, reinstated: 0, deprecated: 0, skipped: 0, paidSkipped: 0, tombstoned: 0 },
    failures: [],
    fingerprint: 'abc',
    durationMs: 5,
    ...over,
  };
}

/** syncCatalog resolves before the fire-and-forget live pass runs — flush it. */
async function flushLivePass(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}${path}`;
  // NOTE: global fetch is stubbed per-test for the catalog fetch — local HTTP
  // always goes through the real one captured below.
  const res = await realFetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

const realFetch = globalThis.fetch.bind(globalThis);

describe('live-sync integration', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
  });

  const stubFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = stubFetch;
    vi.unstubAllGlobals();
  });

  it('304 path still triggers the live pass', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 304 }));
    vi.mocked(runLiveModelSync).mockResolvedValue(liveResult());

    const result = await syncCatalog();
    expect(result.ok).toBe(true);
    expect(result.action).toBe('up_to_date');

    await flushLivePass();
    expect(runLiveModelSync).toHaveBeenCalledTimes(1);
    expect(runLiveModelSync).toHaveBeenCalledWith(getDb());
  });

  it('a live-pass failure never changes syncCatalog result, settings, or tier', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 304 }));
    vi.mocked(runLiveModelSync).mockRejectedValue(new Error('live boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await syncCatalog();
    await flushLivePass();

    expect(result).toEqual({ ok: true, action: 'up_to_date', version: undefined });
    // Success-path bookkeeping is untouched by the live failure.
    expect(getDb().prepare("SELECT value FROM settings WHERE key = 'catalog_last_error'").get()).toEqual({
      value: '',
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('POST /api/premium/sync includes the live result and exposes liveDiscovery state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 304 }));
    vi.mocked(runLiveModelSync).mockResolvedValue(liveResult({ fingerprint: 'feed123' }));

    const app = express();
    app.use(express.json());
    app.use('/api/premium', premiumRouter);

    const get = await request(app, 'GET', '/api/premium');
    expect(get.status).toBe(200);
    expect(get.body.liveDiscovery).toBeDefined();
    expect(getLiveDiscoveryState).toHaveBeenCalled();

    const post = await request(app, 'POST', '/api/premium/sync');
    expect(post.status).toBe(200);
    expect(post.body.sync).toBeDefined();
    expect(post.body.sync.ok).toBe(true);
    expect(post.body.live).toBeDefined();
    expect(post.body.live.ok).toBe(true);
    expect(post.body.live.fingerprint).toBe('feed123');
    expect(post.body.liveDiscovery).toBeDefined();
  });
});
