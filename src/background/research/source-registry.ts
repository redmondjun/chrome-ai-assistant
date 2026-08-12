import { fetchLinkContentInTab } from '../content/link-tab-fetcher';
import { validateRetrievedPage } from '../content/retrieved-page';
import { canonicalizeUrl, categorizeSource } from './link-policy';
import { evaluateLinkSafety } from '@/shared/link-safety';
import type {
  LinkInfo,
  ResearchEvidence,
  ResearchJob,
  ResearchSourceRecord,
  ResearchTask,
  SourceFailureReason,
} from '@/shared/types';

const SOURCE_EXCERPT_LIMIT = 12000;
const MAX_SOURCE_RETRIES = 1;

export interface ResearchSourceInput {
  url: string;
  title: string;
  depth: number;
  score?: number;
}

export interface RetrievedResearchSource {
  evidence?: ResearchEvidence;
  links: LinkInfo[];
  error?: string;
  failureReason?: SourceFailureReason;
  cacheHit: boolean;
  budgetExceeded?: boolean;
}

interface SourceRegistryOptions {
  job: ResearchJob;
  budget: number;
  signal: AbortSignal;
  checkpoint: (task?: ResearchTask, activity?: string) => Promise<void>;
  reusableSources?: Array<{ source: ResearchSourceRecord; jobId: string }>;
}

export function createSourceRegistry(options: SourceRegistryOptions) {
  const { job, budget, signal, checkpoint, reusableSources = [] } = options;
  const reusableByKey = new Map(reusableSources.map(item => [item.source.key, item]));
  const activeFetches = new Map<string, Promise<RetrievedResearchSource>>();

  return async (task: ResearchTask, source: ResearchSourceInput) => {
    const safety = evaluateLinkSafety({ url: source.url, text: source.title });
    if (!safety.safe) {
      return resultError(`Blocked unsafe action URL. ${safety.reason || ''}`);
    }

    const key = canonicalizeUrl(source.url);
    let record = job.sourceRegistry?.find(item => item.key === key);
    if (record) addTaskOwner(record, task.id);

    if (!record) {
      const reusable = reusableByKey.get(key);
      const reusableEvidence = reusable?.source.evidence;
      if (reusable && reusableEvidence) {
        const now = Date.now();
        record = {
          ...reusable.source,
          taskIds: [task.id],
          evidence: { ...reusableEvidence },
          retries: 0,
          cacheHits: 1,
          reusedFromJobId: reusable.jobId,
          createdAt: now,
          updatedAt: now,
        };
        job.sourceRegistry ||= [];
        job.sourceRegistry.push(record);
        addTaskSource(task, key);
        await checkpoint(task, `${task.label}: reused ${record.title} from prior research`);
        return {
          evidence: withDepth(reusableEvidence, source.depth),
          links: [],
          cacheHit: true,
        };
      }
    }

    if (record?.status === 'success' && record.evidence) {
      addTaskSource(task, key);
      record.cacheHits++;
      record.updatedAt = Date.now();
      await checkpoint(task, `${task.label}: reused ${record.title}`);
      return {
        evidence: withDepth(record.evidence, source.depth),
        links: [],
        cacheHit: true,
      };
    }

    const active = activeFetches.get(key);
    if (active) {
      addTaskSource(task, key);
      if (record) {
        record.cacheHits++;
        record.updatedAt = Date.now();
      }
      const result = await active;
      await checkpoint(task, `${task.label}: reused shared source ${source.title}`);
      return result.evidence
        ? { ...result, evidence: withDepth(result.evidence, source.depth), cacheHit: true }
        : { ...result, cacheHit: true };
    }

    if (
      record?.status === 'failed' &&
      (record.retries >= MAX_SOURCE_RETRIES || isPermanentFailure(record.failureReason))
    ) {
      addTaskSource(task, key);
      record.cacheHits++;
      record.updatedAt = Date.now();
      await checkpoint(task, `${task.label}: reused failed source result`);
      return {
        ...resultError(
          record.error || 'Source retrieval failed.',
          record.failureReason || 'retrieval-failed'
        ),
        cacheHit: true,
      };
    }

    if (!record) {
      if (countNewSources(job.sourceRegistry || []) >= budget) {
        return {
          ...resultError('Global source budget exhausted.', 'source-budget-exhausted'),
          budgetExceeded: true,
        };
      }
      const now = Date.now();
      record = {
        key,
        url: source.url,
        title: source.title,
        status: 'pending',
        taskIds: [task.id],
        retries: 0,
        cacheHits: 0,
        createdAt: now,
        updatedAt: now,
      };
      job.sourceRegistry ||= [];
      job.sourceRegistry.push(record);
    } else if (record.status === 'failed') {
      record.retries++;
    }
    addTaskSource(task, key);

    const sourceRecord = record;
    const fetchPromise = fetchAndRecord(sourceRecord, source, signal, checkpoint, task);
    activeFetches.set(key, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      activeFetches.delete(key);
    }
  };
}

