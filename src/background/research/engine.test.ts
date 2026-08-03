jest.mock('./storage', () => ({
  getResearchJob: jest.fn(),
  saveResearchJob: jest.fn(),
}));
jest.mock('../content/link-tab-fetcher', () => ({ fetchLinkContentInTab: jest.fn() }));

import { retryFailedResearchTasks, runResearchJob } from './engine';
import { extractResearchTasks, isEvidenceLink } from './link-policy';
import { fetchLinkContentInTab } from '../content/link-tab-fetcher';
import { getResearchJob, saveResearchJob } from './storage';
import type { LinkInfo, ResearchJob, ResearchTask, StorageSettings } from '@/shared/types';

describe('Deep Research subject discovery', () => {
  it('creates one worker task per unique researchable link', () => {
    const links: LinkInfo[] = [
      {
        url: 'https://jira.example.com/browse/SQ-100',
        text: 'SQ-100 First ticket',
        isExternal: false,
      },
      {
        url: 'https://jira.example.com/browse/SQ-100?focusedCommentId=1',
        text: 'SQ-100 duplicate',
        isExternal: false,
      },
      {
        url: 'https://docs.example.com/platform/architecture',
        text: 'Platform architecture',
        isExternal: false,
      },
    ];

    expect(extractResearchTasks(links).map(task => task.label)).toEqual([
      'SQ-100 First ticket',
      'Platform architecture',
    ]);
  });

  it('follows evidence links but rejects application navigation', () => {
    expect(
      isEvidenceLink({
        url: 'https://stash.example.com/projects/P/repos/app/pull-requests/42/overview',
        text: 'Code review',
        isExternal: true,
      })
    ).toBe(true);
    expect(
      isEvidenceLink({
        url: 'https://wiki.example.com/display/TEAM/Business+requirements',
        text: 'Business requirements',
        isExternal: true,
      })
    ).toBe(true);
    expect(
      isEvidenceLink({
        url: 'https://jira.example.com/people',
        text: 'People',
        isExternal: false,
      })
    ).toBe(false);
  });

  it('keeps unsafe seeds visible but permanently skipped', () => {
    const [task] = extractResearchTasks([
      {
        url: 'https://stash.example.com/plugins/servlet/createBranch?issue=SQ-100',
        text: 'Create branch',
        isExternal: true,
      },
    ]);

    expect(task.status).toBe('skipped');
    expect(task.pendingSources).toEqual([]);
    expect(task.decisions).toEqual([
      expect.objectContaining({ outcome: 'discarded', reason: 'blocked-unsafe-action' }),
    ]);
  });
});

