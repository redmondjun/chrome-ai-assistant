import type { ModelRouter } from '../api/router';
import { classifyLinks } from '../pipeline/analyze';
import { extractResearchTasks } from './link-policy';
import { buildExpansionPlan } from './expansion-plan';
import { createResearchCheckpoint, setResearchStage, type ResearchCheckpoint } from './progress';
import { createSourceRegistry } from './source-registry';
import { getResearchJob, saveResearchJob } from './storage';
import { summarizeDiscoveryBatch, summarizeFinalBatch, synthesizeResearch } from './synthesis';
import { finalizeResearchSubject, scanResearchSeed } from './research-worker';
import { createPartialResearchAnswer } from './context';
import type {
  ResearchBatchSummary,
  ResearchEvidence,
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
  tasks.forEach(task => {
    task.seedStatus = task.status === 'skipped' ? 'failed' : 'queued';
    task.expansionStatus = task.status === 'skipped' ? 'skipped' : 'waiting';
    task.sourceKeys = [];
  });
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
    stage: 'seed-scan',
    currentBatch: 0,
    totalBatches: 0,
    seedsScanned: 0,
    subjectsExpanded: 0,
    uniqueSourcesOpened: 0,
    uniqueSourcesSucceeded: 0,
    uniqueSourcesFailed: 0,
    sourceCacheHits: 0,
    sourceRetries: 0,
    sourceBudgetUsed: 0,
    sourceBudgetTotal: 0,
    sourceBudgetOverflow: 0,
  };
  const job: ResearchJob = {
    id,
    messageId,
    question,
    status: 'queued',
    stage: 'seed-scan',
    currentBatch: 0,
    totalBatches: 0,
    batchSummaries: [],
    expansionPlan: [],
    sourceRegistry: [],
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

  prepareJob(job, settings);
  const checkpoint = createResearchCheckpoint(job, callbacks);
  const retrieveSource = createSourceRegistry({
    job,
    budget: job.sourceBudget || settings.research.maxUniqueSourcesPerJob,
    signal,
    checkpoint,
  });
  const getEvidence = (task: ResearchTask) =>
    (task.sourceKeys || [])
      .map(key => job.sourceRegistry?.find(source => source.key === key)?.evidence)
      .filter(evidence => evidence !== undefined);

  try {
    await checkpoint(undefined, 'Selecting research subjects...');
    await selectRelevantTasks(router, job, settings, checkpoint, signal);
    const selectedTasks = job.tasks.filter(task => task.status !== 'skipped');
    if (selectedTasks.length === 0) {
      job.partialAnswer = createPartialResearchAnswer(job);
      if (job.partialAnswer) {
        job.status = 'failed';
        job.error = 'Deep Research found no additional safe read-only sources to visit.';
        await checkpoint(undefined, job.error);
        callbacks.onAnswer(job.partialAnswer);
        callbacks.onDone();
        return;
      }
      throw new Error('Deep Research found no safe read-only sources to visit.');
    }

    await runSeedStage({
      router,
      job,
      tasks: selectedTasks,
      settings,
      retrieveSource,
      getEvidence,
      checkpoint,
      signal,
    });
    throwIfAborted(signal);

    setResearchStage(job, 'expansion-planning');
    await checkpoint(undefined, 'Planning selective related-source expansion...');
    buildExpansionPlan(job, settings);
    await checkpoint(undefined, `Planned ${job.expansionPlan?.length || 0} related-source reads.`);

    await runExpansionStage({
      router,
      job,
      tasks: selectedTasks.filter(task => task.seedStatus === 'completed'),
      settings,
      retrieveSource,
      getEvidence,
      checkpoint,
      signal,
    });
    throwIfAborted(signal);

    await runBatchSynthesis(router, job, selectedTasks, settings, checkpoint, signal);
    throwIfAborted(signal);

    setResearchStage(job, 'final-synthesis');
    await checkpoint(undefined, 'Combining compact batch summaries...');
    const synthesizedAnswer = await synthesizeResearch(
      router,
      job,
      settings.privacy.localOnly,
      signal,
      async (level, summaries) => {
        job.synthesisState = { level, summaries };
        await checkpoint(undefined, `Combining research summaries · level ${level}`);
      }
    );
    const failedSubjects = job.tasks.filter(task => task.status === 'failed').length;
    if (failedSubjects > 0) {
      job.status = 'failed';
      job.error = `${failedSubjects} of ${selectedTasks.length} research subjects failed. The available findings are partial.`;
      job.partialAnswer = synthesizedAnswer;
      job.finalAnswer = undefined;
    } else {
      job.status = 'completed';
      job.finalAnswer = synthesizedAnswer;
    }
    setResearchStage(job, 'completed');
    await checkpoint(undefined, failedSubjects > 0 ? job.error : 'Deep Research completed.');
    callbacks.onAnswer(synthesizedAnswer);
    callbacks.onDone();
  } catch (error) {
    if (signal.aborted) return;
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
    job.partialAnswer = createPartialResearchAnswer(job, job.error);
    await checkpoint(undefined, job.error);
    if (job.partialAnswer) {
      callbacks.onAnswer(job.partialAnswer);
      callbacks.onDone();
      return;
    }
    throw error;
  }
}

