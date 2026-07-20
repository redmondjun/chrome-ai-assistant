import { ModelRouter } from '../api/router';
import { shouldFollowLinks as modelShouldFollowLinks } from '../content/classifier';
import { fetchLinkContentInTab } from '../content/link-tab-fetcher';
import { evaluateLinkSafety } from '@/shared/link-safety';
import type {
  TabContent,
  ReasoningStep,
  LinkVisit,
  LinkFollowSettings,
  ModelSettings,
  ChatMessage,
  LinkInfo,
  LinkDecision,
} from '@/shared/types';

const LINK_SCORING_BATCH_SIZE = 10;
const LINK_SCORING_SLOW_MS = 15000;
const LINK_SCORING_TIMEOUT_MS = 60000;
const LINK_CONTEXT_LIMIT = 240;

export interface AnalysisCallbacks {
  onChunk: (chunk: string) => void;
  onReasoning?: (step: ReasoningStep) => void;
  onLinkVisit?: (visit: LinkVisit) => void;
  onLinkDecision?: (decision: LinkDecision) => void;
  onDone?: () => void;
}

export async function analyzeWithReasoning(
  router: ModelRouter,
  content: TabContent,
  question: string,
  settings: {
    model: ModelSettings;
    links: LinkFollowSettings;
  },
  callbacks: AnalysisCallbacks,
  history: ChatMessage[] = [],
  signal?: AbortSignal
): Promise<void> {
  const startedAt = Date.now();
  const logStage = (stage: string, details: object = {}) =>
    console.info('[analysis]', stage, { elapsedMs: Date.now() - startedAt, ...details });
  const reportScoringProgress = (thought: string) =>
    callbacks.onReasoning?.({
      step: 2,
      type: 'classify',
      thought,
      timestamp: Date.now(),
    });
  logStage('started', { linkCount: content.links.length });
  signal?.throwIfAborted();
  callbacks.onReasoning?.({
    step: 1,
    type: 'classify',
    thought: 'Analyzing question and deciding whether to follow links (research pipeline v5)...',
    timestamp: Date.now(),
  });

  if (asksForLinkVisitStatus(question)) {
    callbacks.onReasoning?.({
      step: 2,
      type: 'synthesize',
      thought: 'Reporting recorded link-visit results from this conversation.',
      timestamp: Date.now(),
    });
    callbacks.onChunk(buildLinkVisitStatus(history));
    callbacks.onDone?.();
    return;
  }

  const explicitLinkRequest = explicitlyRequestsLinkRetrieval(question);

  const shouldFollow =
    settings.links.enabled &&
    (explicitLinkRequest ||
      settings.links.mode === 'deep' ||
      (settings.links.mode === 'ai-first' &&
        (await modelShouldFollowLinks(router, question, content.links.length, signal))));
  logStage('link-decision', { shouldFollow });

  let context = content.text.slice(0, 20000);
  const currentVisits: LinkVisit[] = [];
  const sourceExcerptLimit = Math.max(
    1200,
    Math.floor(30000 / Math.max(1, settings.links.maxPages))
  );

  if (shouldFollow && content.links.length > 0) {
    const availableLinks = content.links.filter(link => {
      if (!evaluateLinkSafety(link).safe) {
        emitLinkDecision(callbacks, link, 1, 'discarded', 'blocked-unsafe-action');
        return false;
      }
      if (isBlockedDomain(link.url, settings.links.blockedDomains)) {
        emitLinkDecision(callbacks, link, 1, 'discarded', 'blocked-domain');
        return false;
      }
      if (isLikelyNavigationLink(link)) {
        emitLinkDecision(callbacks, link, 1, 'discarded', 'navigation-link');
        return false;
      }
      return true;
    });
    const rootEvidenceIdentifiers = extractEvidenceIdentifiers(
      `${content.text}\n${availableLinks.map(link => `${link.text} ${link.url}`).join('\n')}`
    );

    callbacks.onReasoning?.({
      step: 2,
      type: 'classify',
      thought: `Scoring ${availableLinks.length} candidate links for relevance to your request...`,
      timestamp: Date.now(),
    });

    // Classify links for relevance
    const linkScores = await classifyLinks(
      router,
      availableLinks,
      question,
      signal,
      reportScoringProgress
    );

    const scoredLinks = availableLinks.map((link, i) => ({ link, score: linkScores[i] }));
    const allRelevantLinks = explicitlyRequestsAllLinks(question)
      ? scoredLinks
      : scoredLinks.filter(({ link, score }) => {
          if (score > 0.3) return true;
          emitLinkDecision(callbacks, link, 1, 'discarded', 'below-relevance-threshold', score);
          return false;
        });
    allRelevantLinks.sort((a, b) => b.score - a.score);
    const relevantLinks = allRelevantLinks.slice(0, settings.links.maxPages);
    relevantLinks.forEach(({ link, score }) =>
      emitLinkDecision(callbacks, link, 1, 'selected', 'ranked-for-retrieval', score)
    );
    allRelevantLinks
      .slice(settings.links.maxPages)
      .forEach(({ link, score }) =>
        emitLinkDecision(callbacks, link, 1, 'skipped', 'page-budget-limit', score)
      );
    const queue: Array<{ link: LinkInfo; score: number; depth: number }> = relevantLinks.map(
      item => ({ ...item, depth: 1 })
    );
    const queuedUrls = new Set(queue.map(item => normalizeUrl(item.link.url)));
    let attemptedPages = 0;
    let deepestAttempted = 0;

    callbacks.onReasoning?.({
      step: 2,
      type: 'fetch',
      thought: `Selected ${relevantLinks.length} of ${allRelevantLinks.length} relevant first-depth links (Max Pages: ${settings.links.maxPages}); researching breadth-first up to depth ${settings.links.maxDepth}...`,
      timestamp: Date.now(),
    });

    while (queue.length > 0 && attemptedPages < settings.links.maxPages) {
      signal?.throwIfAborted();
      const { link, score, depth } = queue.shift()!;
      attemptedPages++;
      deepestAttempted = Math.max(deepestAttempted, depth);
      callbacks.onReasoning?.({
        step: 2,
        type: 'fetch',
        thought: `Opening depth ${depth} source ${attemptedPages}: ${link.text || link.url}`,
        timestamp: Date.now(),
      });
      callbacks.onLinkVisit?.({
        url: link.url,
        title: link.text,
        relevanceScore: score,
        status: 'fetching',
        timestamp: Date.now(),
        depth,
      });

      try {
        let fetched = await fetchLinkContent(link.url, signal);
        let failure = '';
        let method: LinkVisit['method'] = 'direct-fetch';
        let discoveredLinks: LinkInfo[] = [];
        let fetchedTitle = link.text;
        if (!fetched) {
          callbacks.onReasoning?.({
            step: 2,
            type: 'fetch',
            thought: `Direct retrieval returned no readable content for ${link.text || link.url}; trying an authenticated browser tab...`,
            timestamp: Date.now(),
          });
          const tabResult = await fetchLinkContentInTab(link.url, signal);
          fetched = tabResult.content || null;
          failure = tabResult.error || '';
          discoveredLinks = tabResult.links || [];
          fetchedTitle = tabResult.title || fetchedTitle;
          method = 'browser-tab';
        }
        if (fetched) {
          const invalidReason = getInvalidPageReason(fetched, fetchedTitle);
          if (invalidReason) {
            const visit: LinkVisit = {
              url: link.url,
              title: link.text,
              relevanceScore: score,
              status: 'failed',
              timestamp: Date.now(),
              error: invalidReason,
              method,
              depth,
            };
            currentVisits.push(visit);
            callbacks.onLinkVisit?.(visit);
            callbacks.onReasoning?.({
              step: 2,
              type: 'extract',
              thought: `Could not use ${link.text || link.url}: ${invalidReason}`,
              timestamp: Date.now(),
            });
            emitLinkDecision(callbacks, link, depth, 'discarded', 'invalid-page-content', score);
            continue;
          }
          const sourceExcerpt = fetched.slice(0, sourceExcerptLimit);
          context += `\n\n--- Content from ${link.url} (depth ${depth}) ---\n${sourceExcerpt}`;

          const visit: LinkVisit = {
            url: link.url,
            title: link.text,
            relevanceScore: score,
            status: 'success',
            timestamp: Date.now(),
            snippet: fetched.slice(0, 1500),
            method,
            depth,
          };
          currentVisits.push(visit);
          callbacks.onLinkVisit?.(visit);
          callbacks.onReasoning?.({
            step: 2,
            type: 'extract',
            thought: `Read ${link.text || link.url} using ${method}.`,
            timestamp: Date.now(),
          });

          if (depth < settings.links.maxDepth && discoveredLinks.length > 0) {
            const childCandidates = discoveredLinks.filter(child => {
              if (!evaluateLinkSafety(child).safe) {
                emitLinkDecision(callbacks, child, depth + 1, 'discarded', 'blocked-unsafe-action');
                return false;
              }
              if (isBlockedDomain(child.url, settings.links.blockedDomains)) {
                emitLinkDecision(callbacks, child, depth + 1, 'discarded', 'blocked-domain');
                return false;
              }
              if (isLikelyNavigationLink(child)) {
                emitLinkDecision(callbacks, child, depth + 1, 'discarded', 'navigation-link');
                return false;
              }
              if (queuedUrls.has(normalizeUrl(child.url))) {
                emitLinkDecision(callbacks, child, depth + 1, 'discarded', 'duplicate-url');
                return false;
              }
              return true;
            });
            const childLinks = childCandidates.slice(0, 40);
            childCandidates
              .slice(40)
              .forEach(child =>
                emitLinkDecision(
                  callbacks,
                  child,
                  depth + 1,
                  'skipped',
                  'child-classification-limit'
                )
              );
            if (childLinks.length > 0) {
              callbacks.onReasoning?.({
                step: 2,
                type: 'classify',
                thought: `Scoring ${childLinks.length} links discovered in ${link.text || link.url}...`,
                timestamp: Date.now(),
              });
            }
            const childScores = await classifyLinks(
              router,
              childLinks,
              question,
              signal,
              reportScoringProgress
            );
            const relevantChildren = childLinks
              .map((child, index) => ({ link: child, score: childScores[index], depth: depth + 1 }))
              .filter(child => {
                const relevant = isRelevantChildLink(
                  child.link,
                  child.score,
                  question,
                  fetched,
                  rootEvidenceIdentifiers
                );
                emitLinkDecision(
                  callbacks,
                  child.link,
                  child.depth,
                  relevant ? 'selected' : 'discarded',
                  relevant ? 'relevant-child-source' : 'below-child-relevance',
                  child.score
                );
                return relevant;
              })
              .sort((left, right) => right.score - left.score);

            relevantChildren.forEach(child => queuedUrls.add(normalizeUrl(child.link.url)));
            queue.push(...relevantChildren);
          }
        } else {
          const visit: LinkVisit = {
            url: link.url,
            title: link.text,
            relevanceScore: score,
            status: 'failed',
            timestamp: Date.now(),
            method: 'browser-tab',
            depth,
            error:
              failure ||
              'No readable content returned. Sign in to the source and connect to the company network.',
          };
          currentVisits.push(visit);
          callbacks.onLinkVisit?.(visit);
          callbacks.onReasoning?.({
            step: 2,
            type: 'extract',
            thought: `Could not read ${link.text || link.url}: ${visit.error}`,
            timestamp: Date.now(),
          });
        }
      } catch (error) {
        const visit: LinkVisit = {
          url: link.url,
          title: link.text,
          relevanceScore: score,
          status: 'failed',
          timestamp: Date.now(),
          error: error instanceof Error ? error.message : String(error),
          depth,
        };
        currentVisits.push(visit);
        callbacks.onLinkVisit?.(visit);
        callbacks.onReasoning?.({
          step: 2,
          type: 'extract',
          thought: `Could not read ${link.text || link.url}: ${visit.error}`,
          timestamp: Date.now(),
        });
      }

      if (queue.length > 0 && settings.links.rateLimitMs > 0) {
        await delay(settings.links.rateLimitMs, signal);
      }
    }

    queue.forEach(({ link, score, depth }) =>
      emitLinkDecision(callbacks, link, depth, 'skipped', 'page-budget-exhausted', score)
    );

    callbacks.onReasoning?.({
      step: 3,
      type: 'synthesize',
      thought: `Retrieved ${currentVisits.filter(visit => visit.status === 'success').length} of ${attemptedPages} attempted pages across ${deepestAttempted} depth level${deepestAttempted === 1 ? '' : 's'}. Synthesizing answer...`,
      timestamp: Date.now(),
    });
  }

  if (shouldFollow && content.links.length === 0) {
    callbacks.onReasoning?.({
      step: 2,
      type: 'synthesize',
      thought: 'Research was requested, but no links were found in the readable page content.',
      timestamp: Date.now(),
    });
  }

  if (!shouldFollow) {
    callbacks.onReasoning?.({
      step: 2,
      type: 'synthesize',
      thought: 'This question does not require following links. Using the current page.',
      timestamp: Date.now(),
    });
  }

  // Generate final answer
  const prompt = buildPrompt(context, question, content.url, content.title, history, currentVisits);
  signal?.throwIfAborted();
  logStage('generation-started', { retrievedPages: currentVisits.length });

  for await (const result of router.streamComplete(
    question,
    {
      hasLinks: shouldFollow,
      contentLength:
        context.length + history.reduce((length, message) => length + message.content.length, 0),
    },
    prompt,
    { temperature: 0.7, maxTokens: 4096, signal }
  )) {
    callbacks.onChunk(result.chunk);
  }

  callbacks.onReasoning?.({
    step: shouldFollow ? 4 : 3,
    type: 'answer',
    thought: `Answer generated.`,
    timestamp: Date.now(),
  });

  callbacks.onDone?.();
  logStage('completed');
}

