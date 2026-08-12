import { ModelRouter } from '../api/router';
// Mock the local client
jest.mock('../api/local-client', () => ({
  completeLocal: jest.fn(),
  streamLocal: jest.fn(),
  isLocalModelReady: jest.fn(),
  initializeLocalModel: jest.fn(),
  getLocalModelStatus: jest.fn(),
}));

describe('ModelRouter', () => {
  let router: ModelRouter;
  const mockSettings = {
    cloudModel: 'nemotron-3-nano' as const,
    customEndpoint: undefined,
    apiKey: 'test-key',
    useLocal: true,
    autoRoute: true,
    forceCloudFor: ['generate code', 'write document'],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    router = new ModelRouter(mockSettings);
  });

  describe('shouldUseLocal', () => {
    it('returns false when local is disabled', () => {
      const routerNoLocal = new ModelRouter({ ...mockSettings, useLocal: false });
      expect(
        routerNoLocal.shouldUseLocal('simple question', { hasLinks: false, contentLength: 1000 })
      ).toBe(false);
    });

    it('returns false when local model not ready', () => {
      require('../api/local-client').isLocalModelReady.mockReturnValue(false);
      expect(
        router.shouldUseLocal('simple question', { hasLinks: false, contentLength: 1000 })
      ).toBe(false);
    });

    it('returns false when autoRoute is disabled', () => {
      const routerNoAuto = new ModelRouter({ ...mockSettings, autoRoute: false });
      expect(
        routerNoAuto.shouldUseLocal('simple question', { hasLinks: false, contentLength: 1000 })
      ).toBe(false);
    });

    it('returns false for force cloud keywords', () => {
      expect(
        router.shouldUseLocal('generate code for me', { hasLinks: false, contentLength: 1000 })
      ).toBe(false);
      expect(
        router.shouldUseLocal('write document about AI', { hasLinks: false, contentLength: 1000 })
      ).toBe(false);
    });

    it('returns true for simple tasks', () => {
      require('../api/local-client').isLocalModelReady.mockReturnValue(true);
      expect(
        router.shouldUseLocal('what is this page about', { hasLinks: false, contentLength: 1000 })
      ).toBe(true);
      expect(
        router.shouldUseLocal('summarize this page', { hasLinks: false, contentLength: 1000 })
      ).toBe(true);
    });

    it('returns true for short content', () => {
      require('../api/local-client').isLocalModelReady.mockReturnValue(true);
      expect(router.shouldUseLocal('analyze this', { hasLinks: false, contentLength: 1000 })).toBe(
        true
      );
    });

    it('returns true for link classification', () => {
      require('../api/local-client').isLocalModelReady.mockReturnValue(true);
      expect(
        router.shouldUseLocal('which link is relevant', { hasLinks: true, contentLength: 1000 })
      ).toBe(true);
    });

    it('returns false for long questions', () => {
      require('../api/local-client').isLocalModelReady.mockReturnValue(true);
      const longQuestion = 'a'.repeat(250);
      expect(router.shouldUseLocal(longQuestion, { hasLinks: false, contentLength: 1000 })).toBe(
        false
      );
    });
  });

  describe('complete', () => {
    it('uses local when routed to local', async () => {
      require('../api/local-client').isLocalModelReady.mockReturnValue(true);
      require('../api/local-client').completeLocal.mockResolvedValue('Local response');

      const result = await router.complete(
        'simple task',
        { hasLinks: false, contentLength: 100 },
        'prompt'
      );

      expect(result.text).toBe('Local response');
      expect(result.modelUsed).toBe('local');
    });

    it('falls back to cloud on local failure', async () => {
      require('../api/local-client').isLocalModelReady.mockReturnValue(true);
      require('../api/local-client').completeLocal.mockRejectedValue(new Error('Local failed'));

      // Mock NIMClient
      const { NIMClient } = require('../api/nim-client');
      NIMClient.prototype.chatCompletion = jest.fn().mockResolvedValue('Cloud response');

      const result = await router.complete(
        'complex task',
        { hasLinks: false, contentLength: 10000 },
        'prompt'
      );

      expect(result.text).toBe('Cloud response');
      expect(result.modelUsed).toBe('cloud');
    });

    it('never falls back to cloud in local-only mode', async () => {
      require('../api/local-client').isLocalModelReady.mockReturnValue(true);
      require('../api/local-client').completeLocal.mockRejectedValue(new Error('Local failed'));
      const { NIMClient } = require('../api/nim-client');
      const cloudCompletion = jest.fn();
      NIMClient.prototype.chatCompletion = cloudCompletion;
      const localOnlyRouter = new ModelRouter(mockSettings, true);

      await expect(
        localOnlyRouter.complete(
          'create report',
          { hasLinks: true, contentLength: 10000 },
          'prompt'
        )
      ).rejects.toThrow('local-only mode');
      expect(cloudCompletion).not.toHaveBeenCalled();
    });
  });

  describe('streamComplete', () => {
    it('streams from local', async () => {
      require('../api/local-client').isLocalModelReady.mockReturnValue(true);
      require('../api/local-client').streamLocal.mockImplementation(async function* () {
        yield { chunk: 'Hello ' };
        yield { chunk: 'world' };
      });

      const chunks: string[] = [];
      for await (const { chunk } of router.streamComplete(
        'simple',
        { hasLinks: false, contentLength: 100 },
        'prompt'
      )) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(['Hello ', 'world']);
    });

    it('retries an empty Ultra response with GLM 5.2 without changing settings', async () => {
      require('../api/local-client').isLocalModelReady.mockReturnValue(false);
      const { NIMClient } = require('../api/nim-client');
      const cloudStream = jest
        .fn()
        .mockImplementationOnce(async function* () {})
        .mockImplementationOnce(async function* () {
          yield 'Recovered answer';
        });
      NIMClient.prototype.streamChatCompletion = cloudStream;
      const ultraRouter = new ModelRouter({
        ...mockSettings,
        cloudModel: 'nemotron-3-ultra',
        useLocal: false,
      });

      const chunks: string[] = [];
      for await (const { chunk } of ultraRouter.streamComplete(
        'continue',
        { hasLinks: true, contentLength: 1000 },
        'prompt'
      )) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(['Recovered answer']);
      expect(cloudStream.mock.calls.map(call => call[0].model)).toEqual([
        'nemotron-3-ultra',
        'glm-5.2',
      ]);
    });

    it('suppresses literal tool markup and retries with GLM 5.2', async () => {
      require('../api/local-client').isLocalModelReady.mockReturnValue(false);
      const { NIMClient } = require('../api/nim-client');
      NIMClient.prototype.streamChatCompletion = jest
        .fn()
        .mockImplementationOnce(async function* () {
          yield 'I will visit it.\n\n<tool_call>FUNCTIONS.visit_url:';
        })
        .mockImplementationOnce(async function* () {
          yield 'Answer from saved evidence';
        });
      const ultraRouter = new ModelRouter({
        ...mockSettings,
        cloudModel: 'nemotron-3-ultra',
        useLocal: false,
      });

      const chunks: string[] = [];
      for await (const { chunk } of ultraRouter.streamComplete(
        'continue',
        { hasLinks: true, contentLength: 1000 },
        'prompt'
      )) {
        chunks.push(chunk);
      }

      expect(chunks.join('')).toBe('Answer from saved evidence');
      expect(chunks.join('')).not.toContain('tool_call');
    });

    it('throws when both the configured model and GLM return empty responses', async () => {
      require('../api/local-client').isLocalModelReady.mockReturnValue(false);
      const { NIMClient } = require('../api/nim-client');
      NIMClient.prototype.streamChatCompletion = jest
        .fn()
        .mockImplementation(async function* () {});
      const ultraRouter = new ModelRouter({
        ...mockSettings,
        cloudModel: 'nemotron-3-ultra',
        useLocal: false,
      });

      const consume = async () => {
        const stream = ultraRouter.streamComplete(
          'continue',
          { hasLinks: true, contentLength: 1000 },
          'prompt'
        );
        while (!(await stream.next()).done) {
          // Consume every streamed item.
        }
      };

      await expect(consume()).rejects.toThrow('model returned no answer');
    });
  });

  describe('updateSettings', () => {
    it('updates NIM client config', () => {
      const { NIMClient } = require('../api/nim-client');
      const mockSetApiKey = jest.fn();
      const mockSetBaseUrl = jest.fn();
      NIMClient.prototype.setApiKey = mockSetApiKey;
      NIMClient.prototype.setBaseUrl = mockSetBaseUrl;

      const router = new ModelRouter(mockSettings);
      router.updateSettings({
        ...mockSettings,
        apiKey: 'new-key',
        customEndpoint: 'https://custom.example.com',
      });

      expect(mockSetApiKey).toHaveBeenCalledWith('new-key');
      expect(mockSetBaseUrl).toHaveBeenCalledWith('https://custom.example.com');
    });
  });

  describe('ensureLocalReady', () => {
    it('initializes local model when useLocal is true', async () => {
      require('../api/local-client').initializeLocalModel.mockResolvedValue(true);

      const result = await router.ensureLocalReady();

      expect(result).toBe(true);
      expect(require('../api/local-client').initializeLocalModel).toHaveBeenCalled();
    });

    it('returns false when useLocal is false', async () => {
      const routerNoLocal = new ModelRouter({ ...mockSettings, useLocal: false });
      const result = await routerNoLocal.ensureLocalReady();
      expect(result).toBe(false);
    });
  });
});
