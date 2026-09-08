import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { testSingleModel, MODEL_TEST_MAX_TOKENS } from '../../services/model-test.js';
import { getProvider } from '../../providers/index.js';
import { routeRequest, setRoutingStrategy } from '../../services/router.js';
import { inFlightForKey, resetLeases } from '../../services/ratelimit.js';
import { encrypt } from '../../lib/crypto.js';

// Narrowest seam: real routeRequest against a real :memory: DB (proves the
// single-entry prefetchedChain pin, the RouteError→503 mapping, and the real
// lease release), with ONLY the provider edge stubbed via getProvider.
// The router mock below delegates to the real implementation by default; a few
// tests override it once with a fake route so route.release can be counted
// exactly (the real lease id is closed over inside the router and otherwise
// unobservable — inFlightForKey covers the no-leak half of that).
vi.mock('../../providers/index.js', async () => {
  const actual = await vi.importActual('../../providers/index.js');
  return { ...actual, getProvider: vi.fn() };
});

vi.mock('../../services/router.js', async () => {
  const actual = (await vi.importActual('../../services/router.js')) as any;
  return { ...actual, routeRequest: vi.fn((...args: any[]) => actual.routeRequest(...args)) };
});

function seedKey(platform = 'groq'): number {
  const { encrypted, iv, authTag } = encrypt(`${platform}-secret`);
  const r = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(platform, platform, encrypted, iv, authTag);
  return Number(r.lastInsertRowid);
}

