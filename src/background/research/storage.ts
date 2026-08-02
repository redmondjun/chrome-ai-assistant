import { openDB, type DBSchema } from 'idb';
import { validateRetrievedPage } from '../content/retrieved-page';
import { createPartialResearchAnswer } from './context';
import type { ResearchJob, ResearchSourceRecord } from '@/shared/types';
import { evaluateLinkSafety } from '@/shared/link-safety';
import { canonicalizeUrl } from './link-policy';

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

const pendingWrites = new Map<string, Promise<void>>();

export async function saveResearchJob(job: ResearchJob): Promise<void> {
  const snapshot = structuredClone(job);
  const previousWrite = pendingWrites.get(job.id) || Promise.resolve();
  const write = previousWrite
    .catch(() => undefined)
    .then(async () => {
      await (await database).put('jobs', snapshot);
    });
  pendingWrites.set(job.id, write);
  try {
    await write;
  } finally {
    if (pendingWrites.get(job.id) === write) {
      pendingWrites.delete(job.id);
    }
  }
}

export async function getResearchJob(jobId: string): Promise<ResearchJob | undefined> {
  await pendingWrites.get(jobId);
  const job = await (await database).get('jobs', jobId);
  return job ? normalizeResearchJob(job) : undefined;
}

export async function getResumableResearchJobs(): Promise<ResearchJob[]> {
  await Promise.all(pendingWrites.values());
  const db = await database;
  const queued = await db.getAllFromIndex('jobs', 'by-status', 'queued');
  const running = await db.getAllFromIndex('jobs', 'by-status', 'running');
  return [...queued, ...running].map(normalizeResearchJob);
}

export function normalizeResearchJob(job: ResearchJob) {
  job.stage ||= job.status === 'completed' ? 'completed' : 'seed-scan';
  job.currentBatch ||= 0;
  job.totalBatches ||= 0;
  job.batchSummaries ||= [];
  job.expansionPlan ||= [];
  job.sourceRegistry ||= [];
  job.sourceBudget ||= 1000;
  job.sourceRegistry.forEach(source => {
    source.taskIds ||= [];
    source.retries ||= 0;
    source.cacheHits ||= 0;
    source.createdAt ||= job.createdAt;
    source.updatedAt ||= job.updatedAt;
    if (source.status === 'fetching') source.status = 'pending';
  });
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
    task.decisions ||= [];
    task.pendingSources ||= [];
    task.visitedUrls ||= [];
    task.evidence ||= [];
    task.relatedSourcesRead ||= 0;
    task.relatedSourcesAttempted ||= 0;
    task.sourceKeys ||= [];
    task.seedStatus ||=
      task.report ||
      task.evidence.length > 0 ||
      task.linkVisits.some(visit => visit.status === 'success')
        ? 'completed'
        : task.status === 'failed'
          ? 'failed'
          : 'queued';
    task.expansionStatus ||= task.report
      ? 'completed'
      : task.relatedSourcesAttempted > 0
        ? 'planned'
        : 'waiting';
    migrateTaskSources(job, task);
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
  normalizeUnverifiableLegacySources(job);
  invalidateRejectedLegacyEvidence(job);
  synchronizeTaskVisits(job);
  if (job.status === 'failed' && !job.finalAnswer && !job.partialAnswer) {
    job.partialAnswer = createPartialResearchAnswer(job);
  }

  const progress = job.progress;
  progress.status = job.status;
  if (job.error && job.status === 'failed') progress.activity = job.error;
  progress.activeTaskIds ||= job.tasks
    .filter(task => task.status === 'running')
    .map(task => task.id);
  progress.totalTasks = job.tasks.filter(task => task.status !== 'skipped').length;
  progress.completedTasks = job.tasks.filter(task => task.status === 'completed').length;
  progress.failedTasks = job.tasks.filter(task => task.status === 'failed').length;
  const registry = job.sourceRegistry;
  const sourceBudgetOverflow = Math.max(0, registry.length - job.sourceBudget);
  job.sourceBudgetOverflow = sourceBudgetOverflow;
  const succeeded = registry.filter(
    source => source.status === 'success' && source.evidence
  ).length;
  const failed = registry.filter(source => source.status === 'failed').length;
  progress.stage = job.stage;
  progress.currentBatch = job.currentBatch;
  progress.totalBatches = job.totalBatches;
  progress.seedsScanned = job.tasks.filter(task => task.seedStatus === 'completed').length;
  progress.subjectsExpanded = job.tasks.filter(task => task.relatedSourcesAttempted > 0).length;
  progress.uniqueSourcesOpened = registry.filter(source => source.status !== 'pending').length;
  progress.uniqueSourcesSucceeded = succeeded;
  progress.uniqueSourcesFailed = failed;
  progress.sourceCacheHits = registry.reduce((total, source) => total + source.cacheHits, 0);
  progress.sourceRetries = registry.reduce((total, source) => total + source.retries, 0);
  progress.sourceBudgetUsed = Math.min(registry.length, job.sourceBudget);
  progress.sourceBudgetTotal = job.sourceBudget;
  progress.sourceBudgetOverflow = sourceBudgetOverflow;
  progress.sourcesRead = succeeded;
  progress.sourcesFailed = failed;
  return job;
}

