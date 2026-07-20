import type { ModelRouter } from '../api/router';
import { fetchLinkContentInTab } from '../content/link-tab-fetcher';
import { classifyLinks } from '../pipeline/analyze';
import { canonicalizeUrl, categorizeSource, isEvidenceLink } from './link-policy';
import { evaluateLinkSafety } from '@/shared/link-safety';
import type {
  LinkInfo,
  ResearchEvidence,
  ResearchJob,
  ResearchProgress,
  ResearchTask,
  StorageSettings,
} from '@/shared/types';

const SOURCE_EXCERPT_LIMIT = 6000;
const RELEVANCE_THRESHOLD = 0.3;
type ResearchRouter = Pick<ModelRouter, 'complete'>;

export interface SourceResult {
  evidence?: ResearchEvidence;
  links: LinkInfo[];
  error?: string;
}

interface ResearchWorkerOptions {
  router: ResearchRouter;
  job: ResearchJob;
  task: ResearchTask;
  settings: StorageSettings;
  sourceCache: Map<string, Promise<SourceResult>>;
  onProgress: (change: Partial<ResearchProgress>) => Promise<void>;
  signal: AbortSignal;
}

export async function researchSubject(options: ResearchWorkerOptions) {
  const { router, job, task, settings, sourceCache, onProgress, signal } = options;
  const queue = [...task.pendingSources];
  const visited = new Set(task.visitedUrls);

  while (queue.length > 0) {
    throwIfAborted(signal);
    const source = queue.shift();
    if (!source) break;
    task.pendingSources = [...queue];
    const safety = evaluateLinkSafety({ url: source.url, text: source.title });
    if (!safety.safe) {
      recordDecision(task, source, 'discarded', 'blocked-unsafe-action', source.score);
      addReasoning(task, 'classify', `Blocked unsafe action link: ${source.title}.`);
      await checkpoint(task, onProgress, `${task.label}: blocked unsafe action link`);
      continue;
    }
    const canonicalUrl = canonicalizeUrl(source.url);
    if (visited.has(canonicalUrl)) {
      recordDecision(task, source, 'discarded', 'duplicate-source');
      await checkpoint(task, onProgress);
      continue;
    }
    if (
      source.depth > 0 &&
      task.relatedSourcesAttempted >= settings.research.maxRelatedSourcesPerTask
    ) {
      recordDecision(task, source, 'skipped', 'related-source-budget-exhausted', source.score);
      await checkpoint(task, onProgress);
      continue;
    }

    visited.add(canonicalUrl);
    task.visitedUrls = [...visited];
    if (source.depth > 0) task.relatedSourcesAttempted++;
    recordDecision(
      task,
      source,
      'selected',
      source.depth === 0 ? 'seed-source' : 'ai-ranked-related-source',
      source.score
    );
    task.linkVisits.push({
      url: source.url,
      title: source.title,
      status: 'fetching',
      relevanceScore: source.score ?? 1,
      timestamp: Date.now(),
      depth: source.depth,
      method: 'browser-tab',
    });
    setPhase(task, 'opening', source);
    addReasoning(
      task,
      'fetch',
      `Opening depth ${source.depth} source: ${source.title || source.url}`
    );
    await checkpoint(task, onProgress, `${task.label}: opening ${source.title || source.url}`);

    const sourcePromise =
      sourceCache.get(canonicalUrl) || readSource(source.url, source.depth, signal);
    sourceCache.set(canonicalUrl, sourcePromise);
    const result = await sourcePromise;
    const visit = task.linkVisits.at(-1);
    setPhase(task, 'reading', source);
    if (result.evidence) {
      task.evidence.push(result.evidence);
      if (source.depth > 0) task.relatedSourcesRead++;
      if (visit) visit.status = 'success';
      addReasoning(task, 'extract', `Read ${result.evidence.title}.`);
      await checkpoint(task, onProgress, `${task.label}: read ${result.evidence.title}`, {
        sourcesRead: job.progress.sourcesRead + 1,
      });
    } else {
      const reason = result.error || 'No readable content.';
      if (visit) {
        visit.status = 'failed';
        visit.error = reason;
      }
      recordDecision(task, source, 'failed', reason, source.score);
      addReasoning(task, 'extract', `Could not read ${source.title}: ${reason}`);
      await checkpoint(task, onProgress, `${task.label}: source failed`, {
        sourcesFailed: job.progress.sourcesFailed + 1,
      });
    }

    if (result.evidence && source.depth < settings.links.maxDepth && result.links.length > 0) {
      await scoreDiscoveredLinks(options, result.links, source.depth + 1, queue, visited);
    }
    task.pendingSources = [...queue];
    await checkpoint(task, onProgress);
    if (settings.links.rateLimitMs > 0) await delay(settings.links.rateLimitMs, signal);
  }

  if (task.evidence.length === 0)
    throw new Error(`No readable evidence was collected for ${task.label}.`);
  setPhase(task, 'analyzing');
  addReasoning(task, 'synthesize', `Analyzing ${task.evidence.length} readable sources.`);
  await checkpoint(task, onProgress, `${task.label}: analyzing collected evidence`);
  const evidencePrompt = task.evidence
    .map((item, index) => `SOURCE ${index + 1}: ${item.title}\nURL: ${item.url}\n${item.excerpt}`)
    .join('\n\n');
  const result = await router.complete(
    job.question,
    { hasLinks: true, contentLength: evidencePrompt.length },
    `You are one research worker. Analyze the subject "${task.label}" and its related sources only for this user request:\n${job.question}\n\nExtract the facts, relationships, evidence, uncertainty, and details that help answer the request. Cite every claim with its source URL.\n\n${evidencePrompt}`,
    { temperature: 0.2, maxTokens: 1800, signal }
  );
  task.report = result.text;
  addReasoning(task, 'answer', 'Worker report completed.');
  await checkpoint(task, onProgress);
}