function seedModel(platform = 'groq', modelId = 'probe-model', enabled = 1): number {
  const r = getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source)
    VALUES (?, ?, ?, 50, 50, ?, 'catalog')
  `).run(platform, modelId, modelId, enabled);
  return Number(r.lastInsertRowid);
}

function fakeProvider(chatImpl: (...args: any[]) => Promise<unknown>): any {
  return { platform: 'groq', chatCompletion: vi.fn(chatImpl) };
}

function okReply(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

describe('testSingleModel', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    resetLeases();
    setRoutingStrategy('priority');
    vi.clearAllMocks();
  });

  it('maps RouteError exhaustion to 503 no_usable_key with diagnostics', async () => {
    const id = seedModel(); // no api_keys row → selectKeyForModel finds nothing
    const provider = fakeProvider(async () => okReply('ok'));
    vi.mocked(getProvider).mockReturnValue(provider);

    const err: any = await testSingleModel(id).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(503);
    expect(err.code).toBe('no_usable_key');
    expect(String(err.message)).toMatch(/no usable key/i);
    // Diagnostics from the real RouteError ride along in the message.
    expect(String(err.message).length).toBeGreaterThan('no usable key for this model ()'.length);
    expect(provider.chatCompletion).not.toHaveBeenCalled();
  });

  it.each(['reasoning_content', 'reasoning'])(
    'passes on empty content with populated %s',
    async field => {
      const keyId = seedKey();
      const id = seedModel();
      const provider = fakeProvider(async () => ({
        choices: [{ message: { content: '', [field]: '  hidden trace proves life  ' } }],
      }));
      vi.mocked(getProvider).mockReturnValue(provider);

      const res = await testSingleModel(id);
      expect(res.ok).toBe(true);
      expect(res.modelDbId).toBe(id);
      expect(res.replyPreview).toContain('hidden trace proves life');
      expect(res.latencyMs).toEqual(expect.any(Number));
      // Real lease taken by routeRequest was released (no-leak half).
      expect(inFlightForKey('groq', keyId)).toBe(0);
    },
  );

  it('returns ok:false empty_response on empty content and empty reasoning without throwing', async () => {
    const keyId = seedKey();
    const id = seedModel();
    const provider = fakeProvider(async () => ({
      choices: [{ message: { content: '   ', reasoning_content: '', reasoning: '' } }],
    }));
    vi.mocked(getProvider).mockReturnValue(provider);

    const res = await testSingleModel(id);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('empty_response');
    expect(res.modelDbId).toBe(id);
    expect(inFlightForKey('groq', keyId)).toBe(0);
  });

  it('sends the contracted probe shape (prompt, max_tokens 256, temperature 0)', async () => {
    seedKey();
    const id = seedModel('groq', 'shape-model');
    const provider = fakeProvider(async () => okReply('ok'));
    vi.mocked(getProvider).mockReturnValue(provider);

    await testSingleModel(id);
    expect(provider.chatCompletion).toHaveBeenCalledTimes(1);
    const [apiKey, messages, modelId, opts] = provider.chatCompletion.mock.calls[0] as any[];
    expect(typeof apiKey).toBe('string');
    expect(messages).toEqual([{ role: 'user', content: 'Reply with just: ok' }]);
    expect(modelId).toBe('shape-model');
    expect(opts).toMatchObject({ max_tokens: MODEL_TEST_MAX_TOKENS, temperature: 0 });
    expect(MODEL_TEST_MAX_TOKENS).toBe(256);
    // Pinned to exactly this row: single-entry prefetchedChain.
    const chain = (vi.mocked(routeRequest).mock.calls[0] as any[])[6];
    expect(chain).toHaveLength(1);
    expect(chain[0].model_db_id).toBe(id);
  });

  it('clamps upstream 401 to 502 — never 401', async () => {
    const keyId = seedKey();
    const id = seedModel();
    const provider = fakeProvider(async () => {
      throw Object.assign(new Error('invalid key (HTTP 401)'), { status: 401 });
    });
    vi.mocked(getProvider).mockReturnValue(provider);

    const err: any = await testSingleModel(id).catch(e => e);
    expect(err.status).toBe(502);
    expect(err.status).not.toBe(401);
    expect(err.code).toBe('upstream_error');
    // Real lease released even on the throw path.
    expect(inFlightForKey('groq', keyId)).toBe(0);
  });

  it('releases the route lease exactly once on success', async () => {
    const id = seedModel('groq', 'release-ok-model');
    seedKey();
    const release = vi.fn();
    const provider = fakeProvider(async () => okReply('ok'));
    vi.mocked(getProvider).mockReturnValue(provider);
    vi.mocked(routeRequest).mockImplementationOnce(() => ({
      provider, platform: 'groq', modelId: 'release-ok-model', modelDbId: id,
      apiKey: 'k', keyId: 1, keyLabel: null, displayName: 'release-ok-model',
      endpointScope: '', rpdLimit: null, tpdLimit: null, release,
    }) as any);

    const res = await testSingleModel(id);
    expect(res.ok).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the route lease exactly once on provider throw', async () => {
    const id = seedModel('groq', 'release-err-model');
    seedKey();
    const release = vi.fn();
    const provider = fakeProvider(async () => {
      throw Object.assign(new Error('boom'), { status: 500 });
    });
    vi.mocked(getProvider).mockReturnValue(provider);
    vi.mocked(routeRequest).mockImplementationOnce(() => ({
      provider, platform: 'groq', modelId: 'release-err-model', modelDbId: id,
      apiKey: 'k', keyId: 1, keyLabel: null, displayName: 'release-err-model',
      endpointScope: '', rpdLimit: null, tpdLimit: null, release,
    }) as any);

    const err: any = await testSingleModel(id).catch(e => e);
    expect(err.status).toBe(500);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rejects a disabled model with 400 model_disabled', async () => {
    const id = seedModel('groq', 'off-model', 0);
    const err: any = await testSingleModel(id).catch(e => e);
    expect(err.status).toBe(400);
    expect(err.code).toBe('model_disabled');
  });

  it('rejects an unknown model id with 404 not_found', async () => {
    const err: any = await testSingleModel(999_999).catch(e => e);
    expect(err.status).toBe(404);
    expect(err.code).toBe('not_found');
  });
});
