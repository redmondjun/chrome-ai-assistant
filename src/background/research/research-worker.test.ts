import {
  finalizeResearchSubjectWithoutModel,
  scanResearchSeedWithoutModel,
} from './research-worker';
import { DEFAULT_SETTINGS } from '../storage/settings';
import type { ResearchEvidence, ResearchTask } from '@/shared/types';

describe('batched research workers', () => {
  it('selects and reads supporting PR and documentation links without per-ticket model calls', async () => {
    const task = createTask();
    const evidence: ResearchEvidence[] = [];
    const retrieveSource = jest.fn(async (_task, source) => {
      const item: ResearchEvidence = {
        url: source.url,
        title: source.title,
        category: source.url.includes('pull-requests') ? 'code-review' : 'ticket',
        excerpt:
          source.depth === 0
            ? `${'Ticket overview '.repeat(200)}\nJun Lee comment: implemented and validated the migration.`
            : 'Jun Lee authored and merged the supporting pull request.',
        depth: source.depth,
      };
      evidence.push(item);
      return {
        evidence: item,
        links:
          source.depth === 0
            ? [
                {
                  url: 'https://stash.example.com/projects/P/repos/app/pull-requests/42/overview',
                  text: 'Implementation pull request',
                  isExternal: true,
                },
              ]
            : [],
        cacheHit: false,
      };
    });
    const options = {
      router: { complete: jest.fn() },
      task,
      question: 'Document Jun Lee contribution',
      settings: DEFAULT_SETTINGS,
      retrieveSource,
      getEvidence: () => evidence,
      checkpoint: jest.fn().mockResolvedValue(undefined),
      signal: new AbortController().signal,
    };

    await scanResearchSeedWithoutModel(options);
    expect(task.pendingSources).toEqual([
      expect.objectContaining({
        url: 'https://stash.example.com/projects/P/repos/app/pull-requests/42/overview',
      }),
    ]);

    await finalizeResearchSubjectWithoutModel(options, [
      {
        taskId: task.id,
        source: { ...task.pendingSources[0], score: task.pendingSources[0].score || 0 },
        priority: 1,
        status: 'planned',
      },
    ]);

    expect(retrieveSource).toHaveBeenCalledTimes(2);
    expect(task.report).toContain('Jun Lee comment: implemented and validated the migration.');
    expect(task.report).toContain('authored and merged the supporting pull request');
  });
});

function createTask(): ResearchTask {
  return {
    id: 'SQ-1',
    label: 'SQ-1',
    sourceUrl: 'https://jira.example.com/browse/SQ-1',
    title: 'SQ-1',
    status: 'queued',
    phase: 'queued',
    phaseStartedAt: 1,
    lastActivityAt: 1,
    reasoning: [],
    linkVisits: [],
    relatedSourcesRead: 0,
    relatedSourcesAttempted: 0,
    evidence: [],
    decisions: [],
    pendingSources: [],
    visitedUrls: [],
  };
}
