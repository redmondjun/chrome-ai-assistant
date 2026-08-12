import { deriveResearchProgress } from './progress';
import { createSourceRegistry } from './source-registry';
import type { ResearchJob, ResearchSourceRecord, ResearchTask } from '@/shared/types';

jest.mock('./storage', () => ({ saveResearchJob: jest.fn() }));

describe('cross-job source reuse', () => {
  it('materializes successful prior evidence without consuming the new-source budget', async () => {
    const task = createTask();
    const job = createJob(task);
    const reusable = createSource('https://example.com/ticket/1');
    const retrieve = createSourceRegistry({
      job,
      budget: 1,
      signal: new AbortController().signal,
      checkpoint: jest.fn().mockResolvedValue(undefined),
      reusableSources: [{ source: reusable, jobId: 'prior-job' }],
    });

    const result = await retrieve(task, {
      url: 'https://example.com/ticket/1#details',
      title: 'Ticket 1',
      depth: 0,
    });
    deriveResearchProgress(job);

    expect(result.cacheHit).toBe(true);
    expect(job.sourceRegistry?.[0]).toEqual(
      expect.objectContaining({ reusedFromJobId: 'prior-job', cacheHits: 1 })
    );
    expect(job.progress.sourceBudgetUsed).toBe(0);
    expect(task.sourceKeys).toEqual(['https://example.com/ticket/1']);
  });

  it('does not reuse failed prior sources', async () => {
    const task = createTask();
    const job = createJob(task);
    const failed: ResearchSourceRecord = {
      ...createSource(task.sourceUrl),
      status: 'failed',
      evidence: undefined,
    };
    const retrieve = createSourceRegistry({
      job,
      budget: 0,
      signal: new AbortController().signal,
      checkpoint: jest.fn().mockResolvedValue(undefined),
      reusableSources: [{ source: failed, jobId: 'failed-job' }],
    });

    const result = await retrieve(task, { url: task.sourceUrl, title: task.title, depth: 0 });

    expect(result.failureReason).toBe('source-budget-exhausted');
    expect(job.sourceRegistry).toEqual([]);
  });
});

function createSource(url: string): ResearchSourceRecord {
  return {
    key: url,
    url,
    title: 'Ticket 1',
    status: 'success',
    taskIds: [],
    evidence: { url, title: 'Ticket 1', category: 'ticket', excerpt: 'Evidence', depth: 0 },
    retries: 0,
    cacheHits: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createJob(task: ResearchTask): ResearchJob {
  return {
    id: 'new-job',
    messageId: 'message',
    question: 'Research tickets',
    status: 'running',
    tasks: [task],
    sourceRegistry: [],
    sourceBudget: 1,
    progress: {
      jobId: 'new-job',
      status: 'running',
      activity: 'Running',
      totalTasks: 1,
      completedTasks: 0,
      failedTasks: 0,
      activeWorkers: 0,
      sourcesRead: 0,
      sourcesFailed: 0,
      updatedAt: 1,
      activeTaskIds: [],
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function createTask(): ResearchTask {
  return {
    id: 'ticket-1',
    label: 'Ticket 1',
    sourceUrl: 'https://example.com/ticket/1',
    title: 'Ticket 1',
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
