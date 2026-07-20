import type { ModelRouter } from '../api/router';
import {
  createResearchJob,
  retryFailedResearchTasks,
  runResearchJob,
  setResearchJobStatus,
} from './engine';
import { getResearchJob, getResumableResearchJobs } from './storage';
import type { ResearchProgress, ResearchTask, StorageSettings, TabContent } from '@/shared/types';

export const RESEARCH_RESUME_ALARM = 'resume-deep-research';

type ResearchRuntimeMessage =
  | { type: 'STREAM_CHUNK'; messageId: string; chunk: string }
  | { type: 'STREAM_DONE'; messageId: string }
  | { type: 'ERROR'; messageId: string; message: string }
  | { type: 'RESEARCH_TASK_UPDATE'; messageId: string; jobId: string; task: ResearchTask }
  | { type: 'RESEARCH_PROGRESS'; messageId: string; progress: ResearchProgress };

export class ResearchCoordinator {
  private readonly activeJobs = new Map<string, AbortController>();

  constructor(
    private readonly getRouter: () => Promise<ModelRouter>,
    private readonly getSettings: () => Promise<StorageSettings>
  ) {}

  async start(content: TabContent, question: string, messageId: string) {
    const job = await createResearchJob(content, question, messageId);
    await this.launch(job.id);
    return job;
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
    this.activeJobs.set(jobId, controller);

    let router: ModelRouter;
    let settings: StorageSettings;
    try {
      router = await this.getRouter();
      settings = await this.getSettings();
    } catch (error) {
      this.activeJobs.delete(jobId);
      throw error;
    }
    chrome.alarms.create(RESEARCH_RESUME_ALARM, { periodInMinutes: 1 });

    void runResearchJob(
      router,
      jobId,
      settings,
      {
        onProgress: progress => this.emitProgress(job.messageId, progress),
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
      controller.signal
    )
      .catch(error => {
        if (controller.signal.aborted) return;
        this.send({
          type: 'ERROR',
          messageId: job.messageId,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(async () => {
        this.activeJobs.delete(jobId);
        if ((await getResumableResearchJobs()).length === 0) {
          await chrome.alarms.clear(RESEARCH_RESUME_ALARM);
        }
      });
  }

  private abort(jobId: string, reason: string) {
    this.activeJobs.get(jobId)?.abort(reason);
    this.activeJobs.delete(jobId);
  }

  private emitProgress(messageId: string, progress: ResearchProgress) {
    this.send({ type: 'RESEARCH_PROGRESS', messageId, progress });
  }

  private send(message: ResearchRuntimeMessage) {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  }
}
