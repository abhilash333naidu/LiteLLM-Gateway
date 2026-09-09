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

// The sync talks to keyed providers ONLY through getProvider + listChatModels;
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

function keyedProviderServing(ids: string[]): { provider: OpenAICompatProvider; catalog: ReturnType<typeof vi.fn> } {
  const provider = new OpenAICompatProvider({ platform: 'opencode', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1' });
  const catalog = vi.spyOn(provider, 'listChatModels')
    .mockResolvedValue(ids.map(id => ({ id, ownedBy: null })));
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
    vi.spyOn(groq, 'listChatModels')
      .mockResolvedValue([{ id: 'llama-3.3-70b-versatile', ownedBy: null }, { id: 'paid-pro', ownedBy: null }]);
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
    vi.spyOn(provider, 'listChatModels').mockRejectedValue(new Error('opencode listChatModels unreachable: denied (HTTP 401)'));
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

function addLiveRow(platform: string, id: string, enabled = 1): number {
  const info = getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, source, endpoint_scope)
    VALUES (?, ?, ?, 50, 50, 'Medium', ?, 'live', '')
  `).run(platform, id, id, enabled);
  const modelDbId = Number(info.lastInsertRowid);
  getDb().prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, ?)').run(modelDbId, modelDbId, enabled);
  const profile = getDb().prepare('SELECT id FROM profiles LIMIT 1').get() as { id: number } | undefined;
  if (profile) {
    getDb().prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)').run(profile.id, modelDbId, modelDbId, enabled);
  }
  return modelDbId;
}

function tombstoneOf(platform: string, id: string): Record<string, unknown> | undefined {
  return getDb().prepare("SELECT source, reason FROM catalog_model_tombstones WHERE kind = 'chat' AND platform = ? AND model_id = ?").get(platform, id) as
    | Record<string, unknown>
    | undefined;
}

function listChatModelsProvider(
  platform: string,
  ids: Array<Record<string, unknown>> | null,
  err?: unknown,
): { provider: Record<string, unknown>; listChatModels: ReturnType<typeof vi.fn> } {
  const listChatModels = vi.fn(async (_key: string | null) => {
    if (err) throw err;
    return ids;
  });
  return { provider: { platform, listChatModels }, listChatModels };
}

function catalogProviderServing(platform: string, ids: string[]): OpenAICompatProvider {
  const provider = new OpenAICompatProvider({ platform: platform as never, name: platform, baseUrl: 'https://example.invalid/v1' });
  vi.spyOn(provider, 'listChatModels')
    .mockResolvedValue(ids.map(id => ({ id, ownedBy: null })));
  return provider;
}

describe('live-model-sync probe rules (Tier1+Tier2 rollout)', () => {
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
    delete process.env.LIVE_MODEL_SYNC_PLATFORMS;
  });

  afterEach(() => {
    delete process.env.LIVE_MODEL_SYNC_INTERVAL_MS;
    delete process.env.LIVE_MODEL_SYNC_PLATFORMS;
    vi.unstubAllGlobals();
  });

  it('routeway and unorouter admit only *-suffixed :free ids', async () => {
    for (const platform of ['routeway', 'unorouter']) {
      process.env.LIVE_MODEL_SYNC_PLATFORMS = platform;
      addApiKey(platform);
      (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
        catalogProviderServing(platform, ['qwen/qwen3:free', 'gpt-4o', 'other:free']),
      );
      const result = await runLiveModelSync(getDb());
      expect(result.ok).toBe(true);
      expect(result.counts.paidSkipped).toBe(1);
      expect(liveRows().map(r => r.model_id)).toEqual(['other:free', 'qwen/qwen3:free']);
      getDb().exec('DELETE FROM profile_models; DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models;');
      vi.clearAllMocks();
    }
  });

  it('orcarouter admits *-free ids plus orcarouter/free', async () => {
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'orcarouter';
    addApiKey('orcarouter');
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      catalogProviderServing('orcarouter', ['model-x-free', 'orcarouter/free', 'paid-pro']),
    );
    const result = await runLiveModelSync(getDb());
    expect(result.ok).toBe(true);
    expect(result.counts.added).toBe(2);
    expect(result.counts.paidSkipped).toBe(1);
    expect(liveRows().map(r => r.model_id)).toEqual(['model-x-free', 'orcarouter/free']);
  });

  it('bazaarlink admits only the auto:free route', async () => {
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'bazaarlink';
    addApiKey('bazaarlink');
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      catalogProviderServing('bazaarlink', ['auto:free', 'deepseek-v3']),
    );
    const result = await runLiveModelSync(getDb());
    expect(result.ok).toBe(true);
    expect(result.counts.added).toBe(1);
    expect(result.counts.paidSkipped).toBe(1);
    expect(liveRows().map(r => r.model_id)).toEqual(['auto:free']);
  });

  it('reka admits only its two exact ids', async () => {
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'reka';
    addApiKey('reka');
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      catalogProviderServing('reka', ['reka-flash-3', 'reka-edge-2603', 'reka-core']),
    );
    const result = await runLiveModelSync(getDb());
    expect(result.ok).toBe(true);
    expect(result.counts.added).toBe(2);
    expect(result.counts.paidSkipped).toBe(1);
  });

  it('nara admits only its three exact ids', async () => {
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'nara';
    addApiKey('nara');
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      catalogProviderServing('nara', ['mistral-large', 'mistral-medium-3-5', 'tencent-hy3', 'gpt-4o']),
    );
    const result = await runLiveModelSync(getDb());
    expect(result.ok).toBe(true);
    expect(result.counts.added).toBe(3);
    expect(result.counts.paidSkipped).toBe(1);
  });

  it('agnes admits agnes-prefixed ids', async () => {
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'agnes';
    addApiKey('agnes');
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      catalogProviderServing('agnes', ['agnes-2.0-flash', 'gpt-4o']),
    );
    const result = await runLiveModelSync(getDb());
    expect(result.ok).toBe(true);
    expect(result.counts.added).toBe(1);
    expect(result.counts.paidSkipped).toBe(1);
    expect(liveRows().map(r => r.model_id)).toEqual(['agnes-2.0-flash']);
  });

  it('star-glob platforms admit every served id', async () => {
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'sealion';
    addApiKey('sealion');
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      catalogProviderServing('sealion', ['sealion-v4', 'anything-goes']),
    );
    const result = await runLiveModelSync(getDb());
    expect(result.ok).toBe(true);
    expect(result.counts.added).toBe(2);
    expect(result.counts.paidSkipped).toBe(0);
  });

  it('preserves well-formed vision/context evidence from listChatModels', async () => {
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'sealion';
    addApiKey('sealion');
    const { provider } = listChatModelsProvider('sealion', [
      { id: 'sealion-vl', vision: true, contextWindow: 131072 },
      { id: 'sealion-text', vision: 'yes', contextWindow: 'huge' },
      { id: 'sealion-neg', contextWindow: -5 },
    ]);
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(provider);
    const result = await runLiveModelSync(getDb());
    expect(result.ok).toBe(true);
    expect(result.counts.added).toBe(3);
    const rows = getDb().prepare(
      "SELECT model_id, supports_vision, context_window FROM models WHERE source = 'live' ORDER BY model_id",
    ).all() as Array<{ model_id: string; supports_vision: number; context_window: number | null }>;
    expect(rows.find(r => r.model_id === 'sealion-vl')).toMatchObject({ supports_vision: 1, context_window: 131072 });
    expect(rows.find(r => r.model_id === 'sealion-text')).toMatchObject({ supports_vision: 0, context_window: null });
    expect(rows.find(r => r.model_id === 'sealion-neg')).toMatchObject({ supports_vision: 0, context_window: null });
  });

  it('unknown platforms in the env list are skipped silently', async () => {
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'frobnicate';
    const result = await runLiveModelSync(getDb());
    expect(result.platforms).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(getProvider as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(liveRows()).toEqual([]);
  });

  it('excluded platforms are never attempted', async () => {
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'huggingface,zhipu,modelscope,requesty,siliconflow,xkiro,qianfan,volcengine,longcat,xfyun';
    addApiKey('huggingface');
    const provider = catalogProviderServing('huggingface', ['some-model']);
    const catalog = vi.spyOn(provider, 'listChatModels');
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(provider);
    const result = await runLiveModelSync(getDb());
    expect(catalog).not.toHaveBeenCalled();
    expect(result.platforms).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(liveRows()).toEqual([]);
  });

  it('keyless pollinations probes with a null key and no key row', async () => {
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'pollinations';
    const { provider, listChatModels } = listChatModelsProvider('pollinations', [{ id: 'openai' }, { id: 'mistral-small' }]);
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(provider);
    const result = await runLiveModelSync(getDb());
    expect(result.ok).toBe(true);
    expect(listChatModels).toHaveBeenCalledTimes(1);
    expect(listChatModels).toHaveBeenCalledWith(null);
    expect(decrypt).not.toHaveBeenCalled();
    expect(result.counts.added).toBe(2);
    expect(liveRows().map(r => r.model_id)).toEqual(['mistral-small', 'openai']);
  });

  it('keyed listChatModels path passes the decrypted key and merges filtered results', async () => {
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'nara';
    addApiKey('nara');
    const { provider, listChatModels } = listChatModelsProvider('nara', [{ id: 'mistral-large' }, { id: 'gpt-4o' }]);
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(provider);
    const result = await runLiveModelSync(getDb());
    expect(result.ok).toBe(true);
    expect(listChatModels).toHaveBeenCalledTimes(1);
    expect(listChatModels).toHaveBeenCalledWith('plain-test-key');
    expect(result.counts.added).toBe(1);
    expect(result.counts.paidSkipped).toBe(1);
    expect(liveRows().map(r => r.model_id)).toEqual(['mistral-large']);
  });

  it('a listChatModels throw is inconclusive: failure recorded, rows untouched', async () => {
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'kilo';
    const goneId = addLiveRow('kilo', 'model-x:free');
    const { provider, listChatModels } = listChatModelsProvider('kilo', null, new Error('boom 405'));
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(provider);
    const result = await runLiveModelSync(getDb());
    expect(listChatModels).toHaveBeenCalledWith(null);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.platform).toBe('kilo');
    expect(result.counts.deprecated).toBe(0);
    const row = getDb().prepare('SELECT enabled FROM models WHERE id = ?').get(goneId) as { enabled: number };
    expect(row.enabled).toBe(1);
  });

  it('an empty listChatModels roster is inconclusive and deprecates nothing', async () => {
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'kilo';
    addLiveRow('kilo', 'model-x:free');
    const { provider } = listChatModelsProvider('kilo', []);
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue(provider);
    const result = await runLiveModelSync(getDb());
    expect(result.failures).toHaveLength(1);
    expect(result.counts.deprecated).toBe(0);
  });

  it('keyless kilo without a listChatModels adapter is skipped, not failed', async () => {
    process.env.LIVE_MODEL_SYNC_PLATFORMS = 'kilo';
    (getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ platform: 'kilo' });
    const result = await runLiveModelSync(getDb());
    expect(result.platforms).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(liveRows()).toEqual([]);
  });
});

describe('live-model-sync deprecation and reinstate', () => {
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

  it('deprecates live rows missing from a successful non-empty fetch', async () => {
    const goneId = addLiveRow('openrouter', 'gone-model');
    addLiveRow('openrouter', 'kept-model');
    stubOpenRouterFetch({ data: [openRouterEntry({ id: 'kept-model' })] });

    const result = await runLiveModelSync(getDb());
    expect(result.ok).toBe(true);
    expect(result.counts.deprecated).toBe(1);
    const gone = getDb().prepare('SELECT enabled FROM models WHERE id = ?').get(goneId) as { enabled: number };
    expect(gone.enabled).toBe(0);
    expect((getDb().prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(goneId) as { enabled: number }).enabled).toBe(0);
    expect((getDb().prepare('SELECT enabled FROM profile_models WHERE model_db_id = ?').get(goneId) as { enabled: number }).enabled).toBe(0);
    const tomb = tombstoneOf('openrouter', 'gone-model');
    expect(tomb?.source).toBe('upstream_eol');
    expect(String(tomb?.reason)).toMatch(/^live-sync: /);
    const kept = getDb().prepare("SELECT enabled FROM models WHERE model_id = 'kept-model'").get() as { enabled: number };
    expect(kept.enabled).toBe(1);
  });

  it('never deprecates non-live rows', async () => {
    getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, source, endpoint_scope)
      VALUES ('openrouter', 'catalog-model', 'Catalog Model', 10, 5, 'Medium', 1, 'catalog', '')
    `).run();
    getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, source, endpoint_scope)
      VALUES ('openrouter', 'user-model', 'User Model', 10, 5, 'Medium', 1, 'user', '')
    `).run();
    stubOpenRouterFetch({ data: [openRouterEntry({ id: 'kept-model' })] });

    const result = await runLiveModelSync(getDb());
    expect(result.counts.deprecated).toBe(0);
    for (const id of ['catalog-model', 'user-model']) {
      const row = getDb().prepare('SELECT enabled FROM models WHERE model_id = ?').get(id) as { enabled: number };
      expect(row.enabled).toBe(1);
      expect(tombstoneOf('openrouter', id)).toBeUndefined();
    }
  });

  it('a failed fetch deprecates nothing', async () => {
    addLiveRow('openrouter', 'gone-model');
    stubOpenRouterFetch({ error: 'down' }, 500);

    const result = await runLiveModelSync(getDb());
    expect(result.ok).toBe(false);
    expect(result.counts.deprecated).toBe(0);
    const row = getDb().prepare("SELECT enabled FROM models WHERE model_id = 'gone-model'").get() as { enabled: number };
    expect(row.enabled).toBe(1);
  });

  it('never updates metadata of an existing non-live row', async () => {
    getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
        rpm_limit, rpd_limit, monthly_token_budget, context_window, enabled, supports_tools, supports_vision, source, endpoint_scope)
      VALUES ('openrouter', 'shared-model', 'Operator Name', 99, 88, 'Large', 30, 1000, '~1M', 8192, 1, 0, 1, 'catalog', '')
    `).run();
    stubOpenRouterFetch({ data: [openRouterEntry({ id: 'shared-model' })] });

    const result = await runLiveModelSync(getDb());
    expect(result.counts.skipped).toBe(1);
    expect(result.counts.added).toBe(0);
    const row = getDb().prepare("SELECT * FROM models WHERE model_id = 'shared-model'").get() as Record<string, unknown>;
    expect(row.display_name).toBe('Operator Name');
    expect(row.intelligence_rank).toBe(99);
    expect(row.speed_rank).toBe(88);
    expect(row.rpm_limit).toBe(30);
    expect(row.supports_tools).toBe(0);
    expect(row.supports_vision).toBe(1);
    expect(row.source).toBe('catalog');
  });

  it('never re-enables a user-disabled live row', async () => {
    addLiveRow('openrouter', 'off-model', 0);
    stubOpenRouterFetch({ data: [openRouterEntry({ id: 'off-model' })] });

    const result = await runLiveModelSync(getDb());
    expect(result.counts.reinstated).toBe(0);
    expect(result.counts.skipped).toBe(1);
    const row = getDb().prepare("SELECT enabled FROM models WHERE model_id = 'off-model'").get() as { enabled: number };
    expect(row.enabled).toBe(0);
  });

  it('never re-adds a user-tombstoned model', async () => {
    const { recordCatalogModelTombstone } = await import('../../services/model-state.js');
    recordCatalogModelTombstone(getDb(), 'chat', 'openrouter', 'dead-model', { source: 'user', reason: 'deleted in dashboard' });
    stubOpenRouterFetch({ data: [openRouterEntry({ id: 'dead-model' })] });

    const result = await runLiveModelSync(getDb());
    expect(result.counts.tombstoned).toBe(1);
    expect(result.counts.added).toBe(0);
    expect(liveRows()).toEqual([]);
  });

  it('re-listing reinstates only live-sync tombstones (chain left to the user)', async () => {
    const reId = addLiveRow('openrouter', 'back-model', 0);
    const { recordCatalogModelTombstone } = await import('../../services/model-state.js');
    recordCatalogModelTombstone(getDb(), 'chat', 'openrouter', 'back-model', {
      source: 'upstream_eol',
      reason: 'live-sync: absent from provider list as of 2026-01-01T00:00:00.000Z',
    });
    stubOpenRouterFetch({ data: [openRouterEntry({ id: 'back-model' })] });

    const result = await runLiveModelSync(getDb());
    expect(result.counts.reinstated).toBe(1);
    expect((getDb().prepare('SELECT enabled FROM models WHERE id = ?').get(reId) as { enabled: number }).enabled).toBe(1);
    // Chain membership is the user's: reinstate restores availability but must
    // not resurrect chain flags (a dashboard disable writes chain flags, and
    // flipping them here re-enabled explicitly-disabled models on boot).
    expect((getDb().prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(reId) as { enabled: number }).enabled).toBe(0);
    expect(tombstoneOf('openrouter', 'back-model')).toBeUndefined();
  });

  it('re-listing leaves 410-retirement tombstones alone', async () => {
    const reId = addLiveRow('openrouter', 'retired-model', 0);
    const { recordCatalogModelTombstone } = await import('../../services/model-state.js');
    recordCatalogModelTombstone(getDb(), 'chat', 'openrouter', 'retired-model', {
      source: 'upstream_eol',
      reason: 'upstream reports it retired: 410 end of life',
    });
    stubOpenRouterFetch({ data: [openRouterEntry({ id: 'retired-model' })] });

    const result = await runLiveModelSync(getDb());
    expect(result.counts.reinstated).toBe(0);
    expect((getDb().prepare('SELECT enabled FROM models WHERE id = ?').get(reId) as { enabled: number }).enabled).toBe(0);
    expect(tombstoneOf('openrouter', 'retired-model')?.reason).toBe('upstream reports it retired: 410 end of life');
  });

  it('re-listing respects a model_overrides pin on enabled', async () => {
    const reId = addLiveRow('openrouter', 'pinned-model', 0);
    const { recordCatalogModelTombstone, upsertModelOverrides } = await import('../../services/model-state.js');
    recordCatalogModelTombstone(getDb(), 'chat', 'openrouter', 'pinned-model', {
      source: 'upstream_eol',
      reason: 'live-sync: absent from provider list as of 2026-01-01T00:00:00.000Z',
    });
    upsertModelOverrides(getDb(), 'openrouter', 'pinned-model', { enabled: false });
    stubOpenRouterFetch({ data: [openRouterEntry({ id: 'pinned-model' })] });

    const result = await runLiveModelSync(getDb());
    expect(result.counts.reinstated).toBe(0);
    expect((getDb().prepare('SELECT enabled FROM models WHERE id = ?').get(reId) as { enabled: number }).enabled).toBe(0);
    expect(tombstoneOf('openrouter', 'pinned-model')?.source).toBe('upstream_eol');
  });
});
