import type { TabContent, LinkInfo } from '@/shared/types';
import { evaluateLinkSafety } from '@/shared/link-safety';

const READABILITY_SELECTORS = [
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
    links: extractLinks(),
    meta: extractMeta(),
    timestamp: Date.now(),
  };
}

function getMainContent(): Element {
  for (const sel of READABILITY_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return document.body;
}

function extractText(el: Element): string {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  const texts: string[] = [];
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim();
    if (text && text.length > 10) {
      const parent = node.parentElement;
      if (parent && !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) {
        texts.push(text);
      }
    }
  }
  return texts.join('\n\n');
}

function extractLinks(): LinkInfo[] {
  const links: LinkInfo[] = [];
  const anchors = document.querySelectorAll('a[href]');

  anchors.forEach(anchor => {
    const href = anchor.getAttribute('href');
    if (!href) return;
    try {
      const url = new URL(href, window.location.origin).href;
      const text = anchor.textContent?.trim() || '';
      if (!text || text.length > 200) return;
      if (!url.startsWith('http://') && !url.startsWith('https://')) return;

      const context = getLinkContext(anchor as HTMLAnchorElement);

      const link: LinkInfo = {
        url,
        text,
        title: anchor.getAttribute('title') || undefined,
        context,
        isExternal: new URL(url).hostname !== window.location.hostname,
      };
      link.safety = evaluateLinkSafety(link);
      links.push(link);
    } catch {
      // Invalid URL
    }
  });

  return links;
}

function getLinkContext(anchor: HTMLAnchorElement): string {
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

function extractMeta(): Record<string, string> {
  const meta: Record<string, string> = {};
  document.querySelectorAll('meta[name], meta[property]').forEach(m => {
    const name = m.getAttribute('name') || m.getAttribute('property') || '';
    const content = m.getAttribute('content') || '';
    if (name && content) meta[name] = content;
  });
  return meta;
}

function cleanElement(el: Element): void {
  const noiseSelectors = [
    'script',
    'style',
    'noscript',
    'nav',
    'header',
    'footer',
    'aside',
    '.ad',
    '.ads',
    '.advertisement',
    '.sidebar',
    '.menu',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '[aria-hidden="true"]',
    '.hidden',
    '.visually-hidden',
  ];

  noiseSelectors.forEach(sel => {
    el.querySelectorAll(sel).forEach(n => n.remove());
  });
}
