import React, { useState } from 'react';
import type { SavedPage, TabContent } from '@/shared/types';

interface PageAttachmentsProps {
  pages: SavedPage[];
  selectedIds: string[];
  disabled: boolean;
  onAdd: (content: TabContent) => void;
  onSelect: (pageId: string, selected: boolean) => void;
  onRemove: (pageId: string) => void;
  onRefresh: (pageId: string, content: TabContent) => void;
  onRefreshWarning: (pageId: string, warning: string) => void;
}

export function PageAttachments({
  pages,
  selectedIds,
  disabled,
  onAdd,
  onSelect,
  onRemove,
  onRefresh,
  onRefreshWarning,
}: PageAttachmentsProps) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string>();

  const loadTabs = async () => {
    const openTabs = await chrome.tabs.query({ currentWindow: true });
    setTabs(openTabs.filter(tab => !tab.active && tab.id && /^https?:\/\//.test(tab.url || '')));
  };

  const readTab = async (tabId: number) => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_TAB_CONTENT', tabId });
    if (response?.type !== 'TAB_CONTENT' || !isTabContent(response.content)) {
      throw new Error(response?.error || 'The selected tab could not be read.');
    }
    return response.content;
  };

  const readUrl = async (pageUrl: string) => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_URL_CONTENT', url: pageUrl });
    if (response?.type !== 'TAB_CONTENT' || !isTabContent(response.content)) {
      throw new Error(response?.error || 'The page could not be read.');
    }
    return response.content;
  };

  const addOpenTab = async (tab: chrome.tabs.Tab) => {
    if (!tab.id) return;
    setBusyId(`tab:${tab.id}`);
    setError('');
    try {
      onAdd(await readTab(tab.id));
    } catch (readError) {
      setError(toMessage(readError));
    } finally {
      setBusyId(undefined);
    }
  };

  const addUrl = async () => {
    const pageUrl = url.trim();
    if (!pageUrl) return;
    setBusyId('url');
    setError('');
    try {
      const parsed = new URL(pageUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Enter an HTTP(S) URL.');
      onAdd(await readUrl(parsed.href));
      setUrl('');
    } catch (readError) {
      setError(toMessage(readError));
    } finally {
      setBusyId(undefined);
    }
  };

  const refresh = async (page: SavedPage) => {
    setBusyId(page.id);
    setError('');
    try {
      onRefresh(page.id, await readUrl(page.url));
    } catch (readError) {
      const warning = `Refresh failed: ${toMessage(readError)}`;
      onRefreshWarning(page.id, warning);
      setError(warning);
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <section className="page-attachments">
      <button
        type="button"
        className="attach-pages-button"
        disabled={disabled}
        onClick={() => {
          setOpen(current => !current);
          if (!open) void loadTabs();
        }}
      >
        Attach pages{selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
      </button>
      {open && (
        <div className="page-attachments-panel" aria-label="Attach pages">
          <div className="page-attachments-heading">
            <strong>Attach pages</strong>
            <button type="button" aria-label="Close attach pages" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          <form
            className="page-url-form"
            onSubmit={event => {
              event.preventDefault();
              void addUrl();
            }}
          >
            <input
              type="url"
              value={url}
              disabled={Boolean(busyId)}
              onChange={event => setUrl(event.target.value)}
              placeholder="Paste a page URL"
              aria-label="Page URL"
            />
            <button type="submit" disabled={!url.trim() || Boolean(busyId)}>
              Add
            </button>
          </form>
          {tabs.length > 0 && (
            <div className="open-tab-list">
              <strong>Open tabs</strong>
              {tabs.map(tab => (
                <button
                  type="button"
                  key={tab.id}
                  disabled={Boolean(busyId)}
                  title={tab.url}
                  onClick={() => void addOpenTab(tab)}
                >
                  {busyId === `tab:${tab.id}` ? 'Reading…' : tab.title || tab.url}
                </button>
              ))}
            </div>
          )}
          <div className="saved-page-list">
            <strong>Remembered pages</strong>
            {pages.length === 0 ? (
              <small>No pages saved yet.</small>
            ) : (
              pages.map(page => (
                <div className="saved-page" key={page.id}>
                  <label title={page.url}>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(page.id)}
                      onChange={event => onSelect(page.id, event.target.checked)}
                    />
                    <span>{page.title}</span>
                  </label>
                  <small>
                    Saved {new Date(page.capturedAt).toLocaleString()}
                    {page.refreshWarning ? ` · ${page.refreshWarning}` : ''}
                  </small>
                  <div>
                    <button
                      type="button"
                      disabled={Boolean(busyId)}
                      onClick={() => void refresh(page)}
                    >
                      {busyId === page.id ? 'Refreshing…' : 'Refresh'}
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(busyId)}
                      onClick={() => onRemove(page.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          {error && <p className="attachment-error">{error}</p>}
        </div>
      )}
    </section>
  );
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isTabContent(value: unknown): value is TabContent {
  return (
    value !== null &&
    typeof value === 'object' &&
    'url' in value &&
    typeof value.url === 'string' &&
    'title' in value &&
    typeof value.title === 'string' &&
    'text' in value &&
    typeof value.text === 'string' &&
    'links' in value &&
    Array.isArray(value.links) &&
    'meta' in value &&
    value.meta !== null &&
    typeof value.meta === 'object' &&
    'timestamp' in value &&
    typeof value.timestamp === 'number'
  );
}