describe('Deep Research worker pool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(saveResearchJob).mockResolvedValue(undefined);
  });

  it('never exceeds the configured research concurrency', async () => {
    let activeFetches = 0;
    let maximumFetches = 0;
    jest.mocked(fetchLinkContentInTab).mockImplementation(async url => {
      activeFetches++;
      maximumFetches = Math.max(maximumFetches, activeFetches);
      await new Promise(resolve => setTimeout(resolve, 5));
      activeFetches--;
      return { content: `Evidence from ${url}`, title: url, finalUrl: url, links: [] };
    });

    const tasks = ['alpha', 'beta', 'gamma'].map(createTask);
    const now = Date.now();
    const job: ResearchJob = {
      id: 'job-1',
      messageId: 'message-1',
      question: 'Summarize impact',
      status: 'queued',
      tasks,
      progress: {
        jobId: 'job-1',
        status: 'queued',
        activity: 'Queued',
        totalTasks: tasks.length,
        completedTasks: 0,
        failedTasks: 0,
        activeWorkers: 0,
        sourcesRead: 0,
        sourcesFailed: 0,
        updatedAt: now,
        activeTaskIds: [],
      },
      createdAt: now,
      updatedAt: now,
    };
    jest.mocked(getResearchJob).mockResolvedValue(job);
    jest.mocked(saveResearchJob).mockResolvedValue(undefined);
    const router = {
      complete: jest
        .fn()
        .mockResolvedValue({ text: 'Impact report', modelUsed: 'cloud' })
        .mockResolvedValueOnce({ text: '[0.9, 0.9, 0.9]', modelUsed: 'cloud' }),
    };
    const callbacks = { onProgress: jest.fn(), onAnswer: jest.fn(), onDone: jest.fn() };

    await runResearchJob(
      router,
      job.id,
      createSettings(2),
      callbacks,
      new AbortController().signal
    );

    expect(maximumFetches).toBe(2);
    expect(job.tasks.every(task => task.status === 'completed')).toBe(true);
    expect(job.status).toBe('completed');
    expect(callbacks.onAnswer).toHaveBeenCalledWith('Impact report');
  });

  it('scores related links and opens only the five highest relevant sources', async () => {
    jest.mocked(fetchLinkContentInTab).mockClear();
    const task = createTask('architecture');
    const job = createJob([task]);
    const childLinks = Array.from({ length: 8 }, (_, index) => ({
      url: `https://docs.example.com/related-${index}`,
      text: `Related evidence ${index}`,
      isExternal: true,
    }));
    childLinks.unshift({
      url: 'https://stash.example.com/plugins/servlet/createBranch?issue=SQ-1',
      text: 'Create branch',
      isExternal: true,
    });
    jest.mocked(fetchLinkContentInTab).mockImplementation(async url => ({
      content: `Evidence from ${url}`,
      title: url,
      finalUrl: url,
      links: url === task.sourceUrl ? childLinks : [],
    }));
    const router = {
      complete: jest
        .fn()
        .mockResolvedValue({ text: 'Impact report', modelUsed: 'cloud' })
        .mockResolvedValueOnce({ text: '[0.9]', modelUsed: 'cloud' })
        .mockResolvedValueOnce({
          text: '[0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.1]',
          modelUsed: 'cloud',
        }),
    };
    jest.mocked(getResearchJob).mockResolvedValue(job);

    await runResearchJob(
      router,
      job.id,
      createSettings(1),
      { onProgress: jest.fn(), onAnswer: jest.fn(), onDone: jest.fn() },
      new AbortController().signal
    );

    expect(fetchLinkContentInTab).toHaveBeenCalledTimes(6);
    expect(task.relatedSourcesAttempted).toBe(5);
    expect(
      task.decisions.filter(decision => decision.reason === 'per-subject-source-budget')
    ).toHaveLength(2);
    expect(task.decisions.some(decision => decision.reason === 'below-relevance-threshold')).toBe(
      true
    );
    expect(task.decisions).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'blocked-unsafe-action' })])
    );
    expect(fetchLinkContentInTab).not.toHaveBeenCalledWith(
      expect.stringContaining('createBranch'),
      expect.anything()
    );
  });

  it('scans 418 explicit subjects in persisted batches of 25', async () => {
    const tasks = Array.from({ length: 418 }, (_, index) => createTask(`subject-${index}`));
    const job = createJob(tasks);
    job.question = 'Research all subjects';
    jest.mocked(getResearchJob).mockResolvedValue(job);
    jest.mocked(fetchLinkContentInTab).mockImplementation(async url => ({
      content: `Evidence from ${url}`,
      title: url,
      finalUrl: url,
      links: [],
    }));

    await runResearchJob(
      createStageRouter(false),
      job.id,
      createSettings(3),
      { onProgress: jest.fn(), onAnswer: jest.fn(), onDone: jest.fn() },
      new AbortController().signal
    );

    expect(job.tasks.filter(task => task.seedStatus === 'completed')).toHaveLength(418);
    expect(job.batchSummaries?.filter(summary => summary.kind === 'discovery')).toHaveLength(17);
    expect(job.batchSummaries?.filter(summary => summary.kind === 'final')).toHaveLength(17);
    expect(job.totalBatches).toBe(17);
  });

  it('deduplicates related sources across workers and derives source counters', async () => {
    const tasks = [createTask('alpha'), createTask('beta')];
    const job = createJob(tasks);
    job.question = 'Research all subjects';
    const sharedUrl = 'https://docs.example.com/shared-evidence';
    jest.mocked(getResearchJob).mockResolvedValue(job);
    jest.mocked(fetchLinkContentInTab).mockImplementation(async url => ({
      content: `Evidence from ${url}`,
      title: url,
      finalUrl: url,
      links:
        url === sharedUrl
          ? []
          : [{ url: sharedUrl, text: 'Shared supporting evidence', isExternal: true }],
    }));

    await runResearchJob(
      createStageRouter(true),
      job.id,
      createSettings(2),
      { onProgress: jest.fn(), onAnswer: jest.fn(), onDone: jest.fn() },
      new AbortController().signal
    );

    expect(fetchLinkContentInTab).toHaveBeenCalledTimes(3);
    expect(job.sourceRegistry).toHaveLength(3);
    expect(job.progress.uniqueSourcesSucceeded).toBe(3);
    expect(job.progress.sourcesRead).toBe(3);
    expect(job.progress.sourceCacheHits).toBe(1);
    expect(job.progress.sourcesRead).toBeLessThanOrEqual(job.sourceRegistry?.length || 0);
  });

  it('stops expansion at the persisted global unique-source budget', async () => {
    const task = createTask('budgeted');
    const job = createJob([task]);
    job.question = 'Research all subjects';
    const settings = createSettings(1);
    settings.research.maxUniqueSourcesPerJob = 2;
    jest.mocked(getResearchJob).mockResolvedValue(job);
    jest.mocked(fetchLinkContentInTab).mockImplementation(async url => ({
      content: `Evidence from ${url}`,
      title: url,
      finalUrl: url,
      links:
        url === task.sourceUrl
          ? Array.from({ length: 3 }, (_, index) => ({
              url: `https://docs.example.com/budget-${index}`,
              text: `Budget evidence ${index}`,
              isExternal: true,
            }))
          : [],
    }));

    await runResearchJob(
      createStageRouter(true),
      job.id,
      settings,
      { onProgress: jest.fn(), onAnswer: jest.fn(), onDone: jest.fn() },
      new AbortController().signal
    );

    expect(fetchLinkContentInTab).toHaveBeenCalledTimes(2);
    expect(job.sourceRegistry).toHaveLength(2);
    expect(
      task.decisions.filter(decision => decision.reason === 'global-source-budget')
    ).toHaveLength(2);
    expect(job.status).toBe('completed');
  });

  it('does not retrieve new sources when a migrated registry already exceeds its budget', async () => {
    const task = createTask('new-seed');
    const job = createJob([task]);
    const now = Date.now();
    job.sourceBudget = 1;
    job.sourceRegistry = ['legacy-one', 'legacy-two'].map(label => ({
      key: `https://example.com/${label}`,
      url: `https://example.com/${label}`,
      title: label,
      status: 'success',
      taskIds: [],
      evidence: {
        url: `https://example.com/${label}`,
        title: label,
        category: 'other',
        excerpt: `Validated ${label} evidence`,
        depth: 0,
      },
      retries: 0,
      cacheHits: 0,
      createdAt: now,
      updatedAt: now,
    }));
    jest.mocked(getResearchJob).mockResolvedValue(job);
    const callbacks = { onProgress: jest.fn(), onAnswer: jest.fn(), onDone: jest.fn() };

    await runResearchJob(
      createStageRouter(false),
      job.id,
      createSettings(1),
      callbacks,
      new AbortController().signal
    );

    expect(fetchLinkContentInTab).not.toHaveBeenCalled();
    expect(job.sourceRegistry).toHaveLength(2);
    expect(job.progress.sourceBudgetUsed).toBe(1);
    expect(job.progress.sourceBudgetOverflow).toBe(1);
    expect(task.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'source-budget-exhausted', outcome: 'skipped' }),
      ])
    );
    expect(job.partialAnswer).toContain('Validated readable sources: 2');
  });

  it('resumes after a persisted seed batch without reopening completed seeds', async () => {
    const task = createTask('resumed');
    const job = createJob([task]);
    const now = Date.now();
    task.seedStatus = 'completed';
    task.status = 'queued';
    task.sourceKeys = [task.sourceUrl];
    task.seedAssessment = {
      summary: 'Persisted seed summary',
      relevance: 0.9,
      themes: ['resilience'],
      evidenceGaps: [],
      expansionNeeded: false,
    };
    job.sourceRegistry = [
      {
        key: task.sourceUrl,
        url: task.sourceUrl,
        title: task.title,
        status: 'success',
        taskIds: [task.id],
        evidence: {
          url: task.sourceUrl,
          title: task.title,
          category: 'other',
          excerpt: 'Persisted evidence',
          depth: 0,
        },
        retries: 0,
        cacheHits: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
    job.batchSummaries = [
      {
        batchIndex: 0,
        kind: 'discovery',
        taskIds: [task.id],
        summary: 'Persisted discovery summary',
        createdAt: now,
      },
    ];
    jest.mocked(getResearchJob).mockResolvedValue(job);

    await runResearchJob(
      createStageRouter(false),
      job.id,
      createSettings(1),
      { onProgress: jest.fn(), onAnswer: jest.fn(), onDone: jest.fn() },
      new AbortController().signal
    );

    expect(fetchLinkContentInTab).not.toHaveBeenCalled();
    expect(job.status).toBe('completed');
    expect(job.batchSummaries.filter(summary => summary.kind === 'discovery')).toHaveLength(1);
  });

  it('does not open related sources until the seed batch summary is persisted', async () => {
    const events: string[] = [];
    const task = createTask('ordered');
    const relatedUrl = 'https://docs.example.com/ordered-related';
    const job = createJob([task]);
    job.question = 'Research all subjects';
    jest.mocked(getResearchJob).mockResolvedValue(job);
    jest.mocked(fetchLinkContentInTab).mockImplementation(async url => {
      events.push(url === relatedUrl ? 'related-fetch' : 'seed-fetch');
      return {
        content: `Evidence from ${url}`,
        title: url,
        finalUrl: url,
        links:
          url === task.sourceUrl
            ? [{ url: relatedUrl, text: 'Ordered related evidence', isExternal: true }]
            : [],
      };
    });
    const router = createStageRouter(true);
    router.complete.mockImplementation(async (_question, _context, prompt) => {
      if (prompt.includes('Return JSON only')) {
        return {
          text: JSON.stringify({
            summary: 'Seed summary',
            relevance: 0.9,
            themes: [],
            evidenceGaps: ['related evidence'],
            expansionNeeded: true,
          }),
          modelUsed: 'cloud',
        };
      }
      if (prompt.includes('Return only JSON array')) {
        return { text: '[0.9]', modelUsed: 'cloud' };
      }
      if (prompt.includes('Combine these seed assessments')) events.push('discovery-summary');
      return { text: 'Compact cited research summary', modelUsed: 'cloud' };
    });

    await runResearchJob(
      router,
      job.id,
      createSettings(1),
      { onProgress: jest.fn(), onAnswer: jest.fn(), onDone: jest.fn() },
      new AbortController().signal
    );

    expect(events.indexOf('discovery-summary')).toBeLessThan(events.indexOf('related-fetch'));
  });

  it('continues with later planned sources after one source fails', async () => {
    const task = createTask('partial-failure');
    const job = createJob([task]);
    job.question = 'Research all subjects';
    jest.mocked(getResearchJob).mockResolvedValue(job);
    jest.mocked(fetchLinkContentInTab).mockImplementation(async url => {
      if (url.endsWith('failed')) return { error: 'Source unavailable', links: [] };
      return {
        content: `Evidence from ${url}`,
        title: url,
        finalUrl: url,
        links:
          url === task.sourceUrl
            ? [
                {
                  url: 'https://docs.example.com/failed',
                  text: 'Failed related evidence',
                  isExternal: true,
                },
                {
                  url: 'https://docs.example.com/success',
                  text: 'Successful related evidence',
                  isExternal: true,
                },
              ]
            : [],
      };
    });

    await runResearchJob(
      createStageRouter(true),
      job.id,
      createSettings(1),
      { onProgress: jest.fn(), onAnswer: jest.fn(), onDone: jest.fn() },
      new AbortController().signal
    );

    expect(fetchLinkContentInTab).toHaveBeenCalledWith(
      'https://docs.example.com/success',
      expect.anything()
    );
    expect(job.progress.uniqueSourcesFailed).toBe(1);
    expect(job.status).toBe('completed');
  });

  it('rejects inaccessible seed content without scoring or opening its child links', async () => {
    const task = createTask('restricted');
    const job = createJob([task]);
    const childUrl = 'https://docs.example.com/should-not-open';
    jest.mocked(getResearchJob).mockResolvedValue(job);
    jest.mocked(fetchLinkContentInTab).mockResolvedValue({
      content: 'You do not have permission to view this page.',
      title: 'Restricted source',
      finalUrl: task.sourceUrl,
      links: [{ url: childUrl, text: 'Untrusted child link', isExternal: true }],
    });

    await expect(
      runResearchJob(
        createStageRouter(true),
        job.id,
        createSettings(1),
        { onProgress: jest.fn(), onAnswer: jest.fn(), onDone: jest.fn() },
        new AbortController().signal
      )
    ).rejects.toThrow('could not produce a readable report');

    expect(fetchLinkContentInTab).toHaveBeenCalledTimes(1);
    expect(fetchLinkContentInTab).not.toHaveBeenCalledWith(childUrl, expect.anything());
    expect(job.sourceRegistry?.[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        failureReason: 'access-denied',
      })
    );
    expect(job.sourceRegistry?.[0].evidence).toBeUndefined();
    expect(task.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'failed', reason: 'access-denied' }),
      ])
    );
    expect(job.progress.uniqueSourcesSucceeded).toBe(0);
    expect(job.progress.uniqueSourcesFailed).toBe(1);
  });

  it('does not reopen a permanent access failure for another worker', async () => {
    const first = createTask('restricted-first');
    const second = createTask('restricted-second');
    second.sourceUrl = first.sourceUrl;
    second.pendingSources = [{ url: first.sourceUrl, title: second.title, depth: 0 }];
    const job = createJob([first, second]);
    job.question = 'Research all subjects';
    jest.mocked(getResearchJob).mockResolvedValue(job);
    jest.mocked(fetchLinkContentInTab).mockResolvedValue({
      content: 'You do not have permission to view this page.',
      title: 'Restricted source',
      finalUrl: first.sourceUrl,
      links: [],
    });

    await expect(
      runResearchJob(
        createStageRouter(false),
        job.id,
        createSettings(1),
        { onProgress: jest.fn(), onAnswer: jest.fn(), onDone: jest.fn() },
        new AbortController().signal
      )
    ).rejects.toThrow('could not produce a readable report');

    expect(fetchLinkContentInTab).toHaveBeenCalledTimes(1);
    expect(job.sourceRegistry).toHaveLength(1);
    expect(job.sourceRegistry?.[0].cacheHits).toBe(1);
  });

  it('synthesizes completed legacy reports without retrying failed subjects automatically', async () => {
    const completed = Array.from({ length: 48 }, (_, index) => {
      const task = createTask(`completed-${index}`);
      task.status = 'completed';
      task.phase = 'completed';
      task.seedStatus = 'completed';
      task.expansionStatus = 'completed';
      task.report = `Validated impact report ${index}`;
      return task;
    });
    const failed = Array.from({ length: 370 }, (_, index) => {
      const task = createTask(`failed-${index}`);
      task.status = 'failed';
      task.phase = 'failed';
      task.seedStatus = 'failed';
      task.expansionStatus = 'skipped';
      task.error = 'Source inaccessible';
      return task;
    });
    const job = createJob([...completed, ...failed]);
    job.question = 'Research all subjects';
    jest.mocked(getResearchJob).mockResolvedValue(job);
    const callbacks = { onProgress: jest.fn(), onAnswer: jest.fn(), onDone: jest.fn() };

    await runResearchJob(
      createStageRouter(false),
      job.id,
      createSettings(3),
      callbacks,
      new AbortController().signal
    );

    expect(fetchLinkContentInTab).not.toHaveBeenCalled();
    expect(job.status).toBe('failed');
    expect(job.partialAnswer).toBe('Compact cited research summary');
    expect(job.finalAnswer).toBeUndefined();
    expect(job.error).toContain('370 of 418 research subjects failed');
    expect(callbacks.onAnswer).toHaveBeenCalledWith('Compact cited research summary');
  });

  it('retries failed work while preserving validated source evidence', async () => {
    const completed = createTask('completed');
    completed.status = 'completed';
    completed.seedStatus = 'completed';
    completed.report = 'Persisted completed report';
    const failed = createTask('failed');
    failed.status = 'failed';
    failed.seedStatus = 'failed';
    const job = createJob([completed, failed]);
    const now = Date.now();
    job.status = 'failed';
    job.sourceRegistry = [
      {
        key: completed.sourceUrl,
        url: completed.sourceUrl,
        title: completed.title,
        status: 'success',
        taskIds: [completed.id],
        evidence: {
          url: completed.sourceUrl,
          title: completed.title,
          category: 'other',
          excerpt: 'Persisted readable evidence',
          depth: 0,
        },
        retries: 0,
        cacheHits: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        key: failed.sourceUrl,
        url: failed.sourceUrl,
        title: failed.title,
        status: 'failed',
        taskIds: [failed.id],
        error: 'VPN disconnected',
        retries: 0,
        cacheHits: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
    jest.mocked(getResearchJob).mockResolvedValue(job);

    const retried = await retryFailedResearchTasks(job.id);

    expect(retried?.sourceRegistry?.[0]).toEqual(
      expect.objectContaining({
        status: 'success',
        evidence: expect.objectContaining({ excerpt: 'Persisted readable evidence' }),
      })
    );
    expect(retried?.sourceRegistry?.[1]).toEqual(
      expect.objectContaining({ status: 'pending', retries: 1 })
    );
    expect(completed.status).toBe('completed');
    expect(completed.report).toBe('Persisted completed report');
    expect(retried?.progress.activity).toBe(
      'Retrying 1 failed research subjects; reusing 1 validated sources.'
    );
  });
});