function emitLinkDecision(
  callbacks: AnalysisCallbacks,
  link: LinkInfo,
  depth: number,
  outcome: 'selected' | 'discarded' | 'skipped',
  reason: string,
  score?: number
): void {
  const decision: LinkDecision = {
    outcome,
    reason,
    depth,
    score,
    title: link.text,
    url: link.url,
    timestamp: Date.now(),
  };
  console.info('[research]', 'link-decision', decision);
  callbacks.onLinkDecision?.(decision);
}

async function classifyLinks(
  router: Pick<ModelRouter, 'complete'>,
  links: TabContent['links'],
  question: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
  batchConcurrency = 1
): Promise<number[]> {
  if (links.length === 0) return [];

  const starts = Array.from(
    { length: Math.ceil(links.length / LINK_SCORING_BATCH_SIZE) },
    (_, index) => index * LINK_SCORING_BATCH_SIZE
  );
  const results: number[][] = Array.from({ length: starts.length });
  let cursor = 0;
  const worker = async () => {
    while (cursor < starts.length) {
      if (signal?.aborted) throw signal.reason;
      const batchIndex = cursor++;
      const start = starts[batchIndex];
      const batch = links.slice(start, start + LINK_SCORING_BATCH_SIZE);
      const batchLabel = `${start + 1}-${start + batch.length} of ${links.length}`;
      onProgress?.(`Scoring links ${batchLabel}...`);
      results[batchIndex] = await classifyLinkBatch(
        router,
        batch,
        question,
        batchLabel,
        signal,
        onProgress
      );
      onProgress?.(`Finished scoring links ${batchLabel}.`);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, batchConcurrency), starts.length) }, worker)
  );
  return results.flat();
}

