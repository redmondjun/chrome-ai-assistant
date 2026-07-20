import type { ModelRouter } from '../api/router';
import { classifyLinks } from '../pipeline/analyze';
import { extractResearchTasks } from './link-policy';
import { getResearchJob, saveResearchJob } from './storage';
import { synthesizeResearch } from './synthesis';
import { researchSubject, type SourceResult } from './research-worker';
import type {
  ResearchJob,
  ResearchProgress,
  ResearchTask,
  StorageSettings,
  TabContent,
} from '@/shared/types';

type ResearchRouter = Pick<ModelRouter, 'complete'>;

export interface ResearchCallbacks {
  onProgress: (progress: ResearchProgress) => void;
  onTaskUpdate?: (task: ResearchTask) => void;
  onAnswer: (answer: string) => void;
  onDone: () => void;
}

export async function createResearchJob(
  content: TabContent,
  question: string,
  messageId: string
): Promise<ResearchJob> {
  const tasks = extractResearchTasks(content.links);
  if (tasks.length === 0) {
    throw new Error(
      'Deep Research could not find researchable links in the readable page content.'
    );
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const progress: ResearchProgress = {
    jobId: id,
    status: 'queued',
    activity: `Found ${tasks.length} research subjects.`,
    totalTasks: tasks.filter(task => task.status !== 'skipped').length,
    completedTasks: 0,
    failedTasks: 0,
    activeWorkers: 0,
    sourcesRead: 0,
    sourcesFailed: 0,
    updatedAt: now,
    activeTaskIds: [],
  };
  const job: ResearchJob = {
    id,
    messageId,
    question,
    status: 'queued',
    tasks,
    progress,
    createdAt: now,
    updatedAt: now,
  };
  await saveResearchJob(job);
  return job;
}

export async function runResearchJob(
  router: ResearchRouter,
  jobId: string,
  settings: StorageSettings,
  callbacks: ResearchCallbacks,
  signal: AbortSignal
): Promise<void> {
  const job = await getResearchJob(jobId);
  if (!job || job.status === 'cancelled' || job.status === 'completed') return;

  prepareJob(job);
  updateProgress(job, { status: 'running', activity: 'Starting research workers...' }, callbacks);
  await saveResearchJob(job);
  await selectRelevantTasks(router, job, settings, callbacks, signal);

  const sourceCache = new Map<string, Promise<SourceResult>>();
  const queuedTasks = job.tasks.filter(task => task.status === 'queued');
  const workerCount = Math.min(
    Math.max(1, settings.research.workerConcurrency),
    queuedTasks.length
  );
  let cursor = 0;

  const worker = async () => {
    while (cursor < queuedTasks.length) {
      throwIfAborted(signal);
      if (job.status !== 'running') return;
      const task = queuedTasks[cursor++];
      task.status = 'running';
      setTaskPhase(task, 'opening');
      await persistProgress(
        job,
        task,
        {
          activeWorkers: countTasks(job, 'running'),
          activeTaskIds: activeTaskIds(job),
          activity: `Researching ${task.label}...`,
        },
        callbacks
      );
      try {
        await researchSubject({
          router,
          job,
          task,
          settings,
          sourceCache,
          onProgress: change => persistProgress(job, task, change, callbacks),
          signal,
        });
        task.status = 'completed';
        setTaskPhase(task, 'completed');
      } catch (error) {
        if (signal.aborted) throw error;
        task.status = 'failed';
        setTaskPhase(task, 'failed');
        task.error = error instanceof Error ? error.message : String(error);
      }
      await persistProgress(
        job,
        task,
        {
          completedTasks: countTasks(job, 'completed'),
          failedTasks: countTasks(job, 'failed'),
          activeWorkers: countTasks(job, 'running'),
          activeTaskIds: activeTaskIds(job),
          activity: `Finished ${task.label}.`,
        },
        callbacks
      );
    }
  };

  try {
    if (queuedTasks.length === 0) {
      throw new Error('Deep Research found no safe read-only sources to visit.');
    }
    await Promise.all(Array.from({ length: workerCount }, worker));
    throwIfAborted(signal);
    if (job.status !== 'running') return;

    updateProgress(
      job,
      { activeWorkers: 0, activity: 'Combining research findings...' },
      callbacks
    );
    job.finalAnswer = await synthesizeResearch(router, job, signal);
    job.status = 'completed';
    updateProgress(job, { status: 'completed', activity: 'Deep Research completed.' }, callbacks);
    await saveResearchJob(job);
    callbacks.onAnswer(job.finalAnswer);
    callbacks.onDone();
  } catch (error) {
    if (signal.aborted) return;
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
    updateProgress(job, { status: 'failed', activity: job.error }, callbacks);
    await saveResearchJob(job);
    throw error;
  }
}

export async function setResearchJobStatus(
  jobId: string,
  status: 'paused' | 'queued' | 'cancelled'
): Promise<ResearchJob | undefined> {
  const job = await getResearchJob(jobId);
  if (!job || job.status === 'completed') return job;
  job.status = status;
  job.progress = {
    ...job.progress,
    status,
    activeWorkers: 0,
    activeTaskIds: [],
    activity:
      status === 'paused'
        ? 'Research paused.'
        : status === 'cancelled'
          ? 'Research cancelled.'
          : 'Research queued to resume.',
    updatedAt: Date.now(),
  };
  job.updatedAt = Date.now();
  await saveResearchJob(job);
  return job;
}

export async function retryFailedResearchTasks(jobId: string): Promise<ResearchJob | undefined> {
  const job = await getResearchJob(jobId);
  if (!job) return undefined;
  let retryCount = 0;
  job.tasks.forEach(task => {
    if (task.status !== 'failed') return;
    retryCount++;
    resetFailedTask(task);
  });
  if (retryCount === 0) return job;
  job.status = 'queued';
  job.finalAnswer = undefined;
  job.progress = {
    ...job.progress,
    status: 'queued',
    failedTasks: 0,
    activity: `Retrying ${retryCount} failed research task${retryCount === 1 ? '' : 's'}...`,
    updatedAt: Date.now(),
  };
  job.updatedAt = Date.now();
  await saveResearchJob(job);
  return job;
}

function prepareJob(job: ResearchJob) {
  job.status = 'running';
  job.tasks.forEach(task => {
    if (task.status === 'running') task.status = 'queued';
    task.decisions ||= [];
    task.pendingSources ||= [{ url: task.sourceUrl, title: task.title, depth: 0 }];
    task.visitedUrls ||= [];
    task.phase ||= 'queued';
    task.phaseStartedAt ||= Date.now();
    task.lastActivityAt ||= task.phaseStartedAt;
    task.reasoning ||= [];
    task.linkVisits ||= [];
    task.relatedSourcesRead ||= 0;
    task.relatedSourcesAttempted ||= 0;
  });
}

function resetFailedTask(task: ResearchTask) {
  task.status = 'queued';
  setTaskPhase(task, 'queued');
  task.error = undefined;
  if (task.pendingSources.length > 0 || task.report) return;
  task.pendingSources = [{ url: task.sourceUrl, title: task.title, depth: 0 }];
  task.visitedUrls = [];
  task.evidence = [];
}

function countTasks(job: ResearchJob, status: ResearchTask['status']) {
  return job.tasks.filter(task => task.status === status).length;
}

function activeTaskIds(job: ResearchJob) {
  return job.tasks.filter(task => task.status === 'running').map(task => task.id);
}

async function selectRelevantTasks(
  router: ResearchRouter,
  job: ResearchJob,
  settings: StorageSettings,
  callbacks: ResearchCallbacks,
  signal: AbortSignal
) {
  const candidates = job.tasks.filter(
    task =>
      task.status === 'queued' &&
      task.visitedUrls.length === 0 &&
      !task.decisions.some(decision => decision.depth === 0)
  );
  if (candidates.length === 0) return;
  updateProgress(job, { activity: `Scoring ${candidates.length} research subjects...` }, callbacks);
  const links = candidates.map(task => ({
    url: task.sourceUrl,
    text: task.label,
    context: task.title,
    isExternal: true,
  }));
  const scores = requestsEverySubject(job.question)
    ? links.map(() => 1)
    : await classifyLinks(
        router,
        links,
        job.question,
        signal,
        thought => updateProgress(job, { activity: thought }, callbacks),
        settings.research.workerConcurrency
      );
  let selected = 0;
  candidates.forEach((task, index) => {
    const score = scores[index];
    const relevant = score > 0.3;
    task.decisions.push({
      url: task.sourceUrl,
      title: task.label,
      outcome: relevant ? 'selected' : 'skipped',
      reason: relevant ? 'relevant-seed-source' : 'seed-below-relevance-threshold',
      score,
      depth: 0,
      timestamp: Date.now(),
    });
    task.reasoning.push({
      step: 1,
      type: 'classify',
      thought: `Seed relevance: ${Math.round(score * 100)}%.`,
      timestamp: Date.now(),
    });
    if (relevant) selected++;
    else {
      task.status = 'skipped';
      setTaskPhase(task, 'skipped');
    }
  });
  if (selected === 0) {
    const best = candidates[scores.indexOf(Math.max(...scores))];
    best.status = 'queued';
    setTaskPhase(best, 'queued');
    const decision = best.decisions.at(-1);
    if (decision) {
      decision.outcome = 'selected';
      decision.reason = 'highest-ranked-seed-fallback';
    }
  }
  job.progress.totalTasks = job.tasks.filter(task => task.status !== 'skipped').length;
  job.progress.updatedAt = Date.now();
  job.updatedAt = job.progress.updatedAt;
  await saveResearchJob(job);
  callbacks.onProgress(job.progress);
}

function requestsEverySubject(question: string) {
  return /\b(?:visit|open|read|research|analy[sz]e|investigate)\s+(?:all|every)\b/i.test(question);
}

function setTaskPhase(task: ResearchTask, phase: ResearchTask['phase']) {
  const now = Date.now();
  task.phase = phase;
  task.phaseStartedAt = now;
  task.lastActivityAt = now;
  if (phase !== 'opening' && phase !== 'reading') task.currentSource = undefined;
}

function updateProgress(
  job: ResearchJob,
  change: Partial<ResearchProgress>,
  callbacks: ResearchCallbacks
) {
  job.progress = { ...job.progress, ...change, updatedAt: Date.now() };
  job.updatedAt = Date.now();
  callbacks.onProgress(job.progress);
}

async function persistProgress(
  job: ResearchJob,
  task: ResearchTask,
  change: Partial<ResearchProgress>,
  callbacks: ResearchCallbacks
) {
  job.progress = { ...job.progress, ...change, updatedAt: Date.now() };
  job.updatedAt = Date.now();
  await saveResearchJob(job);
  callbacks.onTaskUpdate?.(task);
  callbacks.onProgress(job.progress);
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
}
