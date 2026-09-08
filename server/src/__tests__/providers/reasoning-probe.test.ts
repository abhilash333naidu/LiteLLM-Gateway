import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { GoogleProvider } from '../../providers/google.js';
import { CloudflareProvider } from '../../providers/cloudflare.js';
import { CohereProvider } from '../../providers/cohere.js';
import { AIHordeProvider } from '../../providers/aihorde.js';
import { providerHttpError } from '../../providers/base.js';
import { contentToString } from '../../lib/content.js';

// Mirrors server/src/services/model-test.ts:119-131 — the probe passes on
// non-empty content OR non-empty reasoning_content/reasoning.
function probeEvidence(msg: any): { text: string; reasoning: string; passes: boolean } {
  const raw = msg?.content ?? '';
  const text = contentToString(raw).trim();
  const reasoning = [msg?.reasoning_content, msg?.reasoning]
    .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    .join('\n');
  return { text, reasoning, passes: text.length > 0 || reasoning.length > 0 };
}

function okJson(body: unknown): any {
  return { ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(body) };
}

function errJson(status: number, body: unknown, statusText = 'Error'): any {
  return { ok: false, status, statusText, headers: new Headers(), json: () => Promise.resolve(body) };
}

function chatBody(message: Record<string, unknown>) {
  return {
    id: 'id', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reasoning probe evidence per adapter', () => {
  it('openai-compat: reasoning_content-only payload folds into probe-visible content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(okJson(chatBody({ content: '', reasoning_content: 'the answer via trace' })));
    const p = new OpenAICompatProvider({ platform: 'groq', name: 'T', baseUrl: 'https://x/v1' });
    const res = await p.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    const ev = probeEvidence(res.choices[0].message as any);
    expect(ev.passes).toBe(true);
    expect(ev.text).toBe('the answer via trace');
  });

  it('openai-compat: bare reasoning-only payload folds into probe-visible content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(okJson(chatBody({ content: '', reasoning: 'ollama trace answer' })));
    const p = new OpenAICompatProvider({ platform: 'groq', name: 'T', baseUrl: 'https://x/v1' });
    const res = await p.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    const ev = probeEvidence(res.choices[0].message as any);
    expect(ev.passes).toBe(true);
    expect(ev.text).toBe('ollama trace answer');
  });

  it('google: thought-only parts yield probe-visible reasoning_content (content stays null)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(okJson({
      candidates: [{ content: { parts: [{ text: 'hidden chain of thought', thought: true }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }));
    const p = new GoogleProvider();
    const res = await p.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'gemini-2.5-flash');
    const msg = res.choices[0].message as any;
    expect(msg.content).toBeNull();
    expect(msg.reasoning_content).toBe('hidden chain of thought');
    expect(probeEvidence(msg).passes).toBe(true);
  });

  it('google: mixed thought + text parts keep both channels probe-visible', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(okJson({
      candidates: [{
        content: { parts: [{ text: 'thinking trace', thought: true }, { text: 'ok' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }));
    const p = new GoogleProvider();
    const res = await p.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'gemini-2.5-flash');
    const msg = res.choices[0].message as any;
    expect(msg.content).toBe('ok');
    expect(msg.reasoning_content).toBe('thinking trace');
    expect(probeEvidence(msg).passes).toBe(true);
  });

  it('cloudflare: reasoning-only passthrough stays probe-visible', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(okJson(
      chatBody({ content: '', reasoning_content: 'deepseek distill trace' }),
    ));
    const p = new CloudflareProvider();
    const res = await p.chatCompletion('acc:tok', [{ role: 'user', content: 'hi' }], '@cf/deepseek/r1');
    const ev = probeEvidence(res.choices[0].message as any);
    expect(ev.passes).toBe(true);
    expect(ev.reasoning).toContain('deepseek distill trace');
  });

  it('cloudflare: leading <think> block is extracted to reasoning_content, answer stays in content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(okJson(
      chatBody({ content: '<think>cf trace</think>ok' }),
    ));
    const p = new CloudflareProvider();
    const res = await p.chatCompletion('acc:tok', [{ role: 'user', content: 'hi' }], '@cf/deepseek/r1');
    const msg = res.choices[0].message as any;
    expect(msg.content).toBe('ok');
    expect(msg.reasoning_content).toBe('cf trace');
    expect(probeEvidence(msg).passes).toBe(true);
  });

  it('cohere: reasoning-only passthrough stays probe-visible', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(okJson(
      chatBody({ content: '', reasoning_content: 'cohere thinking trace' }),
    ));
    const p = new CohereProvider();
    const res = await p.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'command-a-03-2025');
    expect(probeEvidence(res.choices[0].message as any).passes).toBe(true);
  });

  it('aihorde: reasoning-only passthrough stays probe-visible', async () => {
    vi.spyOn(global, 'fetch').mockImplementationOnce(async () => okJson(
      chatBody({ content: '', reasoning_content: 'horde worker trace' }),
    ));
    const p = new AIHordeProvider();
    const res = await p.chatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'some-model');
    expect(probeEvidence(res.choices[0].message as any).passes).toBe(true);
  });
});