async function classifyLinkBatch(
  router: Pick<ModelRouter, 'complete'>,
  links: TabContent['links'],
  question: string,
  batchLabel: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<number[]> {
  const prompt = `Score each link 0-1 for relevance to: "${question}"

Links:
${links.map((l, i) => `${i + 1}. ${l.text.slice(0, LINK_CONTEXT_LIMIT)} - ${l.url} - Context: ${(l.context || 'none').slice(0, LINK_CONTEXT_LIMIT)}`).join('\n')}

Navigation, account, authentication, legal, create/edit, and site-management links are irrelevant.
Return only JSON array: [0.9, 0.1, ...]`;

  const scoringController = new AbortController();
  const abortScoring = () => scoringController.abort(signal?.reason);
  signal?.addEventListener('abort', abortScoring, { once: true });
  if (signal?.aborted) abortScoring();
  const timeoutError = new DOMException(
    `Link scoring batch timed out after ${LINK_SCORING_TIMEOUT_MS / 1000} seconds.`,
    'TimeoutError'
  );
  const slowId = setTimeout(
    () =>
      onProgress?.(
        `Still scoring links ${batchLabel}; the model is responding slowly, so this batch is still running.`
      ),
    LINK_SCORING_SLOW_MS
  );
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      scoringController.abort(timeoutError);
      reject(timeoutError);
    }, LINK_SCORING_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([
      router.complete(question, { hasLinks: true, contentLength: 0 }, prompt, {
        temperature: 0.1,
        maxTokens: 256,
        signal: scoringController.signal,
      }),
      timeout,
    ]);
    const text = typeof result === 'string' ? result : result.text;

    const match = text.match(/\[[\d.,\s]+\]/);
    if (match) {
      const scores = JSON.parse(match[0]).map((n: number) => Math.max(0, Math.min(1, n)));
      if (scores.length === links.length) {
        console.info('[research]', 'relevance-scoring', {
          method: 'model',
          linkCount: links.length,
          batch: batchLabel,
          uniform: links.length > 1 && scores.every((score: number) => score === scores[0]),
        });
        return scores;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    const reason =
      error instanceof DOMException && error.name === 'TimeoutError'
        ? `timed out after ${LINK_SCORING_TIMEOUT_MS / 1000} seconds`
        : error instanceof Error
          ? error.message
          : String(error);
    console.warn('[research]', 'relevance-scoring-fallback', {
      reason,
      linkCount: links.length,
      batch: batchLabel,
    });
    onProgress?.(
      `AI scoring for links ${batchLabel} did not finish (${reason}). Using local relevance matching for this batch.`
    );
    return scoreLinksByKeywords(links, question);
  } finally {
    clearTimeout(slowId);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortScoring);
  }

  const reason = 'The model response did not contain one score per link.';
  console.warn('[research]', 'relevance-scoring-fallback', {
    reason,
    linkCount: links.length,
    batch: batchLabel,
  });
  onProgress?.(
    `AI scoring for links ${batchLabel} returned an invalid result. Using local relevance matching for this batch.`
  );
  return scoreLinksByKeywords(links, question);
}

