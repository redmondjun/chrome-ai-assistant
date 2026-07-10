import { analyzeWithReasoning, classifyLinks, fetchLinkContent } from './analyze';
import type { TabContent } from '@/shared/types';

describe('Analysis Pipeline', () => {
  const mockRouter = {
    complete: jest.fn(),
    streamComplete: jest.fn(),
  };

  const mockContent: TabContent = {
    url: 'https://example.com',
    title: 'Test Page',
    text: 'This is the main page content with some information.',
    links: [
      { url: 'https://example.com/link1', text: 'Link 1', isExternal: false, context: 'context 1' },
      { url: 'https://example.com/link2', text: 'Link 2', isExternal: true, context: 'context 2' },
    ],
    meta: {},
    timestamp: Date.now(),
  };

  const mockSettings = {
    model: {
      autoRoute: true,
      useLocal: true,
      forceCloudFor: ['generate code'],
    },
    links: {
      enabled: true,
      mode: 'ai-first',
      maxDepth: 2,
      maxPages: 10,
      rateLimitMs: 500,
      requireConfirmation: false,
      allowedDomains: [],
      blockedDomains: ['facebook.com'],
    },
  };

  const mockCallbacks = {
    onChunk: jest.fn(),
    onReasoning: jest.fn(),
    onLinkVisit: jest.fn(),
    onDone: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('analyzeWithReasoning', () => {
    it('emits reasoning steps', async () => {
      mockRouter.streamComplete.mockImplementation(async function* () {
        yield { chunk: 'Test answer', usedLocal: false };
      });

      await analyzeWithReasoning(
        mockRouter as any,
        mockContent,
        'What is this?',
        mockSettings,
        mockCallbacks
      );

      expect(mockCallbacks.onReasoning).toHaveBeenCalledTimes(3);
      expect(mockCallbacks.onReasoning).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'classify',
          thought: expect.stringContaining('Analyzing question'),
        })
      );
      expect(mockCallbacks.onReasoning).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'answer',
          thought: expect.stringContaining('Answer generated'),
        })
      );
    });

    it('classifies and fetches relevant links', async () => {
      mockRouter.complete.mockResolvedValue({ text: '[0.9, 0.1]' });
      mockRouter.streamComplete.mockImplementation(async function* () {
        yield { chunk: 'Answer', usedLocal: true };
      });

      // Mock fetch
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        text: async () => '<html><body><article>Linked page content</article></body></html>',
      });

      await analyzeWithReasoning(
        mockRouter as any,
        mockContent,
        'follow links',
        mockSettings,
        mockCallbacks
      );

      expect(mockCallbacks.onLinkVisit).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.com/link1',
          status: 'fetching',
        })
      );
      expect(mockCallbacks.onLinkVisit).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.com/link1',
          status: 'success',
        })
      );
    });

    it('skips link following when disabled', async () => {
      mockRouter.streamComplete.mockImplementation(async function* () {
        yield { chunk: 'Answer', usedLocal: false };
      });

      const settingsNoLinks = {
        ...mockSettings,
        links: { ...mockSettings.links, enabled: false },
      };

      await analyzeWithReasoning(
        mockRouter as any,
        mockContent,
        'question',
        settingsNoLinks,
        mockCallbacks
      );

      expect(mockCallbacks.onReasoning).toHaveBeenCalledWith(
        expect.objectContaining({
          thought: expect.stringContaining('does not require following links'),
        })
      );
      // Should not call onLinkVisit
      expect(mockCallbacks.onLinkVisit).not.toHaveBeenCalled();
    });

    it('filters out blocked domains', async () => {
      mockRouter.complete.mockResolvedValue({ text: '[0.9]' });
      mockRouter.streamComplete.mockImplementation(async function* () {
        yield { chunk: 'Answer', usedLocal: true };
      });

      const contentWithBlocked: TabContent = {
        ...mockContent,
        links: [
          { url: 'https://facebook.com/page', text: 'Facebook', isExternal: true, context: '' },
        ],
      };

      await analyzeWithReasoning(
        mockRouter as any,
        contentWithBlocked,
        'question',
        mockSettings,
        mockCallbacks
      );

      expect(mockCallbacks.onLinkVisit).not.toHaveBeenCalled();
    });
  });

  describe('classifyLinks', () => {
    it('returns scores for each link', async () => {
      const mockRouter = {
        complete: jest.fn().mockResolvedValue({ text: '[0.8, 0.2, 0.5]' }),
      };

      const links = [
        { url: 'https://example.com/1', text: 'Link 1', isExternal: false },
        { url: 'https://example.com/2', text: 'Link 2', isExternal: true },
        { url: 'https://example.com/3', text: 'Link 3', isExternal: false },
      ];

      const scores = await classifyLinks(mockRouter as any, links, 'test question');
      expect(scores).toEqual([0.8, 0.2, 0.5]);
    });

    it('returns empty array for no links', async () => {
      const mockRouter = { complete: jest.fn() };
      const scores = await classifyLinks(mockRouter as any, [], 'question');
      expect(scores).toEqual([]);
    });

    it('falls back to keyword matching on error', async () => {
      const mockRouter = {
        complete: jest.fn().mockRejectedValue(new Error('API error')),
      };

      const links = [
        { url: 'https://example.com/pricing', text: 'Pricing', isExternal: false },
        { url: 'https://example.com/about', text: 'About', isExternal: false },
      ];

      const scores = await classifyLinks(mockRouter as any, links, 'pricing');
      expect(scores[0]).toBeGreaterThan(scores[1]);
    });
  });

  describe('fetchLinkContent', () => {
    beforeEach(() => {
      jest.resetModules();
    });

    it('fetches and extracts content', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: async () => '<html><body><article>Extracted content</article></body></html>',
      });

      const content = await fetchLinkContent('https://example.com/page');
      expect(content).toBe('Extracted content');
    });

    it('handles non-HTML responses', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: async () => 'not html',
      });

      const content = await fetchLinkContent('https://example.com/api');
      expect(content).toBeNull();
    });

    it('handles fetch errors', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      const content = await fetchLinkContent('https://example.com/page');
      expect(content).toBeNull();
    });

    it('handles timeout', async () => {
      global.fetch = jest
        .fn()
        .mockImplementation(
          () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 100))
        );

      const content = await fetchLinkContent('https://example.com/page');
      expect(content).toBeNull();
    });
  });
});
