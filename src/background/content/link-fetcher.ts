export interface FetchResult {
  url: string;
  success: boolean;
  content?: string;
  title?: string;
  error?: string;
}

const MAX_CONCURRENT = 3;
const TIMEOUT = 15000;

export class LinkFetcher {
  private queue: Array<{ url: string; resolve: (r: FetchResult) => void }> = [];
  private running = 0;
  private visited = new Set<string>();

  async fetch(url: string): Promise<FetchResult> {
    if (this.visited.has(url)) {
      return { url, success: false, error: 'Already visited' };
    }
    this.visited.add(url);

    return new Promise(resolve => {
      this.queue.push({ url, resolve });
      this.processQueue();
    });
  }

  async fetchMultiple(urls: string[]): Promise<FetchResult[]> {
    return Promise.all(urls.map(u => this.fetch(u)));
  }

  private async processQueue(): Promise<void> {
    if (this.running >= MAX_CONCURRENT || this.queue.length === 0) return;

    this.running++;
    const item = this.queue.shift()!;

    try {
      const result = await this.fetchUrl(item.url);
      item.resolve(result);
    } catch (e) {
      item.resolve({ url: item.url, success: false, error: String(e) });
    } finally {
      this.running--;
      this.processQueue();
    }
  }

  private async fetchUrl(url: string): Promise<FetchResult> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Chrome-AI-Assistant/1.0' },
        credentials: 'include',
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return { url, success: false, error: `HTTP ${response.status}` };
      }

      const html = await response.text();
      const { content, title } = extractFromHtml(html, url);

      return { url, success: true, content, title };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return { url, success: false, error: 'Timeout' };
      }
      return { url, success: false, error: String(e) };
    }
  }
}

function extractFromHtml(html: string, _baseUrl: string): { content: string; title: string } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove noise
  const noise = doc.querySelectorAll(
    'script, style, noscript, nav, header, footer, aside, .ads, .navigation, .menu, .sidebar'
  );
  noise.forEach(n => n.remove());

  // Get title
  const title = doc.querySelector('title')?.textContent?.trim() || '';

  // Get main content
  const selectors = [
    'article',
    '[role="main"]',
    '.content',
    '.post',
    '.article',
    '#content',
    '#main',
    'main',
  ];
  let main: Element | null = null;
  for (const sel of selectors) {
    main = doc.querySelector(sel);
    if (main) break;
  }
  if (!main) main = doc.body;

  // Extract text
  const walker = doc.createTreeWalker(main, NodeFilter.SHOW_TEXT, null);
  const texts: string[] = [];
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim();
    if (text && text.length > 20) {
      texts.push(text);
    }
  }

  return {
    title,
    content: texts.join('\n\n').slice(0, 50000),
  };
}
