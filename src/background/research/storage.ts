import { openDB, type DBSchema } from 'idb';
import type { ResearchJob } from '@/shared/types';
import { evaluateLinkSafety } from '@/shared/link-safety';

interface ResearchDatabase extends DBSchema {
  jobs: {
    key: string;
    value: ResearchJob;
    indexes: { 'by-status': ResearchJob['status'] };
  };
}

const database = openDB<ResearchDatabase>('chrome-ai-research', 1, {
  upgrade(db) {
    const jobs = db.createObjectStore('jobs', { keyPath: 'id' });
    jobs.createIndex('by-status', 'status');
  },
});

export async function saveResearchJob(job: ResearchJob): Promise<void> {
  await (await database).put('jobs', job);
}

export async function getResearchJob(jobId: string): Promise<ResearchJob | undefined> {
  const job = await (await database).get('jobs', jobId);
  return job ? normalizeResearchJob(job) : undefined;
}

export async function getResumableResearchJobs(): Promise<ResearchJob[]> {
  const db = await database;
  const queued = await db.getAllFromIndex('jobs', 'by-status', 'queued');
  const running = await db.getAllFromIndex('jobs', 'by-status', 'running');
  return [...queued, ...running].map(normalizeResearchJob);
}

function normalizeResearchJob(job: ResearchJob) {
  job.tasks.forEach(task => {
    const legacyLabel =
      'ticketKey' in task && typeof task.ticketKey === 'string' ? task.ticketKey : undefined;
    const legacyUrl =
      'ticketUrl' in task && typeof task.ticketUrl === 'string' ? task.ticketUrl : undefined;
    task.label ||= legacyLabel || task.title;
    task.sourceUrl ||= legacyUrl || task.pendingSources[0]?.url || '';
    task.phase ||= task.status === 'running' ? 'opening' : task.status;
    task.phaseStartedAt ||= job.updatedAt;
    task.lastActivityAt ||= job.updatedAt;
    task.reasoning ||= [];
    task.linkVisits ||= [];
    task.relatedSourcesRead ||= 0;
    task.relatedSourcesAttempted ||= 0;
    task.pendingSources = task.pendingSources.filter(source => {
      if (!evaluateLinkSafety({ url: source.url, text: source.title }).safe) {
        task.decisions.push({
          url: source.url,
          title: source.title,
          outcome: 'discarded',
          reason: 'blocked-unsafe-action',
          depth: source.depth,
          timestamp: Date.now(),
        });
        if (source.depth === 0) {
          task.status = 'skipped';
          task.phase = 'skipped';
        }
        return false;
      }
      if (source.depth === 0 || typeof source.score === 'number') return true;
      task.decisions.push({
        url: source.url,
        title: source.title,
        outcome: 'skipped',
        reason: 'legacy-unscored-pending-source',
        depth: source.depth,
        timestamp: Date.now(),
      });
      return false;
    });
  });

  const progress = job.progress;
  progress.activeTaskIds ||= job.tasks
    .filter(task => task.status === 'running')
    .map(task => task.id);
  if (!Number.isFinite(progress.totalTasks)) {
    progress.totalTasks = readLegacyCount(progress, 'totalTickets') ?? job.tasks.length;
  }
  if (!Number.isFinite(progress.completedTasks)) {
    progress.completedTasks =
      readLegacyCount(progress, 'completedTickets') ??
      job.tasks.filter(task => task.status === 'completed').length;
  }
  if (!Number.isFinite(progress.failedTasks)) {
    progress.failedTasks =
      readLegacyCount(progress, 'failedTickets') ??
      job.tasks.filter(task => task.status === 'failed').length;
  }
  return job;
}

function readLegacyCount(
  progress: ResearchJob['progress'],
  key: 'totalTickets' | 'completedTickets' | 'failedTickets'
) {
  if (key === 'totalTickets' && 'totalTickets' in progress) {
    return typeof progress.totalTickets === 'number' ? progress.totalTickets : undefined;
  }
  if (key === 'completedTickets' && 'completedTickets' in progress) {
    return typeof progress.completedTickets === 'number' ? progress.completedTickets : undefined;
  }
  if (key === 'failedTickets' && 'failedTickets' in progress) {
    return typeof progress.failedTickets === 'number' ? progress.failedTickets : undefined;
  }
  return undefined;
}
