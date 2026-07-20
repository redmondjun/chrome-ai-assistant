jest.mock('./storage', () => ({
  getResearchJob: jest.fn(),
  saveResearchJob: jest.fn(),
}));
jest.mock('../content/link-tab-fetcher', () => ({ fetchLinkContentInTab: jest.fn() }));

import { runResearchJob } from './engine';
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
      task.decisions.filter(decision => decision.reason === 'related-source-budget-limit')
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
});

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
      cloudNoticeAccepted: true,
    },
    ui: { theme: 'system', showReasoning: true, showLinks: true, streaming: true },
    privacy: { localOnly: false, clearOnClose: false },
  };
}
