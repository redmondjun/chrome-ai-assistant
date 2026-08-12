import type { SavedPage } from '@/shared/types';
import { conversationPagesKey, savedPagesKey } from '@/shared/storage';

export interface SavedPageState {
  pages: SavedPage[];
  selections: Record<string, string[]>;
}

const pendingWrites = new Map<string, Promise<void>>();

export async function loadSavedPageState(scope: string): Promise<SavedPageState> {
  const result = await chrome.storage.local.get([
    savedPagesKey(scope),
    conversationPagesKey(scope),
  ]);
  const pages = result[savedPagesKey(scope)];
  const selections = result[conversationPagesKey(scope)];
  return {
    pages: Array.isArray(pages) ? pages.filter(isSavedPage) : [],
    selections: isSelectionMap(selections) ? selections : {},
  };
}

export async function saveSavedPageState(scope: string, state: SavedPageState) {
  const snapshot = structuredClone(state);
  const previous = pendingWrites.get(scope) || Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(() =>
      chrome.storage.local.set({
        [savedPagesKey(scope)]: snapshot.pages,
        [conversationPagesKey(scope)]: snapshot.selections,
      })
    );
  pendingWrites.set(scope, write);
  try {
    await write;
  } finally {
    if (pendingWrites.get(scope) === write) pendingWrites.delete(scope);
  }
}

export function canonicalizeSavedPageUrl(url: string) {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
}

function isSavedPage(value: unknown): value is SavedPage {
  return (
    value !== null &&
    typeof value === 'object' &&
    'id' in value &&
    typeof value.id === 'string' &&
    'url' in value &&
    typeof value.url === 'string' &&
    'title' in value &&
    typeof value.title === 'string' &&
    'text' in value &&
    typeof value.text === 'string' &&
    'links' in value &&
    Array.isArray(value.links) &&
    'capturedAt' in value &&
    typeof value.capturedAt === 'number'
  );
}

function isSelectionMap(value: unknown): value is Record<string, string[]> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string'))
  );
}