function scoreLinksByKeywords(links: TabContent['links'], question: string): number[] {
  const terms = meaningfulTerms(question);
  return links.map(link => {
    const haystack = `${link.text} ${link.url} ${link.context || ''}`.toLowerCase();
    if (terms.some(term => haystack.includes(term))) return 0.9;
    return /\/(?:pull-requests|browse|issues|display)\b/i.test(link.url) ? 0.6 : 0.1;
  });
}

function getInvalidPageReason(content: string, title: string): string | undefined {
  const sample = `${title}\n${content.slice(0, 2000)}`;
  if (/\bHTTP Status 4\d\d\b/i.test(sample)) return 'The source returned an HTTP error page.';
  if (/\b(?:Page Not Found|The page doesn['’]t exist|We can['’]t find that page)\b/i.test(sample)) {
    return 'The source returned a page-not-found response.';
  }
  if (/\b(?:Access Denied|You do not have permission to view this page)\b/i.test(sample)) {
    return 'The source returned an access-denied page.';
  }
  return undefined;
}

function isRelevantChildLink(
  link: LinkInfo,
  score: number,
  question: string,
  parentContent: string,
  rootEvidenceIdentifiers: Set<string>
): boolean {
  if (score >= 0.75) return true;

  const identifiers = extractEvidenceIdentifiers(`${link.text} ${link.url} ${link.context || ''}`);
  if ([...identifiers].some(identifier => rootEvidenceIdentifiers.has(identifier))) return true;

  const parentIdentifiers = extractEvidenceIdentifiers(parentContent);
  if ([...identifiers].some(identifier => parentIdentifiers.has(identifier))) return true;

  const haystack = `${link.text} ${link.url} ${link.context || ''}`.toLowerCase();
  return meaningfulTerms(question).some(term => haystack.includes(term));
}