interface StageOptions {
  router: ResearchRouter;
  job: ResearchJob;
  tasks: ResearchTask[];
  settings: StorageSettings;
  retrieveSource: ReturnType<typeof createSourceRegistry>;
  getEvidence: (task: ResearchTask) => ResearchEvidence[];
  checkpoint: ResearchCheckpoint;
  signal: AbortSignal;
}

async function runSeedStage(options: StageOptions) {
  const { job, tasks, settings, checkpoint, signal } = options;
  setResearchStage(job, 'seed-scan');
  const batches = chunk(tasks, settings.research.subjectBatchSize);
  job.totalBatches = batches.length;
  for (let index = 0; index < batches.length; index++) {
    throwIfAborted(signal);
    const pending = batches[index].filter(task => task.seedStatus === 'queued');
    if (pending.length === 0 && findBatchSummary(job, index, 'discovery')) continue;
    job.currentBatch = index + 1;
    assignBatch(batches[index], index);
    await checkpoint(undefined, `Seed scan · batch ${index + 1} of ${batches.length}`);
    await runWorkerPool(pending, settings.research.workerConcurrency, async task => {
      try {
        await scanResearchSeed({ ...options, task, question: job.question });
      } catch (error) {
        if (signal.aborted) throw error;
        task.seedStatus = 'failed';
        task.status = 'failed';
        task.phase = 'failed';
        task.error = error instanceof Error ? error.message : String(error);
        await checkpoint(task, `${task.label}: seed scan failed`);
      }
    });
    if (!findBatchSummary(job, index, 'discovery')) {
      const summary = await summarizeDiscoveryBatch(
        options.router,
        job.question,
        batches[index],
        settings.privacy.localOnly,
        signal
      );
      addBatchSummary(job, index, 'discovery', batches[index], summary);
      await checkpoint(undefined, `Saved discovery summary for batch ${index + 1}.`);
    }
  }
}

async function runExpansionStage(options: StageOptions) {
  const { job, tasks, settings, checkpoint, signal } = options;
  setResearchStage(job, 'expansion');
  const batches = chunk(tasks, settings.research.subjectBatchSize);
  job.totalBatches = batches.length;
  for (let index = 0; index < batches.length; index++) {
    throwIfAborted(signal);
    const pending = batches[index].filter(task => task.status === 'queued');
    if (pending.length === 0) continue;
    job.currentBatch = index + 1;
    await checkpoint(undefined, `Expansion · batch ${index + 1} of ${batches.length}`);
    await runWorkerPool(pending, settings.research.workerConcurrency, async task => {
      const items = (job.expansionPlan || []).filter(
        item => item.taskId === task.id && item.status === 'planned'
      );
      try {
        await finalizeResearchSubject({ ...options, task, question: job.question }, items);
      } catch (error) {
        if (signal.aborted) throw error;
        task.status = 'failed';
        task.phase = 'failed';
        task.error = error instanceof Error ? error.message : String(error);
        await checkpoint(task, `${task.label}: final analysis failed`);
      }
    });
  }
}

async function runBatchSynthesis(
  router: ResearchRouter,
  job: ResearchJob,
  tasks: ResearchTask[],
  settings: StorageSettings,
  checkpoint: ResearchCheckpoint,
  signal: AbortSignal
) {
  setResearchStage(job, 'batch-synthesis');
  const completed = tasks.filter(task => task.status === 'completed' && task.report);
  const batches = chunk(completed, settings.research.subjectBatchSize);
  job.totalBatches = batches.length;
  for (let index = 0; index < batches.length; index++) {
    throwIfAborted(signal);
    job.currentBatch = index + 1;
    await checkpoint(undefined, `Batch synthesis · batch ${index + 1} of ${batches.length}`);
    if (findBatchSummary(job, index, 'final')) continue;
    const summary = await summarizeFinalBatch(
      router,
      job.question,
      batches[index],
      settings.privacy.localOnly,
      signal
    );
    addBatchSummary(job, index, 'final', batches[index], summary);
    job.partialAnswer = createPartialResearchAnswer(job);
    await checkpoint(undefined, `Saved final summary for batch ${index + 1}.`);
  }
}

