import type { ModelRouter } from '../api/router';
import { classifyLinks } from '../pipeline/analyze';
import { canonicalizeUrl, isEvidenceLink } from './link-policy';
import type {
  LinkInfo,
  ResearchEvidence,
  ResearchExpansionItem,
  ResearchSeedAssessment,
  ResearchSourceDecision,
  ResearchTask,
  StorageSettings,
} from '@/shared/types';
import type { ResearchSourceInput, RetrievedResearchSource } from './source-registry';
import { evaluateLinkSafety } from '@/shared/link-safety';

const RELEVANCE_THRESHOLD = 0.3;
const MAX_STORED_CANDIDATES = 20;
type ResearchRouter = Pick<ModelRouter, 'complete'>;
type RetrieveSource = (
  task: ResearchTask,
  source: ResearchSourceInput
) => Promise<RetrievedResearchSource>;

interface WorkerOptions {
  router: ResearchRouter;
  task: ResearchTask;
  question: string;
  settings: StorageSettings;
  retrieveSource: RetrieveSource;
  getEvidence: (task: ResearchTask) => ResearchEvidence[];
  checkpoint: (task: ResearchTask, activity?: string) => Promise<void>;
  signal: AbortSignal;
}

export async function scanResearchSeed(options: WorkerOptions) {
  const { task, retrieveSource, checkpoint } = options;
  const source = { url: task.sourceUrl, title: task.title, depth: 0 };
  task.seedStatus = 'running';
  task.status = 'running';
  setPhase(task, 'opening', source);
  addReasoning(task, 'fetch', `Scanning seed source: ${task.title}`);
  const result = await retrieveAndRecord(task, source, retrieveSource);
  if (!result.evidence) {
    task.seedStatus = 'failed';
    throw new Error(result.error || `No readable seed evidence was collected for ${task.label}.`);
  }

  const candidates = await scoreSeedCandidates(options, result.links);
  task.pendingSources = candidates;
  setPhase(task, 'analyzing');
  addReasoning(task, 'synthesize', 'Creating a compact seed assessment.');
  await checkpoint(task, `${task.label}: assessing seed evidence`);
  task.seedAssessment = await createSeedAssessment(options, result.evidence, candidates);
  task.seedStatus = 'completed';
  task.expansionStatus = 'waiting';
  task.status = 'queued';
  setPhase(task, 'queued');
  addReasoning(task, 'answer', 'Seed assessment completed.');
  await checkpoint(task, `${task.label}: seed scan completed`);
}

export async function finalizeResearchSubject(
  options: WorkerOptions,
  expansionItems: ResearchExpansionItem[]
) {
  const { task, retrieveSource, getEvidence, checkpoint, router, question, signal } = options;
  task.status = 'running';
  task.expansionStatus = expansionItems.length > 0 ? 'running' : 'skipped';

  for (const item of expansionItems) {
    throwIfAborted(signal);
    const source = item.source;
    setPhase(task, 'opening', source);
    addReasoning(task, 'fetch', `Opening planned related source: ${source.title}`);
    task.relatedSourcesAttempted++;
    const result = await retrieveAndRecord(task, source, retrieveSource);
    if (result.evidence) {
      task.relatedSourcesRead++;
      item.status = 'completed';
    } else {
      item.status = result.budgetExceeded ? 'skipped' : 'failed';
      item.reason = result.error;
    }
    await checkpoint(task);
  }

  const evidence = getEvidence(task);
  if (evidence.length === 0)
    throw new Error(`No readable evidence was collected for ${task.label}.`);
  setPhase(task, 'analyzing');
  addReasoning(task, 'synthesize', `Analyzing ${evidence.length} unique readable sources.`);
  await checkpoint(task, `${task.label}: generating final subject report`);
  const evidencePrompt = evidence
    .map((item, index) => `SOURCE ${index + 1}: ${item.title}\nURL: ${item.url}\n${item.excerpt}`)
    .join('\n\n');
  const result = await router.complete(
    question,
    { hasLinks: true, contentLength: evidencePrompt.length },
    `Analyze the subject "${task.label}" for the user's request. Produce a compact evidence report, cite source URLs, distinguish facts from uncertainty, and do not invent metrics.\n\nUSER REQUEST:\n${question}\n\nEVIDENCE:\n${evidencePrompt}`,
    { temperature: 0.2, maxTokens: 900, signal }
  );
  task.report = result.text;
  task.expansionStatus = expansionItems.length > 0 ? 'completed' : 'skipped';
  task.status = 'completed';
  setPhase(task, 'completed');
  addReasoning(task, 'answer', 'Final subject report completed.');
  await checkpoint(task, `${task.label}: subject completed`);
}

