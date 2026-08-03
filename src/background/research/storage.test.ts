jest.mock('idb', () => ({
  openDB: jest.fn().mockResolvedValue({
    put: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(undefined),
    getAllFromIndex: jest.fn().mockResolvedValue([]),
  }),
}));

import { openDB } from 'idb';
import { normalizeResearchJob, saveResearchJob } from './storage';
import type { ResearchJob, ResearchTask } from '@/shared/types';

describe('research job migration', () => {
  it('reconstructs a deduplicated source registry and resets abandoned fetches', () => {
    const first = legacyTask('first', 'success');
    const second = legacyTask('second', 'success');
    second.sourceUrl = 'https://example.com/second';
    second.linkVisits[0].url = first.sourceUrl;
    const abandoned = legacyTask('abandoned', 'fetching');
    const job = legacyJob([first, second, abandoned]);

    const migrated = normalizeResearchJob(job);

    expect(migrated.sourceRegistry).toHaveLength(2);
    expect(
      migrated.sourceRegistry?.find(source => source.url === first.sourceUrl)?.taskIds
    ).toEqual(['first', 'second']);
    expect(
      migrated.sourceRegistry?.find(source => source.url === abandoned.sourceUrl)?.status
    ).toBe('pending');
    expect(migrated.progress.sourcesRead).toBe(1);
    expect(migrated.progress.uniqueSourcesSucceeded).toBe(1);
    expect(migrated.progress.sourceBudgetTotal).toBe(1000);
  });

  it('preserves legacy sources above the budget while reporting and freezing the overflow', () => {
    const job = legacyJob([legacyTask('first', 'success'), legacyTask('second', 'success')]);
    job.sourceBudget = 1;

    const migrated = normalizeResearchJob(job);

    expect(migrated.sourceRegistry).toHaveLength(2);
    expect(migrated.sourceBudgetOverflow).toBe(1);
    expect(migrated.progress.sourceBudgetUsed).toBe(1);
    expect(migrated.progress.sourceBudgetTotal).toBe(1);
    expect(migrated.progress.sourceBudgetOverflow).toBe(1);
  });

  it('invalidates migrated reports that used inaccessible page content', () => {
    const task = legacyTask('restricted', 'success');
    task.evidence = [
      {
        url: task.sourceUrl,
        title: 'Restricted',
        category: 'other',
        excerpt: 'You do not have permission to view this page.',
        depth: 0,
      },
    ];
    const job = legacyJob([task]);
    job.status = 'completed';
    job.finalAnswer = 'Answer generated from inaccessible content';
    job.batchSummaries = [
      {
        batchIndex: 0,
        kind: 'final',
        taskIds: [task.id],
        summary: 'Tainted summary',
        createdAt: Date.now(),
      },
    ];
    const migrated = normalizeResearchJob(job);

    expect(migrated.sourceRegistry?.[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        failureReason: 'access-denied',
        evidence: undefined,
      })
    );
    expect(task.report).toBeUndefined();
    expect(task.status).toBe('failed');
    expect(migrated.status).toBe('failed');
    expect(migrated.finalAnswer).toBeUndefined();
    expect(migrated.batchSummaries).toEqual([]);
    expect(migrated.partialAnswer).toBeUndefined();
    expect(task.decisions).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'access-denied' })])
    );
  });

  it('does not count a legacy success without persisted evidence as a readable source', () => {
    const task = legacyTask('missing-evidence', 'success');
    task.evidence = [];

    const migrated = normalizeResearchJob(legacyJob([task]));

    expect(migrated.sourceRegistry?.[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        failureReason: 'retrieval-failed',
      })
    );
    expect(migrated.progress.uniqueSourcesSucceeded).toBe(0);
    expect(migrated.progress.uniqueSourcesFailed).toBe(1);
    expect(migrated.progress.sourcesRead).toBe(0);
  });
});

describe('research job persistence', () => {
  it('serializes snapshots so an older write cannot overwrite resumed state', async () => {
    const db = await jest.mocked(openDB).mock.results[0].value;
    const firstWrite = deferred<void>();
    jest.mocked(db.put).mockReturnValueOnce(firstWrite.promise);
    const job = legacyJob([]);
    job.status = 'running';

    const runningSave = saveResearchJob(job);
    await flushAsyncWork();
    job.status = 'queued';
    const queuedSave = saveResearchJob(job);
    await flushAsyncWork();

    expect(db.put).toHaveBeenCalledTimes(1);
    firstWrite.resolve();
    await Promise.all([runningSave, queuedSave]);

    expect(db.put).toHaveBeenCalledTimes(2);
    expect(jest.mocked(db.put).mock.calls[0][1]).toMatchObject({ status: 'running' });
    expect(jest.mocked(db.put).mock.calls[1][1]).toMatchObject({ status: 'queued' });
  });
});

function legacyTask(id: string, visitStatus: 'success' | 'fetching'): ResearchTask {
  const sourceUrl = `https://example.com/${id}`;
  const now = Date.now();
  return {
    id,
    label: id,
    sourceUrl,
    title: id,
    status: visitStatus === 'success' ? 'completed' : 'running',
    phase: visitStatus === 'success' ? 'completed' : 'opening',
    phaseStartedAt: now,
    lastActivityAt: now,
    reasoning: [],
    linkVisits: [
      {
        url: sourceUrl,
        title: id,
        status: visitStatus,
        relevanceScore: 1,
        timestamp: now,
        depth: 0,
      },
    ],
    relatedSourcesRead: 0,
    relatedSourcesAttempted: 0,
    evidence:
      visitStatus === 'success'
        ? [
            {
              url: sourceUrl,
              title: id,
              category: 'other',
              excerpt: `Validated legacy evidence for ${id}`,
              depth: 0,
            },
          ]
        : [],
    decisions: [],
    pendingSources: [],
    visitedUrls: [],
    report: visitStatus === 'success' ? 'Legacy report' : undefined,
  };
}

function legacyJob(tasks: ResearchTask[]): ResearchJob {
  const now = Date.now();
  return {
    id: 'legacy-job',
    messageId: 'message',
    question: 'Research sources',
    status: 'running',
    tasks,
    progress: {
      jobId: 'legacy-job',
      status: 'running',
      activity: 'Legacy research',
      totalTasks: tasks.length,
      completedTasks: 2,
      failedTasks: 0,
      activeWorkers: 1,
      sourcesRead: 99,
      sourcesFailed: 0,
      updatedAt: now,
      activeTaskIds: ['abandoned'],
    },
    createdAt: now,
    updatedAt: now,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function flushAsyncWork() {
  return new Promise(resolve => setTimeout(resolve, 0));
}
