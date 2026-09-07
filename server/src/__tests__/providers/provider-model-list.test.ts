import { describe, it, expect, vi, afterEach } from 'vitest';
import { BaseProvider } from '../../providers/base.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { GoogleProvider } from '../../providers/google.js';
import { CohereProvider } from '../../providers/cohere.js';
import { getProvider } from '../../providers/index.js';
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

describe('kilo registration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists via the gateway models URL (its /v1/models 405s)', async () => {
    let capturedUrl = '';
    vi.spyOn(global, 'fetch').mockImplementationOnce(async (url) => {
      capturedUrl = String(url);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({ data: [{ id: 'kilo-model' }] })),
      } as unknown as Response;
    });

    const models = await getProvider('kilo')!.listChatModels(null);

    expect(capturedUrl).toBe('https://api.kilo.ai/api/gateway/models');
    expect(models.map((m) => m.id)).toEqual(['kilo-model']);
  });
});

describe('GoogleProvider.listChatModels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockGoogle(bodyText: string, opts?: { ok?: boolean; status?: number }) {
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

  const googleBody = JSON.stringify({
    models: [
      {
        name: 'models/gemini-2.0-flash',
        displayName: 'Gemini 2.0 Flash',
        supportedGenerationMethods: ['generateContent', 'countTokens'],
      },
      { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/no-methods', displayName: 'No Methods' },
    ],
  });

  it('keeps generateContent entries, strips the models/ prefix, maps displayName', async () => {
    const captured = mockGoogle(googleBody);

    const models = await new GoogleProvider().listChatModels('g-key');

    expect(captured.url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(captured.headers['x-goog-api-key']).toBe('g-key');
    expect(models.map((m) => m.id)).toEqual(['gemini-2.0-flash']);
    expect(models[0].ownedBy).toBe('Gemini 2.0 Flash');
    expect(models[0].contextWindow).toBeUndefined();
    expect(models[0].vision).toBeUndefined();
  });

  it('throws when nothing supports generateContent', async () => {
    mockGoogle(JSON.stringify({
      models: [{ name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }],
    }));

    await expect(new GoogleProvider().listChatModels('g-key')).rejects.toThrow(/no models/i);
  });

  it('throws on a non-ok response', async () => {
    mockGoogle('denied', { ok: false, status: 400 });

    await expect(new GoogleProvider().listChatModels('g-key')).rejects.toThrow(/HTTP 400/);
  });
});

describe('CohereProvider.listChatModels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps chat/generate entries plus endpoint-less ones, drops embed-only', async () => {
    const captured: { url: string; headers: Record<string, string> } = { url: '', headers: {} };
    vi.spyOn(global, 'fetch').mockImplementationOnce(async (url, init) => {
      captured.url = String(url);
      captured.headers = ((init as RequestInit)?.headers ?? {}) as Record<string, string>;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: () =>
          Promise.resolve(
            JSON.stringify({
              models: [
                { name: 'command-r', endpoints: ['chat'] },
                { name: 'command-gen', endpoints: ['Generate'] },
                { name: 'command-bare' },
                { name: 'embed-x', endpoints: ['embed'] },
              ],
            }),
          ),
      } as unknown as Response;
    });

    const models = await new CohereProvider().listChatModels('c-key');

    expect(captured.url).toBe('https://api.cohere.ai/compatibility/v1/models');
    expect(captured.headers['Authorization']).toBe('Bearer c-key');
    expect(models.map((m) => m.id)).toEqual(['command-bare', 'command-gen', 'command-r']);
  });

  it('throws when nothing chat-capable remains', async () => {
    vi.spyOn(global, 'fetch').mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ models: [{ name: 'embed-x', endpoints: ['embed'] }] })),
    } as unknown as Response));

    await expect(new CohereProvider().listChatModels('c-key')).rejects.toThrow(/no models/i);
  });

  it('throws on a non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockImplementationOnce(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers(),
      text: () => Promise.resolve('denied'),
    } as unknown as Response));

    await expect(new CohereProvider().listChatModels('c-key')).rejects.toThrow(/HTTP 401/);
  });
});
