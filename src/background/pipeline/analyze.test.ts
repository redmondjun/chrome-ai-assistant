import { analyzeWithReasoning, classifyLinks, fetchLinkContent } from './analyze';
import { fetchLinkContentInTab } from '../content/link-tab-fetcher';
import type { TabContent } from '@/shared/types';

jest.mock('../content/link-tab-fetcher', () => ({
  fetchLinkContentInTab: jest.fn(),
}));

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
    onLinkDecision: jest.fn(),
    onDone: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('analyzeWithReasoning', () => {
    it('uses the AI-first decision instead of requiring the word "link"', async () => {
      mockRouter.complete
        .mockResolvedValueOnce({ text: 'yes' })
        .mockResolvedValueOnce({ text: '[0.9, 0.1]' });
      mockRouter.streamComplete.mockImplementation(async function* () {
        yield { chunk: 'Answer', usedLocal: true };
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: async () => '<html><body><article>Pull request details</article></body></html>',
        headers: { get: () => 'text/html' },
      });

      await analyzeWithReasoning(
        mockRouter as any,
        mockContent,
        'Summarize the pull request evidence',
        mockSettings,
        mockCallbacks
      );

      expect(mockCallbacks.onLinkVisit).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://example.com/link1', status: 'success' })
      );
      expect(mockCallbacks.onReasoning).toHaveBeenCalledWith(
        expect.objectContaining({ thought: expect.stringContaining('Opening depth 1 source 1') })
      );
      expect(mockCallbacks.onReasoning).toHaveBeenCalledWith(
        expect.objectContaining({ thought: expect.stringContaining('Read Link 1') })
      );
    });

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
      const consoleInfo = jest.spyOn(console, 'info').mockImplementation(() => undefined);
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
        'Visit the links',
        mockSettings,
        mockCallbacks
      );

      expect(mockCallbacks.onLinkVisit).not.toHaveBeenCalled();
      expect(consoleInfo).toHaveBeenCalledWith(
        '[research]',
        'link-decision',
        expect.objectContaining({
          outcome: 'discarded',
          reason: 'blocked-domain',
          url: 'https://facebook.com/page',
        })
      );
      consoleInfo.mockRestore();
    });

    it('logs links rejected by relevance scoring', async () => {
      const consoleInfo = jest.spyOn(console, 'info').mockImplementation(() => undefined);
      mockRouter.complete.mockResolvedValue({ text: '[0.1, 0.9]' });
      mockRouter.streamComplete.mockImplementation(async function* () {
        yield { chunk: 'Answer', usedLocal: false };
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: async () => '<html><body><article>Relevant evidence</article></body></html>',
      });

      await analyzeWithReasoning(
        mockRouter as any,
        mockContent,
        'Visit the sources',
        { ...mockSettings, links: { ...mockSettings.links, rateLimitMs: 0 } },
        mockCallbacks
      );

      expect(consoleInfo).toHaveBeenCalledWith(
        '[research]',
        'link-decision',
        expect.objectContaining({
          outcome: 'discarded',
          reason: 'below-relevance-threshold',
          score: 0.1,
          url: 'https://example.com/link1',
        })
      );
      expect(mockCallbacks.onLinkDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'discarded',
          reason: 'below-relevance-threshold',
          score: 0.1,
          url: 'https://example.com/link1',
        })
      );
      consoleInfo.mockRestore();
    });

    it('rejects readable error pages instead of using them as evidence', async () => {
      mockRouter.complete.mockResolvedValue({ text: '[0.9]' });
      mockRouter.streamComplete.mockImplementation(async function* () {
        yield { chunk: 'Answer', usedLocal: false };
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          "<html><body><article>Page Not Found. We can't find that page.</article></body></html>",
      });

      await analyzeWithReasoning(
        mockRouter as any,
        { ...mockContent, links: [mockContent.links[0]] },
        'Visit the links',
        { ...mockSettings, links: { ...mockSettings.links, rateLimitMs: 0 } },
        mockCallbacks
      );

      expect(mockCallbacks.onLinkVisit).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          error: 'The source returned a page-not-found response.',
        })
      );
      expect(mockCallbacks.onLinkDecision).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'discarded', reason: 'invalid-page-content' })
      );
    });

    it('answers link-visit status from recorded results without repeating a summary', async () => {
      const history = [
        {
          id: 'assistant-1',
          role: 'assistant' as const,
          content: 'Previous long summary',
          timestamp: 1,
          linkVisits: [
            {
              url: 'https://example.com/pr/1',
              title: 'PR 1',
              status: 'failed' as const,
              relevanceScore: 0.9,
              timestamp: 1,
              error: 'Authentication required',
            },
          ],
        },
      ];

      await analyzeWithReasoning(
        mockRouter as any,
        mockContent,
        'Did you visit all the links?',
        mockSettings,
        mockCallbacks,
        history
      );

      expect(mockCallbacks.onChunk).toHaveBeenCalledWith(
        expect.stringContaining('0 of 1 links were retrieved successfully')
      );
      expect(mockRouter.streamComplete).not.toHaveBeenCalled();
    });

    it('follows relevant child links up to the configured depth', async () => {
      mockRouter.complete.mockResolvedValue({ text: '[0.9]' });
      mockRouter.streamComplete.mockImplementation(async function* () {
        yield { chunk: 'Answer using nested evidence', usedLocal: false };
      });
      global.fetch = jest.fn().mockRejectedValue(new Error('Worker fetch blocked'));
      (fetchLinkContentInTab as jest.Mock)
        .mockResolvedValueOnce({
          content: 'Parent source evidence',
          links: [
            {
              url: 'https://example.com/browse/child-evidence',
              text: 'Detailed child evidence',
              isExternal: false,
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'Nested source evidence', links: [] });

      await analyzeWithReasoning(
        mockRouter as any,
        { ...mockContent, links: [mockContent.links[0]] },
        'Visit the sources and investigate the evidence',
        {
          ...mockSettings,
          links: { ...mockSettings.links, maxDepth: 2, maxPages: 2, rateLimitMs: 0 },
        },
        mockCallbacks
      );

      expect(fetchLinkContentInTab).toHaveBeenCalledTimes(2);
      expect(mockCallbacks.onLinkVisit).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.com/browse/child-evidence',
          status: 'success',
        })
      );
      expect(mockCallbacks.onReasoning).toHaveBeenCalledWith(
        expect.objectContaining({ thought: expect.stringContaining('2 depth levels') })
      );
    });

    it('visits every selected first-depth source before discovered child links', async () => {
      mockRouter.complete
        .mockResolvedValueOnce({ text: '[0.9, 0.8]' })
        .mockResolvedValueOnce({ text: '[0.9]' });
      mockRouter.streamComplete.mockImplementation(async function* () {
        yield { chunk: 'Answer using first-depth evidence', usedLocal: false };
      });
      global.fetch = jest.fn().mockRejectedValue(new Error('Worker fetch blocked'));
      (fetchLinkContentInTab as jest.Mock)
        .mockResolvedValueOnce({
          content: 'First root source',
          links: [
            {
              url: 'https://example.com/browse/child-evidence',
              text: 'Detailed child evidence',
              isExternal: false,
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'Second root source', links: [] });

      await analyzeWithReasoning(
        mockRouter as any,
        mockContent,
        'Visit the sources and investigate the evidence',
        {
          ...mockSettings,
          links: { ...mockSettings.links, maxDepth: 2, maxPages: 2, rateLimitMs: 0 },
        },
        mockCallbacks
      );

      expect((fetchLinkContentInTab as jest.Mock).mock.calls.map(([url]) => url)).toEqual([
        'https://example.com/link1',
        'https://example.com/link2',
      ]);
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
      const onProgress = jest.fn();
      const mockRouter = {
        complete: jest.fn().mockRejectedValue(new Error('API error')),
      };

      const links = [
        { url: 'https://example.com/pricing', text: 'Pricing', isExternal: false },
        { url: 'https://example.com/about', text: 'About', isExternal: false },
      ];

      const scores = await classifyLinks(
        mockRouter as any,
        links,
        'pricing',
        undefined,
        onProgress
      );
      expect(scores[0]).toBeGreaterThan(scores[1]);
      expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('API error'));
    });

    it('warns when scoring is slow before eventually falling back', async () => {
      jest.useFakeTimers();
      try {
        const onProgress = jest.fn();
        const mockRouter = { complete: jest.fn(() => new Promise(() => undefined)) };
        const links = [{ url: 'https://example.com/pricing', text: 'Pricing', isExternal: false }];

        const scoresPromise = classifyLinks(
          mockRouter as any,
          links,
          'pricing',
          undefined,
          onProgress
        );
        await jest.advanceTimersByTimeAsync(15000);
        expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('still running'));

        await jest.advanceTimersByTimeAsync(45000);

        await expect(scoresPromise).resolves.toEqual([0.9]);
        expect(onProgress).toHaveBeenCalledWith(
          expect.stringContaining('timed out after 60 seconds')
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('scores large link sets in visible batches', async () => {
      const onProgress = jest.fn();
      const mockRouter = {
        complete: jest
          .fn()
          .mockResolvedValueOnce({ text: `[${Array(10).fill(0.8).join(',')}]` })
          .mockResolvedValueOnce({ text: `[${Array(10).fill(0.7).join(',')}]` })
          .mockResolvedValueOnce({ text: `[${Array(5).fill(0.6).join(',')}]` }),
      };
      const links = Array.from({ length: 25 }, (_, index) => ({
        url: `https://example.com/${index + 1}`,
        text: `Link ${index + 1}`,
        isExternal: false,
      }));

      const scores = await classifyLinks(
        mockRouter as any,
        links,
        'supporting evidence',
        undefined,
        onProgress
      );

      expect(mockRouter.complete).toHaveBeenCalledTimes(3);
      expect(scores).toHaveLength(25);
      expect(onProgress).toHaveBeenCalledWith('Scoring links 1-10 of 25...');
      expect(onProgress).toHaveBeenCalledWith('Finished scoring links 21-25 of 25.');
    });

    it('keeps uniform model scores when every source may be relevant', async () => {
      const mockRouter = {
        complete: jest.fn().mockResolvedValue({ text: '[0.9, 0.9]' }),
      };
      const links = [
        {
          url: 'https://stash.example.com/projects/APP/repos/app/pull-requests/1',
          text: 'PR 1',
          isExternal: true,
        },
        { url: 'https://wiki.example.com/browsepeople.action', text: 'People', isExternal: true },
      ];

      const scores = await classifyLinks(mockRouter as any, links, 'review supporting sources');

      expect(scores).toEqual([0.9, 0.9]);
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
