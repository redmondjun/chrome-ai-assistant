import type {
  LinkInfo,
  ResearchEvidence,
  ResearchSubjectSelection,
  ResearchTask,
} from '@/shared/types';
import { evaluateLinkSafety } from '@/shared/link-safety';

export function extractResearchTasks(links: LinkInfo[]): ResearchTask[] {
  const tasks = new Map<string, ResearchTask>();
  links.forEach(link => {
    if (!isHttpUrl(link.url)) return;
    const safety = link.safety || evaluateLinkSafety(link);
    if (!safety.safe || isNavigationLink(link)) return;
    const sourceUrl = canonicalizeUrl(link.url);
    if (tasks.has(sourceUrl)) return;
    const label = link.text.trim() || getUrlLabel(sourceUrl);
    const now = Date.now();
    tasks.set(sourceUrl, {
      id: crypto.randomUUID(),
      label,
      sourceUrl: link.url,
      title: label,
      status: 'queued',
      phase: 'queued',
      phaseStartedAt: now,
      lastActivityAt: now,
      reasoning: [],
      linkVisits: [],
      relatedSourcesRead: 0,
      relatedSourcesAttempted: 0,
      evidence: [],
      decisions: [],
      pendingSources: [{ url: link.url, title: label, depth: 0 }],
      visitedUrls: [],
    });
  });
  return [...tasks.values()];
}

export function extractSelectedResearchTasks(
  links: LinkInfo[],
  selection: ResearchSubjectSelection
): ResearchTask[] {
  const excluded = new Set(selection.excludedTicketIds.map(id => id.toUpperCase()));
  const selectedLinks: LinkInfo[] = [];
  const selectedIds = new Set<string>();
  links.forEach(link => {
    const ticketId = extractTicketId(link);
    if (!ticketId || excluded.has(ticketId) || selectedIds.has(ticketId)) return;
    if (!isEvidenceLink(link)) return;
    selectedIds.add(ticketId);
    selectedLinks.push({ ...link, text: ticketId });
  });
  return extractResearchTasks(selectedLinks.slice(0, selection.requestedCount));
}

export function extractTicketId(link: LinkInfo): string | undefined {
  const match = `${link.text} ${link.url}`.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
  return match?.[1].toUpperCase();
}

export function isEvidenceLink(link: LinkInfo) {
  const safety = link.safety || evaluateLinkSafety(link);
  return safety.safe && isHttpUrl(link.url) && !isNavigationLink(link);
}

export function categorizeSource(url: string, title: string): ResearchEvidence['category'] {
  const value = `${url} ${title}`.toLowerCase();
  if (/pull-requests?\/\d+|code review|stash|bitbucket/.test(value)) return 'code-review';
  if (/epic/.test(value)) return 'epic';
  if (/business|requirement/.test(value)) return 'business';
  if (/wiki|confluence|\/display\/|viewpage\.action/.test(value)) return 'documentation';
  if (/\/browse\/[a-z][a-z0-9]+-\d+/.test(value)) return 'ticket';
  return 'other';
}

export function canonicalizeUrl(url: string) {
  const parsed = new URL(url);
  parsed.hash = '';
  ['atlOrigin', 'focusedCommentId', 'src'].forEach(parameter =>
    parsed.searchParams.delete(parameter)
  );
  return parsed.href;
}

function isHttpUrl(url: string) {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isNavigationLink(link: LinkInfo) {
  const value = `${link.url} ${link.text} ${link.context || ''}`.toLowerCase();
  const label = link.text.trim().toLowerCase();
  return (
    /\/(?:login|logout|people|profile|dashboard|create|calendar|plugins|pages\/viewinfo|pages\/viewpreviousversions|pages\/viewpagehierarchy|pages\/viewpagetree|spaces\/spacepermissions)(?:[/?#\s]|$)/.test(
      value
    ) ||
    /^(?:attachments?(?:\s*\(\d+\))?|page history|restrictions|people who can view|analytics|page information|resolved comments?(?:\s*\(\d+\))?|view in hierarchy|view storage format|view source|export to pdf|export to word|import word document|show more|edit|delete|create|configure|administration|edit profile)$/i.test(
      label
    )
  );
}

function getUrlLabel(url: string) {
  const parsed = new URL(url);
  const finalSegment = parsed.pathname.split('/').filter(Boolean).at(-1);
  return finalSegment || parsed.hostname;
}
