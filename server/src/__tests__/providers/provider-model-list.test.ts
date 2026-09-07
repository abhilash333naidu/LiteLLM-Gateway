import { describe, it, expect, vi, afterEach } from 'vitest';
import { BaseProvider } from '../../providers/base.js';
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