function countNewSources(sources: ResearchSourceRecord[]): number {
  return sources.filter(source => !source.reusedFromJobId).length;
}

async function fetchAndRecord(
  record: ResearchSourceRecord,
  source: ResearchSourceInput,
  signal: AbortSignal,
  checkpoint: SourceRegistryOptions['checkpoint'],
  task: ResearchTask
): Promise<RetrievedResearchSource> {
  record.status = 'fetching';
  record.error = undefined;
  record.failureReason = undefined;
  record.updatedAt = Date.now();
  await checkpoint(task, `${task.label}: opening ${source.title || source.url}`);

  const fetched = await fetchLinkContentInTab(source.url, signal);
  if (!fetched.content) {
    record.status = 'failed';
    record.error = fetched.error || 'No readable content.';
    record.failureReason = fetched.failureReason || 'retrieval-failed';
    record.updatedAt = Date.now();
    await checkpoint(task, `${task.label}: source failed`);
    return resultError(record.error, record.failureReason);
  }
  const validation = validateRetrievedPage({
    content: fetched.content,
    title: fetched.title || source.title,
    url: fetched.finalUrl || source.url,
  });
  if (!validation.valid) {
    record.status = 'failed';
    record.error = validation.message;
    record.failureReason = validation.reason;
    record.updatedAt = Date.now();
    await checkpoint(task, `${task.label}: source rejected (${validation.reason})`);
    return resultError(validation.message, validation.reason);
  }

  const evidence: ResearchEvidence = {
    url: fetched.finalUrl || source.url,
    title: fetched.title || source.title || source.url,
    category: categorizeSource(source.url, fetched.title || source.title || ''),
    excerpt: createResearchExcerpt(fetched.content),
    depth: source.depth,
  };
  record.status = 'success';
  record.title = evidence.title;
  record.evidence = evidence;
  record.failureReason = undefined;
  record.updatedAt = Date.now();
  await checkpoint(task, `${task.label}: read ${evidence.title}`);
  return { evidence, links: fetched.links || [], cacheHit: false };
}

function createResearchExcerpt(content: string): string {
  if (content.length <= SOURCE_EXCERPT_LIMIT) return content;
  const half = SOURCE_EXCERPT_LIMIT / 2;
  return `${content.slice(0, half)}\n\n[...middle omitted...]\n\n${content.slice(-half)}`;
}

function addTaskOwner(record: ResearchSourceRecord, taskId: string) {
  if (!record.taskIds.includes(taskId)) record.taskIds.push(taskId);
}

function addTaskSource(task: ResearchTask, key: string) {
  task.sourceKeys ||= [];
  if (!task.sourceKeys.includes(key)) task.sourceKeys.push(key);
}

function withDepth(evidence: ResearchEvidence, depth: number): ResearchEvidence {
  return { ...evidence, depth };
}

function resultError(
  error: string,
  failureReason: SourceFailureReason = 'retrieval-failed'
): RetrievedResearchSource {
  return { links: [], error, failureReason, cacheHit: false };
}

function isPermanentFailure(reason?: SourceFailureReason) {
  return reason !== undefined && !['retrieval-failed', 'source-budget-exhausted'].includes(reason);
}