function createStageRouter(expansionNeeded: boolean) {
  return {
    complete: jest.fn(async (_question: string, _context: unknown, prompt: string) => {
      if (prompt.includes('Return JSON only')) {
        return {
          text: JSON.stringify({
            summary: 'Seed summary',
            relevance: 0.9,
            themes: ['impact'],
            evidenceGaps: expansionNeeded ? ['supporting evidence'] : [],
            expansionNeeded,
          }),
          modelUsed: 'cloud' as const,
        };
      }
      if (prompt.includes('Return only JSON array')) {
        const count = (prompt.match(/^\d+\./gm) || []).length;
        return {
          text: JSON.stringify(Array.from({ length: count }, () => 0.9)),
          modelUsed: 'cloud' as const,
        };
      }
      return { text: 'Compact cited research summary', modelUsed: 'cloud' as const };
    }),
  };
}

function createJob(tasks: ResearchTask[]): ResearchJob {
  const now = Date.now();
  return {
    id: 'job-1',
    messageId: 'message-1',
    question: 'Find architecture evidence',
    status: 'queued',
    tasks,
    progress: {
      jobId: 'job-1',
      status: 'queued',
      activity: 'Queued',
      totalTasks: tasks.length,
      completedTasks: 0,
      failedTasks: 0,
      activeWorkers: 0,
      sourcesRead: 0,
      sourcesFailed: 0,
      updatedAt: now,
      activeTaskIds: [],
    },
    createdAt: now,
    updatedAt: now,
  };
}

