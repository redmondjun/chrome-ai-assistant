import {
  extractContent,
  extractLinks,
  extractMeta,
  cleanElement,
  getMainContent,
  extractText,
} from './extractor';

describe('Content Extraction', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  describe('extractText', () => {
    it('extracts text from element', () => {
      const div = document.createElement('div');
      div.textContent = 'Hello World';
      const result = extractText(div);
      expect(result).toBe('Hello World');
    });

    it('skips script and style tags', () => {
      const div = document.createElement('div');
      div.innerHTML =
        '<p>Visible</p><script>console.log("hidden")</script><style>.hidden{display:none}</style>';
      const result = extractText(div);
      expect(result).toContain('Visible');
      expect(result).not.toContain('console.log');
      expect(result).not.toContain('.hidden');
    });

    it('filters short text nodes', () => {
      const div = document.createElement('div');
      div.innerHTML = '<p>A</p><p>This is a longer text</p>';
      const result = extractText(div);
      expect(result).toBe('This is a longer text');
    });
  });

  describe('cleanElement', () => {
    it('removes noise elements', () => {
      const div = document.createElement('div');
      div.innerHTML = '<p>Main content</p><nav>Navigation</nav><footer>Footer</footer>';
      cleanElement(div);
      expect(div.querySelector('nav')).toBeNull();
      expect(div.querySelector('footer')).toBeNull();
      expect(div.querySelector('p')).not.toBeNull();
    });

    it('keeps review comments as research evidence', () => {
      document.body.innerHTML = '<main><div class="comments">Useful review feedback</div></main>';
      const main = document.querySelector('main');
      if (!main) throw new Error('Missing test content');

      cleanElement(main);

      expect(main).toHaveTextContent('Useful review feedback');
    });

    it('removes ads and social elements', () => {
      const div = document.createElement('div');
      div.innerHTML = '<p>Content</p><div class="ads">Ad</div><div class="social">Share</div>';
      cleanElement(div);
      expect(div.querySelector('.ads')).toBeNull();
      expect(div.querySelector('.social')).toBeNull();
    });
  });

  describe('getMainContent', () => {
    it('finds article element', () => {
      const article = document.createElement('article');
      article.textContent = 'Article content';
      document.body.appendChild(article);
      const result = getMainContent();
      expect(result).toBe(article);
    });

    it('falls back to main element', () => {
      const main = document.createElement('main');
      main.textContent = 'Main content';
      document.body.appendChild(main);
      const result = getMainContent();
      expect(result).toBe(main);
    });

    it('falls back to body', () => {
      document.body.textContent = 'Body content';
      const result = getMainContent();
      expect(result).toBe(document.body);
    });

    it('chooses the richest matching content region for dynamically rendered wiki pages', () => {
      document.body.innerHTML = `
        <main>Loading</main>
        <div class="wiki-content">Detailed wiki content with substantially more useful text.</div>
      `;

      expect(getMainContent()).toBe(document.querySelector('.wiki-content'));
    });
  });

  describe('extractLinks', () => {
    it('extracts valid links', () => {
      document.body.innerHTML = '<a href="/page1">Page 1</a><a href="/page2">Page 2</a>';
      const links = extractLinks();
      expect(links).toHaveLength(2);
      expect(links[0].text).toBe('Page 1');
      expect(links[0].isExternal).toBe(false);
    });

    it('filters non-http links', () => {
      document.body.innerHTML =
        '<a href="mailto:test@test.com">Email</a><a href="#anchor">Anchor</a>';
      const links = extractLinks();
      expect(links).toHaveLength(0);
    });

    it('filters short link text', () => {
      document.body.innerHTML = '<a href="/page">A</a><a href="/page2">Valid link text</a>';
      const links = extractLinks();
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe('Valid link text');
    });

    it('extracts link context', () => {
      document.body.innerHTML = '<p>Check out <a href="/pricing">our pricing</a> page</p>';
      const links = extractLinks();
      expect(links[0].context).toContain('Check out our pricing page');
    });

    it('extracts plain-text URLs', () => {
      document.body.innerHTML =
        '<p>Review https://stash.globalrelay.net/projects/PORTAL/repos/app/pull-requests/1</p>';

      const links = extractLinks();

      expect(links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: 'https://stash.globalrelay.net/projects/PORTAL/repos/app/pull-requests/1',
          }),
        ])
      );
    });

    it('does not join plain-text URLs across adjacent elements', () => {
      document.body.innerHTML = `
        <span>https://stash.example.com/pull-requests/746/overview</span><span>Participates</span>
      `;

      const links = extractLinks();

      expect(links.map(link => link.url)).toEqual([
        'https://stash.example.com/pull-requests/746/overview',
      ]);
    });
  });

  describe('extractMeta', () => {
    it('extracts meta tags', () => {
      document.head.innerHTML =
        '<meta name="description" content="Test page"><meta property="og:title" content="OG Title">';
      const meta = extractMeta();
      expect(meta.description).toBe('Test page');
      expect(meta['og:title']).toBe('OG Title');
    });
  });

  describe('extractContent', () => {
    it('returns full tab content', () => {
      document.body.innerHTML = '<article><h1>Title</h1><p>Content</p></article>';
      document.head.innerHTML = '<meta name="description" content="Desc">';

      const content = extractContent();
      expect(content.title).toBe(document.title);
      expect(content.text).toContain('Title');
      expect(content.text).toContain('Content');
      expect(content.meta.description).toBe('Desc');
    });

    it('only includes links from the readable content area', () => {
      document.body.innerHTML = `
        <nav><a href="https://wiki.example.com/browsepeople.action">People</a></nav>
        <article><a href="https://stash.example.com/pull-requests/1">Supporting PR</a></article>
      `;

      const content = extractContent();

      expect(content.links.map(link => link.text)).toEqual(['Supporting PR']);
    });
  });
});
