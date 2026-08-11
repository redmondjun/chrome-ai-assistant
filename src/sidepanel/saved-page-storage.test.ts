import {
  canonicalizeSavedPageUrl,
  loadSavedPageState,
  saveSavedPageState,
} from './saved-page-storage';
import { conversationPagesKey, savedPagesKey } from '@/shared/storage';
import type { SavedPage } from '@/shared/types';

describe('saved page storage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('loads the device-local library separately from conversation selections', async () => {
    const page = createPage();
    (chrome.storage.local.get as jest.Mock).mockResolvedValue({
      [savedPagesKey('user-1')]: [page],
      [conversationPagesKey('user-1')]: { 'chat-1': [page.id], 'chat-2': [] },
    });

    await expect(loadSavedPageState('user-1')).resolves.toEqual({
      pages: [page],
      selections: { 'chat-1': [page.id], 'chat-2': [] },
    });
  });

  it('saves page content and selections only to local storage', async () => {
    const state = { pages: [createPage()], selections: { 'chat-1': ['page-1'] } };
    await saveSavedPageState('user-1', state);

    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [savedPagesKey('user-1')]: state.pages,
      [conversationPagesKey('user-1')]: state.selections,
    });
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('canonicalizes fragments when deduplicating saved pages', () => {
    expect(canonicalizeSavedPageUrl('https://wiki.example.com/page#comments')).toBe(
      'https://wiki.example.com/page'
    );
  });
});

function createPage(): SavedPage {
  return {
    id: 'page-1',
    url: 'https://wiki.example.com/page',
    title: 'Promotion plan',
    text: 'Qualification criteria',
    links: [],
    capturedAt: 1,
  };
}