function createTask(label: string): ResearchTask {
  const sourceUrl = `https://example.com/research/${label}`;
  return {
    id: label,
    label,
    sourceUrl,
    title: label,
    status: 'queued',
    phase: 'queued',
    phaseStartedAt: Date.now(),
    lastActivityAt: Date.now(),
    reasoning: [],
    linkVisits: [],
    relatedSourcesRead: 0,
    relatedSourcesAttempted: 0,
    evidence: [],
    decisions: [],
    pendingSources: [{ url: sourceUrl, title: label, depth: 0 }],
    visitedUrls: [],
  };
}

function createSettings(workerConcurrency: number): StorageSettings {
  return {
    model: {
      cloudModel: 'nemotron-3-nano',
      apiKey: 'test',
      useLocal: false,
      autoRoute: true,
      forceCloudFor: [],
    },
    links: {
      enabled: true,
      mode: 'deep',
      maxDepth: 2,
      maxPages: 10,
      rateLimitMs: 0,
      requireConfirmation: false,
      allowedDomains: [],
      blockedDomains: [],
    },
    research: {
      workerConcurrency,
      maxRelatedSourcesPerTask: 5,
      subjectBatchSize: 25,
      maxUniqueSourcesPerJob: 1000,
      cloudNoticeAccepted: true,
    },
    ui: { theme: 'system', showReasoning: true, showLinks: true, streaming: true },
    privacy: { localOnly: false, clearOnClose: false },
  };
}
