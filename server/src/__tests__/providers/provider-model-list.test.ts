import { describe, it, expect, vi, afterEach } from 'vitest';
import { BaseProvider } from '../../providers/base.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import type {
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@freellmapi/shared/types.js';

/** Minimal concrete subclass: inherits whatever BaseProvider supplies. */
class NoListingProvider extends BaseProvider {
  readonly platform = 'groq' as const;
  readonly name = 'NoListing';

  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw new Error('not implemented');
  }

  async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
    throw new Error('not implemented');
  }

  async validateKey() {
    return true as const;
  }
}

describe('BaseProvider.listChatModels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws by default with the platform in the message', async () => {
    const provider = new NoListingProvider();
    await expect(provider.listChatModels('key')).rejects.toThrow(
      'model listing not supported for groq',
    );
  });
});

describe('OpenAICompatProvider.listChatModels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockCatalog(bodyText: string, opts?: { ok?: boolean; status?: number }) {
    const captured: { url: string; headers: Record<string, string> } = { url: '', headers: {} };
    vi.spyOn(global, 'fetch').mockImplementationOnce(async (url, init) => {
      captured.url = String(url);
      captured.headers = ((init as RequestInit)?.headers ?? {}) as Record<string, string>;
      return {
        ok: opts?.ok ?? true,
        status: opts?.status ?? 200,
        statusText: 'Status',
        headers: new Headers(),
        text: () => Promise.resolve(bodyText),
      } as unknown as Response;
    });
    return captured;
  }

  const catalogBody = JSON.stringify({
    data: [
      { id: 'model-b', owned_by: 'org-b' },
      { id: 'model-a' },
    ],
  });

  it('GETs <baseUrl>/models and returns parsed ids', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.test.com/v1',
    });
    const captured = mockCatalog(catalogBody);

    const models = await provider.listChatModels('my-key');

    expect(captured.url).toBe('https://api.test.com/v1/models');
    expect(captured.headers['Authorization']).toBe('Bearer my-key');
    expect(models.map((m) => m.id)).toEqual(['model-a', 'model-b']);
    expect(models.find((m) => m.id === 'model-b')?.ownedBy).toBe('org-b');
  });

  it('omits the Authorization header entirely for a null apiKey', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.test.com/v1',
    });
    const captured = mockCatalog(catalogBody);

    await provider.listChatModels(null);

    expect(captured.headers).not.toHaveProperty('Authorization');
  });

  it('GETs listModelsUrl when the opt is set', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'kilo',
      name: 'Kilo Gateway',
      baseUrl: 'https://api.kilo.ai/api/gateway/v1',
      listModelsUrl: 'https://api.kilo.ai/api/gateway/models',
      keyless: true,
    });
    const captured = mockCatalog(catalogBody);

    await provider.listChatModels(null);

    expect(captured.url).toBe('https://api.kilo.ai/api/gateway/models');
    expect(captured.headers).not.toHaveProperty('Authorization');
  });

  it('throws on a non-ok response', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.test.com/v1',
    });
    mockCatalog('{"error":"denied"}', { ok: false, status: 401 });

    await expect(provider.listChatModels('k')).rejects.toThrow(/HTTP 401/);
  });

  it('throws on a non-JSON body', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.test.com/v1',
    });
    mockCatalog('<html>not json</html>');

    await expect(provider.listChatModels('k')).rejects.toThrow(/did not return JSON/);
  });

  it('throws when the payload carries no model list', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.test.com/v1',
    });
    mockCatalog(JSON.stringify({ error: 'weird envelope' }));

    await expect(provider.listChatModels('k')).rejects.toThrow(/did not return a model list/);
  });

  it('throws on an empty model list', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.test.com/v1',
    });
    mockCatalog(JSON.stringify({ data: [] }));

    await expect(provider.listChatModels('k')).rejects.toThrow(/no models/i);
  });
});
