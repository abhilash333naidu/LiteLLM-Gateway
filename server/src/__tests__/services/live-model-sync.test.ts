import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import {
  runLiveModelSync,
  startLiveModelSync,
  getLiveDiscoveryState,
  liveDiscoveryIntervalMs,
} from '../../services/live-model-sync.js';
import { getProvider } from '../../providers/index.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { decrypt } from '../../lib/crypto.js';

// The sync talks to keyed providers ONLY through getProvider + fetchModelCatalog;
// stub the registry edge so each test controls what a platform "serves".
vi.mock('../../providers/index.js', async () => {
  const actual = await vi.importActual('../../providers/index.js');
  return { ...actual, getProvider: vi.fn() };
});

// Stored credentials are decrypted by the crypto module; return a stable
// plaintext so keyed tests never touch real key material.
vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'plain-test-key') };
});

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
    vi.unstubAllGlobals();
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

function liveRows(): Array<Record<string, unknown>> {
  return getDb().prepare("SELECT * FROM models WHERE source = 'live' ORDER BY model_id").all() as Array<
    Record<string, unknown>
  >;
}

function openRouterEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'meta-llama/llama-3.3-70b-instruct:free',
    pricing: { prompt: '0', completion: '0' },
    architecture: { input_modalities: ['text'], output_modalities: ['text'], modality: 'text->text' },
    supported_parameters: ['tools', 'temperature'],
    context_length: 131072,
    ...over,
  };
}

function stubOpenRouterFetch(payload: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('live-model-sync openrouter collector', () => {
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
    process.env.LIVE_MODEL_SYNC_INTERVAL_MS = '3600000';
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'openrouter';
  });

  afterEach(() => {
    delete process.env.LIVE_MODEL_SYNC_INTERVAL_MS;
    delete process.env.LIVE_MODEL_SYNC_PLATFORMS;
    vi.unstubAllGlobals();
  });

  it('fetches keyless from the OpenRouter catalog URL', async () => {
    const fetchMock = stubOpenRouterFetch({ data: [] });
    await runLiveModelSync(getDb());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('https://openrouter.ai/api/v1/models');
    expect(init?.headers ?? {}).not.toMatchObject({ authorization: expect.anything() });
  });

  it('adds free text models with verbatim ids and capability evidence', async () => {
    stubOpenRouterFetch({
      data: [
        openRouterEntry(),
        openRouterEntry({
          id: 'qwen/qwen3-coder:free',
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'], modality: 'text+image->text' },
          supported_parameters: ['temperature'],
        }),
        openRouterEntry({ id: 'openai/gpt-4o', pricing: { prompt: '0.0025', completion: '0.01' } }),
      ],
    });
    const result = await runLiveModelSync(getDb());
    expect(result.ok).toBe(true);
    expect(result.platforms).toEqual(['openrouter']);
    expect(result.counts.added).toBe(2);
    expect(result.counts.paidSkipped).toBe(1);

    const rows = liveRows();
    expect(rows.map(r => r.model_id)).toEqual(['meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen3-coder:free']);
    const text = rows[0]!;
    expect(text.display_name).toBe('meta-llama/llama-3.3-70b-instruct:free');
    expect(text.source).toBe('live');
    expect(text.key_id).toBeNull();
    expect(text.endpoint_scope).toBe('');
    expect(text.enabled).toBe(1);
    expect(text.supports_tools).toBe(1);
    expect(text.supports_vision).toBe(0);
    expect(text.context_window).toBe(131072);
    expect(text.rpm_limit).toBe(20);
    expect(text.rpd_limit).toBe(50);
    expect(text.tpm_limit).toBeNull();
    expect(text.tpd_limit).toBeNull();
    expect(text.monthly_token_budget).toBe('');
    // Explicit no-tools evidence writes 0; vision evidence writes 1.
    expect(rows[1]!.supports_tools).toBe(0);
    expect(rows[1]!.supports_vision).toBe(1);
    // Fallback chain + profiles match the custom-register write path.
    for (const row of rows) {
      const chain = getDb().prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(row.id) as {
        enabled: number;
      };
      expect(chain.enabled).toBe(1);
    }
    const profiled = getDb().prepare('SELECT COUNT(*) AS n FROM profile_models').get() as { n: number };
    expect(profiled.n).toBeGreaterThan(0);
  });

  it('reads vision off the modality string when no arrays are advertised', async () => {
    stubOpenRouterFetch({
      data: [openRouterEntry({ id: 'x/vl:free', architecture: { modality: 'text+image->text' } })],
    });
    const result = await runLiveModelSync(getDb());
    expect(result.counts.added).toBe(1);
    expect(liveRows()[0]!.supports_vision).toBe(1);
  });

  it('skips non-text output rows and rows with no price evidence', async () => {
    stubOpenRouterFetch({
      data: [
        openRouterEntry({
          id: 'google/lyria-01',
          pricing: { prompt: '0', completion: '0' },
          architecture: { input_modalities: ['text'], output_modalities: ['audio'], modality: 'text->audio' },
        }),
        openRouterEntry({ id: 'x/unpriced:free', pricing: undefined }),
      ],
    });
    const result = await runLiveModelSync(getDb());
    expect(result.counts.added).toBe(0);
    expect(result.counts.paidSkipped).toBe(2);
    expect(liveRows()).toEqual([]);
  });

  it('caps the roster at MAX_DISCOVERED_MODELS', async () => {
    const data = Array.from({ length: 600 }, (_, i) => openRouterEntry({ id: `org/model-${i}:free` }));
    stubOpenRouterFetch({ data });
    const result = await runLiveModelSync(getDb());
    expect(result.counts.added).toBe(500);
    expect(liveRows()).toHaveLength(500);
  });

  it('records a failure and writes nothing on non-200', async () => {
    stubOpenRouterFetch({ error: 'nope' }, 500);
    const result = await runLiveModelSync(getDb());
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.platform).toBe('openrouter');
    expect(liveRows()).toEqual([]);
  });

  it('records a failure and writes nothing on an unparseable body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json {{', { status: 200 })));
    const result = await runLiveModelSync(getDb());
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(liveRows()).toEqual([]);
  });

  it('produces a stable fingerprint across identical runs', async () => {
    stubOpenRouterFetch({ data: [openRouterEntry(), openRouterEntry({ id: 'qwen/qwen3-coder:free' })] });
    const first = await runLiveModelSync(getDb());
    const second = await runLiveModelSync(getDb());
    expect(first.ok).toBe(true);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.counts.added).toBe(0);
    expect(second.counts.skipped).toBe(2);
  });
});

