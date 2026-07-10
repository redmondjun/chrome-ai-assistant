import { NIMClient } from '../api/nim-client';

describe('NIMClient', () => {
  let client: NIMClient;
  const mockApiKey = 'test-api-key';
  const mockBaseUrl = 'https://api.test.com/v1';

  beforeEach(() => {
    client = new NIMClient(mockApiKey, mockBaseUrl);
    jest.clearAllMocks();
  });

  describe('chatCompletion', () => {
    it('uses the NVIDIA endpoint when the custom endpoint is blank', async () => {
      const defaultClient = new NIMClient(mockApiKey, '');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      });

      await defaultClient.chatCompletion({
        model: 'nemotron-3-nano',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(fetch).toHaveBeenCalledWith(
        'https://integrate.api.nvidia.com/v1/chat/completions',
        expect.any(Object)
      );
    });

    it('sends correct request', async () => {
      const mockResponse = {
        id: 'test-id',
        object: 'chat.completion',
        created: Date.now(),
        model: 'nvidia/nemotron-3-nano-30b-a3b',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Test response' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.chatCompletion({
        model: 'nemotron-3-nano',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      });

      expect(result).toBe('Test response');
      expect(fetch).toHaveBeenCalledWith(
        'https://api.test.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-api-key',
          }),
          body: expect.stringContaining('Hello'),
        })
      );
    });

    it('maps model names correctly', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
        }),
      });

      await client.chatCompletion({
        model: 'nemotron-3-nano',
        messages: [],
      });

      const call = (fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.model).toBe('nvidia/nemotron-3-nano-30b-a3b');
    });

    it('handles API errors', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => JSON.stringify({ detail: 'Invalid API key' }),
      });

      await expect(
        client.chatCompletion({
          model: 'nemotron-3-nano',
          messages: [],
        })
      ).rejects.toThrow('NIM API error (401 Unauthorized): Invalid API key');
    });

    it('handles network errors', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      await expect(
        client.chatCompletion({
          model: 'nemotron-3-nano',
          messages: [],
        })
      ).rejects.toThrow('Network error');
    });
  });

  describe('streamChatCompletion', () => {
    it('streams chunks correctly', async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('');

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: jest
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(chunks.slice(0, 50)),
              })
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(chunks.slice(50, 100)),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            releaseLock: jest.fn(),
          }),
        },
      });

      const results: any[] = [];
      for await (const chunk of client.streamChatCompletion({
        model: 'nemotron-3-nano',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      })) {
        results.push(chunk);
      }

      expect(results.length).toBeGreaterThan(0);
    });

    it('handles stream errors', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: async () => JSON.stringify({ error: { message: 'Rate limited' } }),
      });

      const generator = client.streamChatCompletion({
        model: 'nemotron-3-nano',
        messages: [],
        stream: true,
      });

      await expect(generator.next()).rejects.toThrow(
        'NIM API error (429 Too Many Requests): Rate limited'
      );
    });
  });

  describe('testConnection', () => {
    it('returns true on success', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      });

      const result = await client.testConnection('nemotron-3-nano');
      expect(result).toBe(true);
    });

    it('returns false on failure', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Connection failed'));

      const result = await client.testConnection();
      expect(result).toBe(false);
    });
  });

  describe('model mapping', () => {
    it('maps known models', () => {
      expect(client.getModelId('nemotron-3-nano')).toBe('nvidia/nemotron-3-nano-30b-a3b');
      expect(client.getModelId('nemotron-3-super')).toBe('nvidia/nemotron-3-super-120b-a12b');
      expect(client.getModelId('nemotron-3-ultra')).toBe('nvidia/nemotron-3-ultra-550b-a55b');
    });

    it('passes through unknown models', () => {
      expect(client.getModelId('custom-model')).toBe('custom-model');
    });
  });

  describe('config updates', () => {
    it('updates API key', () => {
      client.setApiKey('new-key');
      expect(() => client.setApiKey('new-key')).not.toThrow();
    });

    it('updates base URL', () => {
      client.setBaseUrl('https://new.api.com/v1');
      expect(() => client.setBaseUrl('https://new.api.com/v1')).not.toThrow();
    });
  });
});
