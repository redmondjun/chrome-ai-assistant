import { ModelRouter } from '../api/router';
import type {
  TabContent,
  ReasoningStep,
  LinkVisit,
  LinkFollowSettings,
  ModelSettings,
} from '@/shared/types';

export interface AnalysisCallbacks {
  onChunk: (chunk: string) => void;
  onReasoning?: (step: ReasoningStep) => void;
  onLinkVisit?: (visit: LinkVisit) => void;
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
  callbacks: AnalysisCallbacks
): Promise<void> {
  callbacks.onReasoning?.({
    step: 1,
    type: 'classify',
    thought: `Analyzing question and deciding whether to follow links...`,
    timestamp: Date.now(),
  });

  const shouldFollow =
    settings.links.enabled &&
    (settings.links.mode === 'deep' ||
      (settings.links.mode === 'ai-first' && question.toLowerCase().includes('link')));

  let context = content.text;

  if (shouldFollow && content.links.length > 0) {
    const availableLinks = content.links.filter(
      link => !isBlockedDomain(link.url, settings.links.blockedDomains)
    );

    // Classify links for relevance
    const linkScores = await classifyLinks(router, availableLinks, question);

    const relevantLinks = availableLinks
      .map((link, i) => ({ link, score: linkScores[i] }))
      .filter(({ score }) => score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, settings.links.maxPages);

    callbacks.onReasoning?.({
      step: 2,
      type: 'fetch',
      thought: `Found ${relevantLinks.length} relevant links. Fetching content...`,
      timestamp: Date.now(),
    });

    // Fetch relevant links
    for (const { link, score } of relevantLinks) {
      callbacks.onLinkVisit?.({
        url: link.url,
        title: link.text,
        relevanceScore: score,
        status: 'fetching',
        timestamp: Date.now(),
      });

      try {
        const fetched = await fetchLinkContent(link.url);
        if (fetched) {
          context += `\n\n--- Content from ${link.url} ---\n${fetched}`;

          callbacks.onLinkVisit?.({
            url: link.url,
            title: link.text,
            relevanceScore: score,
            status: 'success',
            timestamp: Date.now(),
            snippet: fetched.slice(0, 200),
          });
        }
      } catch {
        callbacks.onLinkVisit?.({
          url: link.url,
          title: link.text,
          relevanceScore: score,
          status: 'failed',
          timestamp: Date.now(),
        });
      }
    }

    callbacks.onReasoning?.({
      step: 3,
      type: 'synthesize',
      thought: `Gathered content from ${relevantLinks.length} linked pages. Synthesizing answer...`,
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
  const prompt = buildPrompt(context, question, content.url, content.title);

  for await (const result of router.streamComplete(
    question,
    {
      hasLinks: shouldFollow,
      contentLength: context.length,
    },
    prompt,
    { temperature: 0.7, maxTokens: 4096 }
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
}

async function classifyLinks(
  router: ModelRouter,
  links: TabContent['links'],
  question: string
): Promise<number[]> {
  if (links.length === 0) return [];

  const prompt = `Score each link 0-1 for relevance to: "${question}"

Links:
${links.map((l, i) => `${i + 1}. ${l.text} - ${l.url}`).join('\n')}

Return only JSON array: [0.9, 0.1, ...]`;

  try {
    const result = await router.complete(question, { hasLinks: true, contentLength: 0 }, prompt, {
      temperature: 0.1,
      maxTokens: 256,
    });
    const text = typeof result === 'string' ? result : result.text;

    const match = text.match(/\[[\d.,\s]+\]/);
    if (match) return JSON.parse(match[0]).map((n: number) => Math.max(0, Math.min(1, n)));
  } catch {
    const terms = question.toLowerCase().split(/\W+/).filter(Boolean);
    return links.map(link => {
      const haystack = `${link.text} ${link.url} ${link.context || ''}`.toLowerCase();
      return terms.some(term => haystack.includes(term)) ? 0.9 : 0.1;
    });
  }

  return links.map(() => 0.5);
}

async function fetchLinkContent(url: string): Promise<string | null> {
  try {
    const requestOptions: RequestInit = {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChromeAI/1.0)' },
    };
    if (typeof AbortSignal.timeout === 'function') {
      requestOptions.signal = AbortSignal.timeout(10000);
    }
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
  } catch {
    return null;
  }
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

function buildPrompt(context: string, question: string, url: string, title: string): string {
  return `Source: ${title} (${url})

Content:
${context.slice(0, 50000)}

Question: ${question}

Answer comprehensively using the provided content. Cite sources when possible.`;
}

export { classifyLinks, fetchLinkContent };
