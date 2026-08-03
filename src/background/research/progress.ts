import { saveResearchJob } from './storage';
import type { ResearchJob, ResearchProgress, ResearchTask } from '@/shared/types';

interface ProgressCallbacks {
  onProgress: (progress: ResearchProgress) => void;
  onTaskUpdate?: (task: ResearchTask) => void;
}

export type ResearchCheckpoint = (task?: ResearchTask, activity?: string) => Promise<void>;

export function createResearchCheckpoint(
  job: ResearchJob,
  callbacks: ProgressCallbacks
): ResearchCheckpoint {
  let writes = Promise.resolve();
  return (task, activity) => {
    if (activity) job.progress.activity = activity;
    deriveResearchProgress(job);
    const updatedAt = Date.now();
    job.updatedAt = updatedAt;
    job.progress.updatedAt = updatedAt;
    const snapshot = structuredClone(job);
    const taskSnapshot = task
      ? snapshot.tasks.find(candidate => candidate.id === task.id)
      : undefined;
    writes = writes.then(async () => {
      await saveResearchJob(snapshot);
      if (taskSnapshot) callbacks.onTaskUpdate?.(taskSnapshot);
      callbacks.onProgress(snapshot.progress);
    });
    return writes;
  };
}

export function deriveResearchProgress(job: ResearchJob) {
  const registry = job.sourceRegistry || [];
  const active = job.tasks.filter(task => task.status === 'running');
  const succeeded = registry.filter(
    source => source.status === 'success' && source.evidence
  ).length;
  const failed = registry.filter(source => source.status === 'failed').length;
  const sourceBudget = job.sourceBudget || 0;
  const sourceBudgetOverflow = Math.max(0, registry.length - sourceBudget);
  job.sourceBudgetOverflow = sourceBudgetOverflow;
  job.progress = {
    ...job.progress,
    status: job.status,
    stage: job.stage,
    currentBatch: job.currentBatch,
    totalBatches: job.totalBatches,
    totalTasks: job.tasks.filter(task => task.status !== 'skipped').length,
    completedTasks: job.tasks.filter(task => task.status === 'completed').length,
    failedTasks: job.tasks.filter(task => task.status === 'failed').length,
    activeWorkers: active.length,
    activeTaskIds: active.map(task => task.id),
    seedsScanned: job.tasks.filter(task => task.seedStatus === 'completed').length,
    subjectsExpanded: job.tasks.filter(task => task.relatedSourcesAttempted > 0).length,
    uniqueSourcesOpened: registry.filter(source => source.status !== 'pending').length,
    uniqueSourcesSucceeded: succeeded,
    uniqueSourcesFailed: failed,
    sourceCacheHits: registry.reduce((total, source) => total + source.cacheHits, 0),
    sourceRetries: registry.reduce((total, source) => total + source.retries, 0),
    sourceBudgetUsed: Math.min(registry.length, sourceBudget),
    sourceBudgetTotal: sourceBudget,
    sourceBudgetOverflow,
    sourcesRead: succeeded,
    sourcesFailed: failed,
  };
}

export function setResearchStage(job: ResearchJob, stage: NonNullable<ResearchJob['stage']>) {
  job.stage = stage;
  job.progress.stage = stage;
}