function meaningfulTerms(value: string): string[] {
  const ignored = new Set([
    'about',
    'answer',
    'based',
    'context',
    'data',
    'document',
    'documentation',
    'from',
    'generate',
    'information',
    'links',
    'page',
    'please',
    'source',
    'supporting',
    'summary',
    'that',
    'them',
    'this',
    'using',
    'visit',
    'with',
  ]);
  return value
    .toLowerCase()
    .split(/\W+/)
    .filter(term => term.length > 3 && !ignored.has(term));
}

function extractEvidenceIdentifiers(value: string): Set<string> {
  const ticketKeys = value.toUpperCase().match(/\b[A-Z]{2,10}-\d+\b/g) || [];
  const pullRequests = (value.match(/\b(?:pull-requests?|pr)[\s/#-]*\d+\b/gi) || []).map(match =>
    match.toUpperCase()
  );
  return new Set([...ticketKeys, ...pullRequests]);
}

function isLikelyNavigationLink(link: LinkInfo): boolean {
  const label = link.text.trim().toLowerCase();
  if (
    /^(?:people|tasks|create|copy|edit|profile|calendar|calendars|analytics|help|online help|home|dashboard|log in|log out|add comment|find filters|view in hierarchy|use global relay sso account|master subscription agreement|evaluation agreement|ai terms|privacy policy|recently viewed|recently worked on)$/i.test(
      label
    )
  ) {
    return true;
  }

  try {
    const url = new URL(link.url);
    if (/^(?:www\.)?google\./i.test(url.hostname) && url.pathname === '/search') return true;
  } catch {
    return true;
  }

  return /\/(?:browsepeople|createpage|copypage|reorderpages|diffpagesbyversion|dashboard|calendar|users\/view|plugins\/inlinetasks|secure\/ManageFilters|users\/sign_in|login|logout|aboutconfluence|configurerssfeed|msa|evaluation-agreement|privacy-policy|legal\/productboard-ai-terms)\b/i.test(
    link.url
  );
}

function normalizeUrl(url: string): string {
  try {
    const normalized = new URL(url);
    normalized.hash = '';
    return normalized.href;
  } catch {
    return url;
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

async function fetchLinkContent(url: string, signal?: AbortSignal): Promise<string | null> {
  const safety = evaluateLinkSafety({ url });
  if (!safety.safe) {
    console.warn('[research]', 'blocked-unsafe-action', { url, reason: safety.reason });
    return null;
  }
  const requestSignal = createTimedSignal(signal, 10000);
  try {
    const requestOptions: RequestInit = {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChromeAI/1.0)' },
      credentials: 'include',
    };
    requestOptions.signal = requestSignal.signal;
    const response = await fetch(url, requestOptions);

    if (!response.ok) return null;
    const html = await response.text();
    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType && !contentType.includes('html')) return null;
    if (!/<(?:html|body|article|main|div)\b/i.test(html)) return null;

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    doc.querySelectorAll('script, style, nav, header, footer, aside').forEach(el => el.remove());

    const main = doc.querySelector('article, [role="main"], .content, #content, main') || doc.body;
    return main.textContent?.slice(0, 15000) || null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  } finally {
    requestSignal.dispose();
  }
}

function createTimedSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abort);
    },
  };
}