function normalizeUnverifiableLegacySources(job: ResearchJob) {
  job.sourceRegistry?.forEach(source => {
    if (source.status !== 'success' || source.evidence) return;
    source.status = 'failed';
    source.error = 'The legacy source has no persisted readable evidence.';
    source.failureReason = 'retrieval-failed';
    source.updatedAt = Date.now();
  });
}

function synchronizeTaskVisits(job: ResearchJob) {
  job.tasks.forEach(task => {
    task.linkVisits.forEach(visit => {
      const source = job.sourceRegistry?.find(record => record.key === canonicalizeUrl(visit.url));
      if (!source || source.status !== 'failed') return;
      visit.status = 'failed';
      visit.error = source.error;
      visit.failureReason = source.failureReason;
    });
  });
}

function invalidateRejectedLegacyEvidence(job: ResearchJob) {
  const rejectedKeys = new Set<string>();
  const rejectedDepths = new Map<string, number>();
  job.sourceRegistry?.forEach(source => {
    if (source.status !== 'success' || !source.evidence) return;
    const validation = validateRetrievedPage({
      content: source.evidence.excerpt,
      title: source.evidence.title,
      url: source.evidence.url,
    });
    if (validation.valid) return;
    source.status = 'failed';
    source.error = validation.message;
    source.failureReason = validation.reason;
    rejectedDepths.set(source.key, source.evidence.depth);
    source.evidence = undefined;
    source.updatedAt = Date.now();
    rejectedKeys.add(source.key);
  });
  if (rejectedKeys.size === 0) return;

  job.finalAnswer = undefined;
  job.partialAnswer = undefined;
  job.batchSummaries = [];
  job.expansionPlan = [];
  job.synthesisState = undefined;
  job.status = 'failed';
  job.error =
    'Stored research included inaccessible page content. Affected reports were invalidated.';

  job.tasks.forEach(task => {
    const rejectedTaskKeys = (task.sourceKeys || []).filter(key => rejectedKeys.has(key));
    if (rejectedTaskKeys.length === 0) return;
    task.evidence = task.evidence.filter(
      evidence => !rejectedKeys.has(canonicalizeUrl(evidence.url))
    );
    rejectedTaskKeys.forEach(key => {
      const source = job.sourceRegistry?.find(record => record.key === key);
      if (
        source &&
        !task.decisions.some(
          decision =>
            canonicalizeUrl(decision.url) === key && decision.reason === source.failureReason
        )
      ) {
        task.decisions.push({
          url: source.url,
          title: source.title,
          outcome: 'failed',
          reason: source.failureReason || 'invalid-page-content',
          depth: rejectedDepths.get(key) || 0,
          timestamp: Date.now(),
        });
      }
    });
    if (task.report) {
      task.report = undefined;
      task.status = 'queued';
      task.phase = 'queued';
      task.expansionStatus = 'waiting';
      task.error =
        'The previous report used source content that is now classified as inaccessible.';
    }
    const seedKey = canonicalizeUrl(task.sourceUrl);
    if (rejectedKeys.has(seedKey)) {
      task.seedStatus = 'failed';
      task.status = 'failed';
      task.phase = 'failed';
    }
  });
}

function migrateTaskSources(job: ResearchJob, task: ResearchJob['tasks'][number]) {
  task.linkVisits.forEach(visit => {
    const key = canonicalizeUrl(visit.url);
    let record = job.sourceRegistry?.find(source => source.key === key);
    const evidence = task.evidence.find(item => canonicalizeUrl(item.url) === key);
    const status =
      visit.status === 'success' ? 'success' : visit.status === 'failed' ? 'failed' : 'pending';
    if (!record) {
      const created: ResearchSourceRecord = {
        key,
        url: visit.url,
        title: visit.title,
        status,
        taskIds: [task.id],
        evidence,
        error: visit.error,
        retries: 0,
        cacheHits: 0,
        createdAt: visit.timestamp,
        updatedAt: visit.timestamp,
      };
      job.sourceRegistry?.push(created);
      record = created;
    } else {
      if (!record.taskIds.includes(task.id)) record.taskIds.push(task.id);
      if (!record.evidence && evidence) record.evidence = evidence;
      if (record.status === 'pending' && status !== 'pending') record.status = status;
    }
    if (!task.sourceKeys?.includes(key)) task.sourceKeys?.push(key);
  });
  job.sourceRegistry?.forEach(source => {
    if (source.status === 'fetching') source.status = 'pending';
  });
}
