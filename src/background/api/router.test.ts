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
