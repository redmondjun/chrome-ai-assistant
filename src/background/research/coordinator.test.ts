jest.mock('./engine', () => ({
  createResearchJob: jest.fn(),
  retryFailedResearchTasks: jest.fn(),
  runResearchJob: jest.fn(),
  setResearchJobStatus: jest.fn(),
}));
jest.mock('./storage', () => ({
  getResearchJob: jest.fn(),
  getResumableResearchJobs: jest.fn(),
}));

import { ModelRouter } from '../api/router';
import { DEFAULT_SETTINGS } from '../storage/settings';
import { ResearchCoordinator } from './coordinator';
import { runResearchJob, setResearchJobStatus } from './engine';
import { getResearchJob, getResumableResearchJobs } from './storage';
import type { ResearchJob } from '@/shared/types';

describe('ResearchCoordinator resume', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(chrome, 'alarms', {
      configurable: true,
      value: {
        create: jest.fn(),
        clear: jest.fn().mockResolvedValue(true),
      },
    });
    jest.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
    jest.mocked(getResumableResearchJobs).mockResolvedValue([]);
  });

  it('does not let the stopped run remove the resumed run', async () => {
    const firstRun = deferred<void>();
    const secondRun = deferred<void>();
    const job = createJob();
    jest.mocked(getResearchJob).mockResolvedValue(job);
    jest.mocked(setResearchJobStatus).mockImplementation(async (_jobId, status) => ({
      ...job,
      status,
    }));
    jest
      .mocked(runResearchJob)
      .mockReturnValueOnce(firstRun.promise)
      .mockReturnValueOnce(secondRun.promise);
    const coordinator = new ResearchCoordinator(
      async () => new ModelRouter(DEFAULT_SETTINGS.model),
      async () => DEFAULT_SETTINGS
    );

    await coordinator.resume(job.id);
    await coordinator.pause(job.id);
    await coordinator.resume(job.id);
    expect(runResearchJob).toHaveBeenCalledTimes(2);

    firstRun.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await coordinator.resume(job.id);

    expect(runResearchJob).toHaveBeenCalledTimes(2);
    secondRun.resolve();
  });
});

function createJob(): ResearchJob {
  const now = Date.now();
  return {
    id: 'research-job',
    messageId: 'message',
    question: 'Research all subjects',
    status: 'queued',
    tasks: [],
    progress: {
      jobId: 'research-job',
      status: 'queued',
      activity: 'Queued',
      totalTasks: 0,
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