function isBlockedDomain(url: string, blockedDomains: string[]): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return blockedDomains.some(domain => {
      const normalized = domain
        .toLowerCase()
        .trim()
        .replace(/^www\./, '');
      return normalized && (hostname === normalized || hostname.endsWith(`.${normalized}`));
    });
  } catch {
    return true;
  }
}

function buildPrompt(
  context: string,
  question: string,
  url: string,
  title: string,
  history: ChatMessage[],
  currentVisits: LinkVisit[]
): string {
  const conversation = history
    .filter(message => !message.isStreaming && message.content)
    .slice(-12)
    .map(
      message =>
        `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content.slice(0, 4000)}`
    )
    .join('\n\n');
  const sourceStatus = formatSourceStatus(
    currentVisits.length > 0 ? currentVisits : getLatestVisits(history)
  );

  return `Source: ${title} (${url})

Content:
${context.slice(0, 50000)}

${sourceStatus ? `Source retrieval results:\n${sourceStatus}\n\n` : ''}${conversation ? `Conversation so far:\n${conversation}\n\n` : ''}Current question: ${question}

Answer the current question directly. The current question has priority over previous requests and answers. Do not repeat or regenerate a previous summary unless the current question explicitly requests it. Use the source retrieval results as the truth about which links were visited. Cite successfully retrieved sources when possible.`;
}

