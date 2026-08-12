import { canonicalizeUrl } from './link-policy';
import { evaluateLinkSafety } from '@/shared/link-safety';
import type { ResearchSubjectSelection, SavedPage, TabContent } from '@/shared/types';

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;
const TICKET_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;

export interface DirectedResearchRequest {
  selection: Omit<ResearchSubjectSelection, 'excludedTicketIds'>;
  explicitUrls: string[];
  skipExisting: boolean;
}

export function parseDirectedResearchRequest(
  question: string
): DirectedResearchRequest | undefined {
  const match = question.match(
    /\b(?:first|next)\s+(\d+)\s+(?:the\s+)?(?:new\s+|eligible\s+)?tickets?\s+from\s+(https?:\/\/[^\s<>"')\]]+)/i
  );
  if (!match) return undefined;
  const requestedCount = Number(match[1]);
  const sourceUrl = trimUrl(match[2]);
  if (!Number.isSafeInteger(requestedCount) || requestedCount <= 0) return undefined;
  if (!evaluateLinkSafety({ url: sourceUrl }).safe) return undefined;
  return {
    selection: { kind: 'ticket', sourceUrl, requestedCount },
    explicitUrls: extractExplicitUrls(question),
    skipExisting: /\bskip\b[\s\S]*\b(?:existing|already|qualifications?)\b/i.test(question),
  };
}

export function extractExplicitUrls(question: string): string[] {
  return [...new Set((question.match(URL_PATTERN) || []).map(trimUrl))].filter(
    url => evaluateLinkSafety({ url }).safe
  );
}

export function collectExcludedTicketIds(pages: SavedPage[]): string[] {
  return [
    ...new Set(
      pages
        .flatMap(page => [page.text, ...page.links.map(link => `${link.text} ${link.url}`)])
        .flatMap(value => value.match(TICKET_PATTERN) || [])
    ),
  ];
}

export function toSavedPage(content: TabContent): SavedPage {
  return {
    id: `research-context:${canonicalizeUrl(content.url)}`,
    url: content.url,
    title: content.title,
    text: content.text.slice(0, 50000),
    links: content.links,
    capturedAt: content.timestamp,
  };
}

export function samePage(left: string, right: string): boolean {
  return canonicalizeUrl(left) === canonicalizeUrl(right);
}

export async function resolveDirectedResearchRequest(
  current: TabContent,
  savedPages: SavedPage[],
  question: string,
  fetchPage: (url: string) => Promise<TabContent>
) {
  const directed = parseDirectedResearchRequest(question);
  if (!directed) {
    return {
      content: current,
      contextPages: deduplicatePages([toSavedPage(current), ...savedPages]),
    };
  }

  const knownPages = [toSavedPage(current), ...savedPages];
  const knownSource = knownPages.find(page => samePage(page.url, directed.selection.sourceUrl));
  const source = knownSource
    ? toTabContent(knownSource)
    : await fetchPage(directed.selection.sourceUrl);
  const groundingPages = knownPages.filter(page => !samePage(page.url, source.url));
  for (const url of directed.explicitUrls) {
    if (samePage(url, source.url) || groundingPages.some(page => samePage(page.url, url))) continue;
    groundingPages.push(toSavedPage(await fetchPage(url)));
  }
  const contextPages = deduplicatePages(groundingPages);
  return {
    content: source,
    contextPages,
    subjectSelection: {
      ...directed.selection,
      excludedTicketIds: directed.skipExisting ? collectExcludedTicketIds(contextPages) : [],
    },
  };
}

function toTabContent(page: SavedPage): TabContent {
  return {
    url: page.url,
    title: page.title,
    text: page.text,
    links: page.links,
    meta: {},
    timestamp: page.capturedAt,
  };
}

function deduplicatePages(pages: SavedPage[]): SavedPage[] {
  return pages.filter(
    (page, index) => pages.findIndex(candidate => samePage(candidate.url, page.url)) === index
  );
}

function trimUrl(url: string): string {
  return url.replace(/[.,;:]+$/, '');
}
