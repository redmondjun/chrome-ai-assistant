import { DEFAULT_SETTINGS } from '../storage/settings';
import {
  assignResearchModels,
  createLeadRouter,
  createOrchestrationConfig,
  createWorkerRouter,
} from './orchestration';
import type { ResearchJob, ResearchTask } from '@/shared/types';

describe('Deep Research model orchestration', () => {
  it('builds the default cloud snapshot and disables it in local-only mode', () => {
    expect(createOrchestrationConfig(DEFAULT_SETTINGS)).toEqual({
      enabled: true,
      workerModels: ['glm-5.2', 'nemotron-3-super', 'minimax-m3'],
      leadModel: 'glm-5.2',
    });
    expect(
      createOrchestrationConfig({
        ...DEFAULT_SETTINGS,
        privacy: { ...DEFAULT_SETTINGS.privacy, localOnly: true },
      }).enabled
    ).toBe(false);
  });

  it('assigns workers deterministically without replacing persisted assignments', () => {
    const job = createJob(4);
    assignResearchModels(job);
    expect(job.tasks.map(task => task.assignedModel)).toEqual([
      'glm-5.2',
      'nemotron-3-super',
      'minimax-m3',
      'glm-5.2',
    ]);

    job.tasks[0].effectiveModel = 'nemotron-3-super';
    job.tasks[0].fallbackUsed = true;
    assignResearchModels(job);
    expect(job.tasks[0]).toEqual(
      expect.objectContaining({
        assignedModel: 'glm-5.2',
        effectiveModel: 'nemotron-3-super',
        fallbackUsed: true,
      })
    );
  });

  it('uses GLM 5.2 for lead completions', async () => {
    const complete = jest.fn().mockResolvedValue({ text: 'lead', modelUsed: 'cloud' });
    const lead = createLeadRouter({ complete }, createJob(1).orchestration!);

    await lead.complete('question', { hasLinks: true, contentLength: 10 }, 'prompt');

    expect(complete).toHaveBeenCalledWith(
      'question',
      { hasLinks: true, contentLength: 10 },
      'prompt',
      { cloudModel: 'glm-5.2' }
    );
  });

  it('falls back once to the next model and keeps it for later calls', async () => {
    const job = createJob(1);
    assignResearchModels(job);
    const task = job.tasks[0];
    const complete = jest
      .fn()
      .mockRejectedValueOnce(new Error('GLM unavailable'))
      .mockResolvedValue({ text: 'fallback', modelUsed: 'cloud' });
    const checkpoint = jest.fn().mockResolvedValue(undefined);
    const worker = createWorkerRouter({ complete }, job, task, checkpoint);

    await worker.complete('question', { hasLinks: true, contentLength: 10 }, 'prompt');
    await worker.complete('question', { hasLinks: true, contentLength: 10 }, 'prompt 2');

    expect(complete.mock.calls.map(call => call[3].cloudModel)).toEqual([
      'glm-5.2',
      'nemotron-3-super',
      'nemotron-3-super',
    ]);
    expect(task.effectiveModel).toBe('nemotron-3-super');
    expect(task.fallbackUsed).toBe(true);
    expect(checkpoint).toHaveBeenCalledWith(task, 'Subject 1: retrying with nemotron-3-super');
  });

  it('stops after the bounded fallback fails', async () => {
    const job = createJob(1);
    assignResearchModels(job);
    const complete = jest.fn().mockRejectedValue(new Error('unavailable'));
    const worker = createWorkerRouter(
      { complete },
      job,
      job.tasks[0],
      jest.fn().mockResolvedValue(undefined)
    );

    await expect(
      worker.complete('question', { hasLinks: true, contentLength: 10 }, 'prompt')
    ).rejects.toThrow('unavailable');
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

function createJob(taskCount: number): ResearchJob {
  const now = Date.now();
  return {
    id: 'job',
    messageId: 'message',
    question: 'Research every subject',
    status: 'queued',
    tasks: Array.from({ length: taskCount }, (_, index) => createTask(index)),
    progress: {
      jobId: 'job',
      status: 'queued',
      activity: 'Queued',
      totalTasks: taskCount,
      completedTasks: 0,
      failedTasks: 0,
      activeWorkers: 0,
      sourcesRead: 0,
      sourcesFailed: 0,
      updatedAt: now,
      activeTaskIds: [],
    },
    orchestration: {
      enabled: true,
      workerModels: ['glm-5.2', 'nemotron-3-super', 'minimax-m3'],
      leadModel: 'glm-5.2',
    },
    createdAt: now,
    updatedAt: now,
  };
}

function createTask(index: number): ResearchTask {
  const now = Date.now();
  return {
    id: `task-${index}`,
    label: `Subject ${index + 1}`,
    sourceUrl: `https://example.com/${index}`,
    title: `Subject ${index + 1}`,
    status: 'queued',
    phase: 'queued',
    phaseStartedAt: now,
    lastActivityAt: now,
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
