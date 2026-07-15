import type { TabContent, LinkInfo } from '@/shared/types';

const READABILITY_SELECTORS = [
  '.wiki-content',
  '#main-content',
  '#content-body',
  'article',
  '[role="main"]',
  '.content',
  '.post',
  '.article',
  '.entry',
  '#content',
  '#main',
  'main',
];

const NOISE_SELECTORS = [
  'nav',
  'header',
  'footer',
  'aside',
  '.nav',
  '.navigation',
  '.menu',
  '.sidebar',
  '.ads',
  '.advertisement',
  '.sponsor',
  '.comments',
  '.comment-form',
  '.social',
  '.share',
  '.sharing',
  'script',
  'style',
  'noscript',
  '[aria-hidden="true"]',
];

export function cleanElement(el: Element): void {
  NOISE_SELECTORS.forEach(sel => {
    el.querySelectorAll(sel).forEach(n => n.remove());
  });
}

export function getMainContent(): Element | null {
  const candidates = new Set<Element>();
  for (const sel of READABILITY_SELECTORS) {
    document.querySelectorAll(sel).forEach(element => candidates.add(element));
  }
  return (
    [...candidates].sort(
      (left, right) =>
        (right.textContent?.trim().length || 0) - (left.textContent?.trim().length || 0)
    )[0] || document.body
  );
}

export function extractText(el: Element): string {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  const texts: string[] = [];
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim();
    if (text && text.length > 1) {
      const parent = node.parentElement;
      if (parent && !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) {
        texts.push(text);
      }
    }
  }
  return texts.join('\n\n');
}

export function extractLinks(root: Element = document.body): LinkInfo[] {
  const links: LinkInfo[] = [];
  const seenUrls = new Set<string>();
  const anchors = root.querySelectorAll<HTMLAnchorElement>('a[href]');

  anchors.forEach(anchor => {
    const href = anchor.getAttribute('href');
    if (!href) return;
    if (href.trim().startsWith('#')) return;
    try {
      const url = new URL(href, window.location.origin).href;
      const text = anchor.textContent?.trim() || '';
      if (!text || text.length <= 1 || text.length > 200) return;
      if (!url.startsWith('http://') && !url.startsWith('https://')) return;

      const context = getLinkContext(anchor);

      if (seenUrls.has(url)) return;
      seenUrls.add(url);
      links.push({
        url,
        text,
        title: anchor.getAttribute('title') || undefined,
        context,
        isExternal: new URL(url).hostname !== window.location.hostname,
      });
    } catch {
      // Invalid URL
    }
  });

  const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let textNode: Node | null;
  while ((textNode = textWalker.nextNode())) {
    const currentTextNode = textNode;
    const rawUrls = textNode.textContent?.match(/https?:\/\/[^\s<>"')\]]+/g) || [];
    rawUrls.forEach(rawUrl => {
      const url = rawUrl.replace(/[.,;:]+$/, '');
      if (seenUrls.has(url)) return;
      try {
        const parsed = new URL(url);
        seenUrls.add(url);
        links.push({
          url,
          text: url,
          context:
            currentTextNode.parentElement?.textContent?.trim().slice(0, 300) ||
            'URL included as page text',
          isExternal: parsed.hostname !== window.location.hostname,
        });
      } catch {
        // Invalid URL
      }
    });
  }

  return links;
}

export function getLinkContext(anchor: HTMLAnchorElement): string {
  let parent = anchor.parentElement;
  let depth = 0;

  while (parent && depth < 3) {
    if (['P', 'LI', 'DIV', 'SECTION', 'ARTICLE', 'TD', 'TH'].includes(parent.tagName)) {
      const text = parent.textContent?.trim();
      if (text && text.length > text.length * 0.3) {
        return text.slice(0, 300);
      }
    }
    parent = parent.parentElement;
    depth++;
  }

  return '';
}

export function extractMeta(): Record<string, string> {
  const meta: Record<string, string> = {};
  document.querySelectorAll('meta[name], meta[property]').forEach(m => {
    const name = m.getAttribute('name') || m.getAttribute('property') || '';
    const content = m.getAttribute('content') || '';
    if (name && content) meta[name] = content;
  });
  return meta;
}

export function extractContent(): TabContent {
  const mainEl = getMainContent();
  if (!mainEl) {
    return {
      url: window.location.href,
      title: document.title,
      text: '',
      links: [],
      meta: {},
      timestamp: Date.now(),
    };
  }

  const clone = mainEl.cloneNode(true) as Element;
  cleanElement(clone);

  return {
    url: window.location.href,
    title: document.title,
    text: extractText(clone),
    links: extractLinks(clone),
    meta: extractMeta(),
    timestamp: Date.now(),
  };
}