function explicitlyRequestsLinkRetrieval(question: string): boolean {
  return /\b(?:visit|open|follow|fetch|browse|read|access|retry)\b[\s\S]*\b(?:links?|urls?|sources?|supporting documentation)\b|\b(?:links?|urls?|sources?|supporting documentation)\b[\s\S]*\b(?:visit|open|follow|fetch|browse|read|access|retry)\b|\bvisit\s+(?:it|them)\b|\btry again\b/i.test(
    question
  );
}

function explicitlyRequestsAllLinks(question: string): boolean {
  return /\b(?:all|every)\b[\s\S]*\b(?:links?|urls?|sources?)\b|\b(?:links?|urls?|sources?)\b[\s\S]*\b(?:all|every)\b/i.test(
    question
  );
}

function asksForLinkVisitStatus(question: string): boolean {
  return /\b(?:did|have|has|were|was)\b[\s\S]*\b(?:visit|visited|fetch|fetched|open|opened|retrieve|retrieved)\b[\s\S]*\b(?:links?|urls?|sources?)\b/i.test(
    question
  );
}

function getLatestVisits(history: ChatMessage[]): LinkVisit[] {
  return [...history].reverse().find(message => message.linkVisits?.length)?.linkVisits || [];
}

function formatSourceStatus(visits: LinkVisit[]): string {
  const finalVisits = new Map<string, LinkVisit>();
  visits
    .filter(visit => visit.status !== 'fetching')
    .forEach(visit => finalVisits.set(visit.url, visit));
  return [...finalVisits.values()]
    .map(
      visit =>
        `- ${visit.status.toUpperCase()} ${visit.url}${visit.method ? ` via ${visit.method}` : ''}${visit.error ? `: ${visit.error}` : ''}${visit.snippet ? `\n  Retrieved excerpt: ${visit.snippet}` : ''}`
    )
    .join('\n');
}

function buildLinkVisitStatus(history: ChatMessage[]): string {
  const visits = getLatestVisits(history);
  const finalVisits = new Map<string, LinkVisit>();
  visits
    .filter(visit => visit.status !== 'fetching')
    .forEach(visit => finalVisits.set(visit.url, visit));
  const results = [...finalVisits.values()];
  if (results.length === 0) return 'No links have been visited in this conversation yet.';

  const successful = results.filter(visit => visit.status === 'success');
  const failed = results.filter(visit => visit.status === 'failed');
  const lines = [
    successful.length === results.length
      ? `Yes. All ${results.length} links were retrieved successfully.`
      : `No. ${successful.length} of ${results.length} links were retrieved successfully.`,
  ];
  if (failed.length > 0) {
    lines.push(
      '',
      'Failed sources:',
      ...failed.map(visit => `- ${visit.url}${visit.error ? ` — ${visit.error}` : ''}`)
    );
  }
  return lines.join('\n');
}

export { classifyLinks, fetchLinkContent };
