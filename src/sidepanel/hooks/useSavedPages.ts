import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  canonicalizeSavedPageUrl,
  loadSavedPageState,
  saveSavedPageState,
  type SavedPageState,
} from '../saved-page-storage';
import type { SavedPage, TabContent } from '@/shared/types';
import { ACCOUNT_STATE_KEY, ANONYMOUS_SCOPE } from '@/shared/storage';
import { evaluateLinkSafety } from '@/shared/link-safety';

const EMPTY_STATE: SavedPageState = { pages: [], selections: {} };
const MAX_SNAPSHOT_TEXT = 15_000;

export function useSavedPages(conversationId?: string) {
  const [scope, setScope] = useState(ANONYMOUS_SCOPE);
  const [state, setState] = useState<SavedPageState>(EMPTY_STATE);
  const [isLoaded, setIsLoaded] = useState(false);
  const selectedIds = conversationId ? state.selections[conversationId] || [] : [];
  const selectedPages = useMemo(
    () => state.pages.filter(page => selectedIds.includes(page.id)),
    [selectedIds, state.pages]
  );

  useEffect(() => {
    const loadScope = () =>
      void chrome.storage.local.get(ACCOUNT_STATE_KEY).then(result => {
        setScope(result[ACCOUNT_STATE_KEY]?.user?.id || ANONYMOUS_SCOPE);
      });
    const handleMessage = (message: { type?: string; account?: { user?: { id?: string } } }) => {
      if (message.type === 'ACCOUNT_STATE_CHANGED') {
        setScope(message.account?.user?.id || ANONYMOUS_SCOPE);
      }
    };
    loadScope();
    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  useEffect(() => {
    let active = true;
    setIsLoaded(false);
    void loadSavedPageState(scope).then(saved => {
      if (!active) return;
      setState(saved);
      setIsLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [scope]);

  const commit = useCallback(
    (update: (current: SavedPageState) => SavedPageState) => {
      setState(current => {
        const next = update(current);
        void saveSavedPageState(scope, next).catch(error =>
          console.error('[attachments]', 'Could not save page library:', error)
        );
        return next;
      });
    },
    [scope]
  );

  const addSnapshot = useCallback(
    (content: TabContent) => {
      if (!conversationId) return;
      const page = toSavedPage(content);
      commit(current => {
        const existing = current.pages.find(item => item.url === page.url);
        const saved = existing ? { ...page, id: existing.id } : page;
        const pages = existing
          ? current.pages.map(item => (item.id === existing.id ? saved : item))
          : [...current.pages, saved];
        const ids = current.selections[conversationId] || [];
        return {
          pages,
          selections: {
            ...current.selections,
            [conversationId]: ids.includes(saved.id) ? ids : [...ids, saved.id],
          },
        };
      });
    },
    [commit, conversationId]
  );

  const select = useCallback(
    (pageId: string, selected: boolean) => {
      if (!conversationId) return;
      commit(current => {
        const ids = current.selections[conversationId] || [];
        return {
          ...current,
          selections: {
            ...current.selections,
            [conversationId]: selected
              ? ids.includes(pageId)
                ? ids
                : [...ids, pageId]
              : ids.filter(id => id !== pageId),
          },
        };
      });
    },
    [commit, conversationId]
  );

  const remove = useCallback(
    (pageId: string) => {
      commit(current => ({
        pages: current.pages.filter(page => page.id !== pageId),
        selections: Object.fromEntries(
          Object.entries(current.selections).map(([id, ids]) => [
            id,
            ids.filter(selectedId => selectedId !== pageId),
          ])
        ),
      }));
    },
    [commit]
  );

  const replaceSnapshot = useCallback(
    (pageId: string, content: TabContent) => {
      commit(current => ({
        ...current,
        pages: current.pages.map(page =>
          page.id === pageId ? { ...toSavedPage(content), id: pageId } : page
        ),
      }));
    },
    [commit]
  );

  const setRefreshWarning = useCallback(
    (pageId: string, warning: string) => {
      commit(current => ({
        ...current,
        pages: current.pages.map(page =>
          page.id === pageId ? { ...page, refreshWarning: warning } : page
        ),
      }));
    },
    [commit]
  );

  return {
    pages: state.pages,
    selectedIds,
    selectedPages,
    isLoaded,
    addSnapshot,
    select,
    remove,
    replaceSnapshot,
    setRefreshWarning,
  };
}

function toSavedPage(content: TabContent): SavedPage {
  return {
    id: crypto.randomUUID(),
    url: canonicalizeSavedPageUrl(content.url),
    title: content.title,
    text: content.text.slice(0, MAX_SNAPSHOT_TEXT),
    links: content.links.filter(link => evaluateLinkSafety(link).safe),
    capturedAt: Date.now(),
  };
}
