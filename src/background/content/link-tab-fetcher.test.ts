import { fetchLinkContentInTab } from './link-tab-fetcher';

describe('fetchLinkContentInTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('extracts content from an inactive, authenticated browser tab and closes it', async () => {
    (chrome.tabs.create as jest.Mock).mockResolvedValue({ id: 7, status: 'complete' });
    (chrome.tabs.sendMessage as jest.Mock).mockImplementation((_tabId, _message, callback) =>
      callback({
        type: 'TAB_CONTENT',
        content: {
          url: 'https://stash.globalrelay.net/example',
          title: 'Internal source',
          text: 'Authenticated internal source content',
          links: [],
          meta: {},
          timestamp: 1,
        },
      })
    );
    (chrome.tabs.remove as jest.Mock).mockResolvedValue(undefined);

    await expect(fetchLinkContentInTab('https://stash.globalrelay.net/example')).resolves.toEqual({
      content: 'Authenticated internal source content',
      links: [],
      finalUrl: 'https://stash.globalrelay.net/example',
      title: 'Internal source',
    });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://stash.globalrelay.net/example',
      active: false,
    });
    expect((chrome.tabs.sendMessage as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(7);
  });

  it('blocks action URLs before creating an authenticated tab', async () => {
    const result = await fetchLinkContentInTab(
      'https://stash.example.com/plugins/servlet/createBranch?issueKey=SQ-1'
    );

    expect(result.error).toMatch(/blocked unsafe action/i);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});