async function selectRelevantTasks(
  router: ResearchRouter,
  job: ResearchJob,
  settings: StorageSettings,
  checkpoint: ResearchCheckpoint,
  signal: AbortSignal
) {
  const candidates = job.tasks.filter(
    task =>
      task.status === 'queued' &&
      task.seedStatus !== 'completed' &&
      !task.decisions.some(decision => decision.depth === 0)
  );
  if (candidates.length === 0) return;
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
        thought => void checkpoint(undefined, thought),
        settings.research.workerConcurrency
      );
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
      step: task.reasoning.length + 1,
      type: 'classify',
      thought: `Seed relevance: ${Math.round(score * 100)}%.`,
      timestamp: Date.now(),
    });
    if (!relevant) {
      task.status = 'skipped';
      task.phase = 'skipped';
      task.expansionStatus = 'skipped';
    }
  });
  const selected = candidates.filter(task => task.status !== 'skipped');
  if (selected.length === 0) {
    const best = candidates[scores.indexOf(Math.max(...scores))];
    best.status = 'queued';
    best.phase = 'queued';
    best.seedStatus = 'queued';
    best.expansionStatus = 'waiting';
    const decision = best.decisions.at(-1);
    if (decision) {
      decision.outcome = 'selected';
      decision.reason = 'highest-ranked-seed-fallback';
    }
  }
  await checkpoint(
    undefined,
    `Selected ${job.tasks.filter(task => task.status !== 'skipped').length} research subjects.`
  );
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
  const failed = job.tasks.filter(task => task.status === 'failed');
  if (failed.length === 0) return job;
  failed.forEach(task => {
    task.status = 'queued';
    task.phase = 'queued';
    task.error = undefined;
    if (task.seedStatus === 'failed') task.seedStatus = 'queued';
  });
  (job.sourceRegistry || []).forEach(source => {
    if (source.status === 'failed') {
      source.status = 'pending';
      source.retries++;
    }
  });
  const reusableSources = (job.sourceRegistry || []).filter(
    source => source.status === 'success' && source.evidence
  ).length;
  job.status = 'queued';
  job.stage = failed.some(task => task.seedStatus === 'queued') ? 'seed-scan' : 'expansion';
  job.finalAnswer = undefined;
  job.batchSummaries = (job.batchSummaries || []).filter(summary => summary.kind === 'discovery');
  job.expansionPlan = [];
  job.synthesisState = undefined;
  job.progress.status = 'queued';
  job.progress.activity = `Retrying ${failed.length} failed research subjects; reusing ${reusableSources} validated sources.`;
  job.updatedAt = Date.now();
  await saveResearchJob(job);
  return job;
}

function prepareJob(job: ResearchJob, settings: StorageSettings) {
  job.status = 'running';
  job.stage ||= 'seed-scan';
  job.batchSummaries ||= [];
  job.expansionPlan ||= [];
  job.sourceRegistry ||= [];
  if (job.sourceRegistry.length === 0 && job.tasks.every(task => task.seedStatus !== 'completed')) {
    job.sourceBudget = settings.research.maxUniqueSourcesPerJob;
  } else {
    job.sourceBudget ||= settings.research.maxUniqueSourcesPerJob;
  }
  job.tasks.forEach(task => {
    if (task.status === 'running') task.status = 'queued';
    task.decisions ||= [];
    task.pendingSources ||= [];
    task.visitedUrls ||= [];
    task.phase ||= 'queued';
    task.phaseStartedAt ||= Date.now();
    task.lastActivityAt ||= task.phaseStartedAt;
    task.reasoning ||= [];
    task.linkVisits ||= [];
    task.relatedSourcesRead ||= 0;
    task.relatedSourcesAttempted ||= 0;
    task.seedStatus ||= task.evidence.length > 0 || task.report ? 'completed' : 'queued';
    task.expansionStatus ||= task.report ? 'completed' : 'waiting';
    if (task.seedStatus === 'running') task.seedStatus = 'queued';
    if (task.expansionStatus === 'running') task.expansionStatus = 'planned';
    task.sourceKeys ||= [];
  });
}

async function runWorkerPool(
  tasks: ResearchTask[],
  concurrency: number,
  run: (task: ResearchTask) => Promise<void>
) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      await run(task);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), tasks.length) }, worker)
  );
}

function assignBatch(tasks: ResearchTask[], batchIndex: number) {
  tasks.forEach(task => {
    task.batchIndex = batchIndex;
  });
}

function addBatchSummary(
  job: ResearchJob,
  batchIndex: number,
  kind: ResearchBatchSummary['kind'],
  tasks: ResearchTask[],
  summary: string
) {
  job.batchSummaries ||= [];
  job.batchSummaries.push({
    batchIndex,
    kind,
    taskIds: tasks.map(task => task.id),
    summary,
    createdAt: Date.now(),
  });
}

function findBatchSummary(
  job: ResearchJob,
  batchIndex: number,
  kind: ResearchBatchSummary['kind']
) {
  return job.batchSummaries?.find(
    summary => summary.batchIndex === batchIndex && summary.kind === kind
  );
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += Math.max(1, size)) {
    chunks.push(items.slice(start, start + Math.max(1, size)));
  }
  return chunks;
}

function requestsEverySubject(question: string) {
  return /\b(?:visit|open|read|research|analy[sz]e|investigate)\s+(?:all|every)\b/i.test(question);
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
}