async function scoreSeedCandidates(options: WorkerOptions, links: LinkInfo[]) {
  const { router, task, question, settings, signal, checkpoint } = options;
  const candidates = links.filter(link => {
    const source = { url: link.url, title: link.text || link.url, depth: 1 };
    if (!evaluateLinkSafety(link).safe) {
      recordDecision(task, source, 'discarded', 'blocked-unsafe-action');
      return false;
    }
    if (!isEvidenceLink(link) || isBlockedDomain(link.url, settings.links.blockedDomains)) {
      recordDecision(task, source, 'discarded', 'navigation-invalid-or-blocked');
      return false;
    }
    if (canonicalizeUrl(link.url) === canonicalizeUrl(task.sourceUrl)) {
      recordDecision(task, source, 'discarded', 'duplicate-source');
      return false;
    }
    return true;
  });
  if (candidates.length === 0) return [];

  setPhase(task, 'scoring');
  addReasoning(task, 'classify', `Scoring ${candidates.length} seed-page links for expansion.`);
  await checkpoint(task, `${task.label}: scoring ${candidates.length} related links`);
  const scores = await classifyLinks(
    router,
    candidates,
    `${question}\nResearch subject: ${task.label}`,
    signal
  );
  const ranked = candidates
    .map((link, index) => ({
      url: link.url,
      title: link.text || link.url,
      depth: 1,
      score: scores[index],
    }))
    .sort((left, right) => right.score - left.score);
  const selected: ResearchTask['pendingSources'] = [];
  ranked.forEach(source => {
    if (source.score <= RELEVANCE_THRESHOLD) {
      recordDecision(task, source, 'discarded', 'below-relevance-threshold', source.score);
    } else if (selected.length >= MAX_STORED_CANDIDATES) {
      recordDecision(task, source, 'skipped', 'candidate-storage-limit', source.score);
    } else {
      selected.push(source);
      recordDecision(task, source, 'selected', 'ranked-expansion-candidate', source.score);
    }
  });
  addReasoning(task, 'classify', `Retained ${selected.length} ranked expansion candidates.`);
  return selected;
}

async function createSeedAssessment(
  { router, task, question, signal }: WorkerOptions,
  evidence: ResearchEvidence,
  candidates: ResearchTask['pendingSources']
): Promise<ResearchSeedAssessment> {
  const result = await router.complete(
    question,
    { hasLinks: candidates.length > 0, contentLength: evidence.excerpt.length },
    `Assess this research seed for the user's request. Return JSON only with: summary (string), relevance (0-1), themes (string array), evidenceGaps (string array), expansionNeeded (boolean). Expansion is needed only when related sources could materially fill an evidence gap.\n\nUSER REQUEST:\n${question}\n\nSUBJECT: ${task.label}\nURL: ${evidence.url}\nCONTENT:\n${evidence.excerpt}`,
    { temperature: 0.1, maxTokens: 500, signal }
  );
  return parseSeedAssessment(result.text, evidence, candidates.length > 0);
}

function parseSeedAssessment(
  text: string,
  evidence: ResearchEvidence,
  hasCandidates: boolean
): ResearchSeedAssessment {
  try {
    const value: unknown = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
    if (isObject(value)) {
      return {
        summary: typeof value.summary === 'string' ? value.summary : evidence.excerpt.slice(0, 600),
        relevance: clampScore(value.relevance),
        themes: stringArray(value.themes),
        evidenceGaps: stringArray(value.evidenceGaps),
        expansionNeeded: hasCandidates && value.expansionNeeded === true,
      };
    }
  } catch {
    // Use deterministic fallback below.
  }
  return {
    summary: evidence.excerpt.slice(0, 600),
    relevance: 0.5,
    themes: [],
    evidenceGaps: [],
    expansionNeeded: hasCandidates,
  };
}

async function retrieveAndRecord(
  task: ResearchTask,
  source: ResearchSourceInput,
  retrieveSource: RetrieveSource
) {
  task.linkVisits.push({
    url: source.url,
    title: source.title,
    status: 'fetching',
    relevanceScore: source.score ?? 1,
    timestamp: Date.now(),
    depth: source.depth,
    method: 'browser-tab',
  });
  const result = await retrieveSource(task, source);
  const visit = task.linkVisits.at(-1);
  if (visit) {
    visit.status = result.evidence ? 'success' : 'failed';
    visit.error = result.error;
    visit.failureReason = result.failureReason;
  }
  if (!result.evidence) {
    recordDecision(
      task,
      source,
      result.budgetExceeded ? 'skipped' : 'failed',
      result.failureReason || 'retrieval-failed',
      source.score
    );
  }
  return result;
}

function recordDecision(
  task: ResearchTask,
  source: { url: string; title: string; depth: number },
  outcome: ResearchSourceDecision['outcome'],
  reason: string,
  score?: number
) {
  task.decisions.push({ ...source, outcome, reason, score, timestamp: Date.now() });
}

function setPhase(
  task: ResearchTask,
  phase: ResearchTask['phase'],
  currentSource?: ResearchTask['currentSource']
) {
  const now = Date.now();
  task.phase = phase;
  task.phaseStartedAt = now;
  task.lastActivityAt = now;
  task.currentSource = currentSource;
}

function addReasoning(
  task: ResearchTask,
  type: ResearchTask['reasoning'][number]['type'],
  thought: string
) {
  task.reasoning.push({ step: task.reasoning.length + 1, type, thought, timestamp: Date.now() });
}

function isBlockedDomain(url: string, blockedDomains: string[]) {
  try {
    const hostname = new URL(url).hostname;
    return blockedDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return true;
  }
}

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function clampScore(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0.5;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
}
