import type { ModelRouter } from '../api/router';
import {
  createResearchJob,
  retryFailedResearchTasks,
  runResearchJob,
  setResearchJobStatus,
} from './engine';
import { getResearchJob, getResumableResearchJobs } from './storage';
import type { ResearchProgress, ResearchTask, StorageSettings, TabContent } from '@/shared/types';
import { finishAgentRun, heartbeatAgentRun, startAgentRun } from '../diagnostics';

export const RESEARCH_RESUME_ALARM = 'resume-deep-research';

type ResearchRuntimeMessage =
  | { type: 'STREAM_CHUNK'; messageId: string; chunk: string }
  | { type: 'STREAM_DONE'; messageId: string }
  | { type: 'ERROR'; messageId: string; message: string }
  | { type: 'RESEARCH_TASK_UPDATE'; messageId: string; jobId: string; task: ResearchTask }
  | { type: 'RESEARCH_PROGRESS'; messageId: string; progress: ResearchProgress };

export class ResearchCoordinator {
  private readonly activeJobs = new Map<
    string,
    { controller: AbortController; attemptId: string }
  >();

  constructor(
    private readonly getRouter: () => Promise<ModelRouter>,
    private readonly getSettings: () => Promise<StorageSettings>
  ) {}

  async start(content: TabContent, question: string, messageId: string) {
    const job = await createResearchJob(content, question, messageId);
    const run = await this.launch(job.id);
    if (run) {
      job.progress = {
        ...job.progress,
        attemptId: run.attemptId,
        health: run.health,
        operationStartedAt: run.operationStartedAt,
        lastHeartbeatAt: run.lastHeartbeatAt,
        diagnosticId: run.diagnosticId,
      };
    }
    return job;
  }

  async retryInParallel(sourceJobId: string, messageId: string) {
    const source = await getResearchJob(sourceJobId);
    if (!source) throw new Error('The original research job no longer exists.');
    const content: TabContent = {
      url: '',
      title: 'Deep Research retry',
      text: '',
      links: source.tasks.map(task => ({
        url: task.sourceUrl,
        text: task.title || task.label,
        isExternal: true,
      })),
      meta: {},
      timestamp: Date.now(),
    };
    return this.start(content, source.question, messageId);
  }

  async pause(jobId: string) {
    this.abort(jobId, 'Research paused by user.');
    const job = await setResearchJobStatus(jobId, 'paused');
    if (job) this.emitProgress(job.messageId, job.progress);
    return job;
  }

  async resume(jobId: string) {
    const job = await setResearchJobStatus(jobId, 'queued');
    if (job) await this.launch(job.id);
    return job;
  }

  async cancel(jobId: string) {
    this.abort(jobId, 'Research cancelled by user.');
    const job = await setResearchJobStatus(jobId, 'cancelled');
    if (job) this.emitProgress(job.messageId, job.progress);
    return job;
  }

  async retry(jobId: string) {
    const job = await retryFailedResearchTasks(jobId);
    if (job) {
      this.emitProgress(job.messageId, job.progress);
      await this.launch(job.id);
    }
    return job;
  }

  getJob(jobId: string) {
    return getResearchJob(jobId);
  }

  async resumePendingJobs() {
    try {
      const jobs = await getResumableResearchJobs();
      await Promise.all(jobs.map(job => this.launch(job.id)));
    } catch (error) {
      console.error('[research]', 'Could not resume research jobs:', error);
    }
  }