describe('openai-compat normalizeChoices guards', () => {
  it('tool_calls + null content does NOT fold reasoning into content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(okJson(chatBody({
      content: null,
      reasoning_content: 'thinking about the tool',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
    })));
    const p = new OpenAICompatProvider({ platform: 'groq', name: 'T', baseUrl: 'https://x/v1' });
    const res = await p.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    const msg = res.choices[0].message as any;
    expect(msg.content).toBeNull();
    // reasoning evidence is preserved on the message even though content is untouched
    expect(msg.reasoning_content).toBe('thinking about the tool');
    expect(msg.tool_calls?.[0].function.name).toBe('get_weather');
  });

  it('array content flattens to a probe-visible string', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(okJson(chatBody({
      content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }],
    })));
    const p = new OpenAICompatProvider({ platform: 'groq', name: 'T', baseUrl: 'https://x/v1' });
    const res = await p.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    const msg = res.choices[0].message as any;
    expect(msg.content).toBe('part one part two');
    expect(probeEvidence(msg).passes).toBe(true);
  });
});

describe('provider errors carry numeric .status (401 preserved)', () => {
  it('providerHttpError copies res.status onto the error', () => {
    const res = { status: 401, headers: new Headers() } as unknown as Response;
    const err = providerHttpError(res, 'unauthorized', { error: { message: 'bad key' } });
    expect((err as any).status).toBe(401);
  });

  it('openai-compat preserves 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(errJson(401, { error: { message: 'bad key' } }, 'Unauthorized'));
    const p = new OpenAICompatProvider({ platform: 'groq', name: 'T', baseUrl: 'https://x/v1' });
    const err = await p.chatCompletion('bad', [{ role: 'user', content: 'hi' }], 'm').catch((e) => e);
    expect(err?.status).toBe(401);
  });

  it('google preserves 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(errJson(401, { error: { message: 'bad key' } }, 'Unauthorized'));
    const p = new GoogleProvider();
    const err = await p.chatCompletion('bad', [{ role: 'user', content: 'hi' }], 'gemini-2.5-flash').catch((e) => e);
    expect(err?.status).toBe(401);
  });

  it('cloudflare preserves 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(errJson(401, { error: { message: 'bad key' } }, 'Unauthorized'));
    const p = new CloudflareProvider();
    const err = await p.chatCompletion('acc:tok', [{ role: 'user', content: 'hi' }], '@cf/meta/llama-3.1-70b-instruct').catch((e) => e);
    expect(err?.status).toBe(401);
  });

  it('cohere preserves 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(errJson(401, { error: { message: 'bad key' } }, 'Unauthorized'));
    const p = new CohereProvider();
    const err = await p.chatCompletion('bad', [{ role: 'user', content: 'hi' }], 'command-a-03-2025').catch((e) => e);
    expect(err?.status).toBe(401);
  });

  it('aihorde preserves 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(errJson(401, { detail: 'bad key' }, 'Unauthorized'));
    const p = new AIHordeProvider();
    const err = await p.chatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'm').catch((e) => e);
    expect(err?.status).toBe(401);
  });
});