async function scoreDiscoveredLinks(
  { router, job, task, settings, onProgress, signal }: ResearchWorkerOptions,
  links: LinkInfo[],
  depth: number,
  queue: ResearchTask['pendingSources'],
  visited: Set<string>
) {
  const candidates = links.filter(link => {
    if (!evaluateLinkSafety(link).safe) {
      recordDecision(
        task,
        { url: link.url, title: link.text || link.url, depth },
        'discarded',
        'blocked-unsafe-action'
      );
      return false;
    }
    if (!isEvidenceLink(link) || isBlockedDomain(link.url, settings.links.blockedDomains)) {
      recordDecision(
        task,
        { url: link.url, title: link.text || link.url, depth },
        'discarded',
        'navigation-invalid-or-blocked'
      );
      return false;
    }
    const canonicalUrl = canonicalizeUrl(link.url);
    if (
      visited.has(canonicalUrl) ||
      queue.some(source => canonicalizeUrl(source.url) === canonicalUrl)
    ) {
      recordDecision(
        task,
        { url: link.url, title: link.text || link.url, depth },
        'discarded',
        'duplicate-source'
      );
      return false;
    }
    return true;
  });
  if (candidates.length === 0) return;

  setPhase(task, 'scoring');
  addReasoning(task, 'classify', `Scoring ${candidates.length} discovered links for relevance.`);
  await checkpoint(task, onProgress, `${task.label}: scoring ${candidates.length} related links`);
  const scores = await classifyLinks(
    router,
    candidates,
    `${job.question}\nResearch subject: ${task.label}`,
    signal,
    thought => {
      addReasoning(task, 'classify', thought);
      void checkpoint(task, onProgress, `${task.label}: ${thought}`).catch(() => undefined);
    }
  );
  const ranked = candidates
    .map((link, index) => ({ link, score: scores[index] }))
    .sort((a, b) => b.score - a.score);
  const remaining = Math.max(
    0,
    settings.research.maxRelatedSourcesPerTask -
      task.relatedSourcesAttempted -
      queue.filter(source => source.depth > 0).length
  );
  let selected = 0;
  ranked.forEach(({ link, score }) => {
    const source = { url: link.url, title: link.text || link.url, depth, score };
    if (score <= RELEVANCE_THRESHOLD)
      recordDecision(task, source, 'discarded', 'below-relevance-threshold', score);
    else if (selected >= remaining)
      recordDecision(task, source, 'skipped', 'related-source-budget-limit', score);
    else {
      queue.push(source);
      selected++;
    }
  });
  addReasoning(task, 'classify', `Selected ${selected} of ${candidates.length} discovered links.`);
  await checkpoint(task, onProgress);
}

async function checkpoint(
  task: ResearchTask,
  onProgress: ResearchWorkerOptions['onProgress'],
  activity?: string,
  change: Partial<ResearchProgress> = {}
) {
  task.lastActivityAt = Date.now();
  await onProgress({ ...change, ...(activity ? { activity } : {}) });
}

function setPhase(
  task: ResearchTask,
  phase: ResearchTask['phase'],
  currentSource?: ResearchTask['currentSource']
) {
  task.phase = phase;
  task.phaseStartedAt = Date.now();
  task.lastActivityAt = task.phaseStartedAt;
  task.currentSource = currentSource;
}

function addReasoning(
  task: ResearchTask,
  type: ResearchTask['reasoning'][number]['type'],
  thought: string
) {
  task.reasoning.push({ step: task.reasoning.length + 1, type, thought, timestamp: Date.now() });
}

function recordDecision(
  task: ResearchTask,
  source: { url: string; title: string; depth: number },
  outcome: ResearchTask['decisions'][number]['outcome'],
  reason: string,
  score?: number
) {
  task.decisions.push({ ...source, outcome, reason, score, timestamp: Date.now() });
}

async function readSource(url: string, depth: number, signal: AbortSignal): Promise<SourceResult> {
  const fetched = await fetchLinkContentInTab(url, signal);
  if (!fetched.content) return { links: [], error: fetched.error || 'No readable content.' };
  return {
    evidence: {
      url: fetched.finalUrl || url,
      title: fetched.title || url,
      category: categorizeSource(url, fetched.title || ''),
      excerpt: fetched.content.slice(0, SOURCE_EXCERPT_LIMIT),
      depth,
    },
    links: fetched.links || [],
  };
}

function isBlockedDomain(url: string, blockedDomains: string[]) {
  try {
    return blockedDomains.some(
      domain => new URL(url).hostname === domain || new URL(url).hostname.endsWith(`.${domain}`)
    );
  } catch {
    return true;
  }
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
}