function addApiKey(platform: string, status = 'healthy', enabled = 1): void {
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test-key', 'enc', 'iv', 'tag', ?, ?)
  `).run(platform, status, enabled);
}

function keyedProviderServing(ids: string[], status = 200): { provider: OpenAICompatProvider; catalog: ReturnType<typeof vi.fn> } {
  const provider = new OpenAICompatProvider({ platform: 'opencode', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1' });
  const catalog = vi.spyOn(provider, 'fetchModelCatalog')
    .mockResolvedValue(new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { status }));
  return { provider, catalog };
}

describe('live-model-sync keyed collectors', () => {
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
    process.env.LIVE_MODEL_SYNC_INTERVAL_MS = '3600000';
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'opencode';
  });

  afterEach(() => {
    delete process.env.LIVE_MODEL_SYNC_INTERVAL_MS;
    delete process.env.LIVE_MODEL_SYNC_PLATFORMS;
    vi.unstubAllGlobals();
  });

  it('opencode admits only *-free ids plus big-pickle', async () => {
    addApiKey('opencode');
    const { provider } = keyedProviderServing(['model-a-free', 'big-pickle', 'gpt-4o', 'freebie']);
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(provider);

    const result = await runLiveModelSync(getDb());
    expect(result.ok).toBe(true);
    expect(result.counts.added).toBe(2);
    expect(result.counts.paidSkipped).toBe(2);
    expect(liveRows().map(r => r.model_id)).toEqual(['big-pickle', 'model-a-free']);
    // The stored credential is decrypted and handed to the catalog fetch.
    expect(decrypt).toHaveBeenCalledWith('enc', 'iv', 'tag');
  });

  it('groq admits every served model id', async () => {
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'groq';
    addApiKey('groq', 'unknown');
    const groq = new OpenAICompatProvider({ platform: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' });
    vi.spyOn(groq, 'fetchModelCatalog')
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'paid-pro' }] }), { status: 200 }));
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(groq);

    const result = await runLiveModelSync(getDb());
    expect(result.counts.added).toBe(2);
    expect(result.counts.paidSkipped).toBe(0);
  });

  it('skips a platform with no usable key without failing', async () => {
    addApiKey('opencode', 'invalid');
    addApiKey('opencode', 'healthy', 0);
    const { provider, catalog } = keyedProviderServing(['model-a-free']);
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(provider);

    const result = await runLiveModelSync(getDb());
    expect(catalog).not.toHaveBeenCalled();
    expect(result.platforms).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(liveRows()).toEqual([]);
  });

  it('leaves error-status keys out of rotation', async () => {
    addApiKey('opencode', 'error');
    const { catalog } = keyedProviderServing(['model-a-free']);
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new OpenAICompatProvider({ platform: 'opencode', name: 'x', baseUrl: 'https://opencode.ai/zen/v1' }),
    );
    const result = await runLiveModelSync(getDb());
    expect(catalog).not.toHaveBeenCalled();
    expect(result.failures).toEqual([]);
  });

  it('skips providers that are not OpenAI-compatible catalogs', async () => {
    addApiKey('google');
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'google';
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ platform: 'google' });

    const result = await runLiveModelSync(getDb());
    expect(result.platforms).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(liveRows()).toEqual([]);
  });

  it('a keyed 401 is recorded and never disables existing rows', async () => {
    addApiKey('opencode');
    const provider = new OpenAICompatProvider({ platform: 'opencode', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1' });
    vi.spyOn(provider, 'fetchModelCatalog').mockResolvedValue(new Response('denied', { status: 401 }));
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(provider);
    getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, source, endpoint_scope)
      VALUES ('opencode', 'model-a-free', 'model-a-free', 50, 50, 'Medium', 1, 'live', '')
    `).run();

    const result = await runLiveModelSync(getDb());
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.platform).toBe('opencode');
    const row = getDb().prepare("SELECT enabled FROM models WHERE platform = 'opencode'").get() as { enabled: number };
    expect(row.enabled).toBe(1);
  });

  it('an empty keyed list is inconclusive: failure recorded, rows untouched', async () => {
    addApiKey('opencode');
    const { provider } = keyedProviderServing([]);
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(provider);
    getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, source, endpoint_scope)
      VALUES ('opencode', 'model-a-free', 'model-a-free', 50, 50, 'Medium', 1, 'live', '')
    `).run();

    const result = await runLiveModelSync(getDb());
    expect(result.failures).toHaveLength(1);
    expect(result.counts.deprecated).toBe(0);
    const row = getDb().prepare("SELECT enabled FROM models WHERE platform = 'opencode'").get() as { enabled: number };
    expect(row.enabled).toBe(1);
  });
});