  private async launch(jobId: string) {
    if (this.activeJobs.has(jobId)) return;
    const job = await getResearchJob(jobId);
    if (!job || !['queued', 'running'].includes(job.status)) return;
    const controller = new AbortController();
    const run = await startAgentRun({
      kind: 'deep-research',
      messageId: job.messageId,
      jobId: job.id,
      activity: 'Starting Deep Research.',
    });
    job.progress = {
      ...job.progress,
      attemptId: run.attemptId,
      health: run.health,
      operationStartedAt: run.operationStartedAt,
      lastHeartbeatAt: run.lastHeartbeatAt,
      diagnosticId: run.diagnosticId,
    };
    this.emitProgress(job.messageId, job.progress);
    this.activeJobs.set(jobId, { controller, attemptId: run.attemptId });

    let router: ModelRouter;
    let settings: StorageSettings;
    try {
      router = await this.getRouter();
      settings = await this.getSettings();
    } catch (error) {
      if (this.activeJobs.get(jobId)?.controller === controller) {
        this.activeJobs.delete(jobId);
      }
      throw error;
    }
    chrome.alarms.create(RESEARCH_RESUME_ALARM, { periodInMinutes: 1 });

    void runResearchJob(
      router,
      jobId,
      settings,
      {
        onProgress: progress => {
          void heartbeatAgentRun(run.attemptId, {
            activity: activityForStage(progress.stage),
            operation: operationForStage(progress.stage),
          }).then(updated => {
            this.emitProgress(job.messageId, {
              ...progress,
              attemptId: run.attemptId,
              health: updated?.health || 'healthy',
              operationStartedAt: updated?.operationStartedAt,
              lastHeartbeatAt: updated?.lastHeartbeatAt || progress.updatedAt,
              diagnosticId: updated?.diagnosticId,
            });
          });
        },
        onTaskUpdate: task =>
          this.send({
            type: 'RESEARCH_TASK_UPDATE',
            messageId: job.messageId,
            jobId: job.id,
            task,
          }),
        onAnswer: answer =>
          this.send({
            type: 'STREAM_CHUNK',
            messageId: job.messageId,
            chunk: answer,
          }),
        onDone: () => this.send({ type: 'STREAM_DONE', messageId: job.messageId }),
      },
      controller.signal,
      { attemptId: run.attemptId, messageId: job.messageId, jobId: job.id }
    )
      .then(async () => {
        const finishedJob = await getResearchJob(job.id);
        await finishAgentRun(
          run.attemptId,
          finishedJob?.status === 'failed' ? 'failed' : 'completed',
          finishedJob?.status === 'failed' ? finishedJob.error : undefined
        );
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        void finishAgentRun(run.attemptId, 'failed', error);
        this.send({
          type: 'ERROR',
          messageId: job.messageId,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(async () => {
        if (controller.signal.aborted) {
          await finishAgentRun(run.attemptId, 'stopped', controller.signal.reason);
        }
        if (this.activeJobs.get(jobId)?.controller === controller) {
          this.activeJobs.delete(jobId);
        }
        if (this.activeJobs.size === 0 && (await getResumableResearchJobs()).length === 0) {
          await chrome.alarms.clear(RESEARCH_RESUME_ALARM);
        }
      });
    return run;
  }

  private abort(jobId: string, reason: string) {
    this.activeJobs.get(jobId)?.controller.abort(reason);
    this.activeJobs.delete(jobId);
  }

  private emitProgress(messageId: string, progress: ResearchProgress) {
    this.send({ type: 'RESEARCH_PROGRESS', messageId, progress });
  }

  private send(message: ResearchRuntimeMessage) {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  }
}

function operationForStage(stage?: ResearchProgress['stage']) {
  if (stage === 'final-synthesis' || stage === 'batch-synthesis')
    return 'research-synthesis' as const;
  if (stage === 'seed-scan' || stage === 'expansion') return 'research-worker' as const;
  return 'research-orchestration' as const;
}

function activityForStage(stage?: ResearchProgress['stage']) {
  if (stage === 'seed-scan') return 'Scanning research seed sources.';
  if (stage === 'expansion-planning') return 'Planning research expansion.';
  if (stage === 'expansion') return 'Reading selected related sources.';
  if (stage === 'batch-synthesis') return 'Synthesizing a research batch.';
  if (stage === 'final-synthesis') return 'Generating the final research answer.';
  return 'Coordinating Deep Research.';
}
