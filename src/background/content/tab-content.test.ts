import { getTabContent } from './tab-content';
import type { TabContent } from '@/shared/types';

const content: TabContent = {
  url: 'https://example.com/article',
  title: 'Example article',
  text: 'Readable page content',
  links: [],
  meta: {},
  timestamp: 1,
};

describe('getTabContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (chrome.runtime as any).lastError = null;
    (chrome as any).scripting = { executeScript: jest.fn() };
  });

  it('returns content when the content script is already available', async () => {
    (chrome.tabs.sendMessage as jest.Mock).mockImplementation((_tabId, _message, callback) => {
      callback({ type: 'TAB_CONTENT', content });
    });

    await expect(getTabContent(42)).resolves.toEqual(content);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('injects the content script and retries for an already-open tab', async () => {
    (chrome.tabs.sendMessage as jest.Mock)
      .mockImplementationOnce((_tabId, _message, callback) => {
        (chrome.runtime as any).lastError = {
          message: 'Could not establish connection. Receiving end does not exist.',
        };
        callback(undefined);
        (chrome.runtime as any).lastError = null;
      })
      .mockImplementationOnce((_tabId, _message, callback) =>
        callback({ type: 'TAB_CONTENT', content })
      );
    (chrome.scripting.executeScript as jest.Mock).mockResolvedValue([]);

    await expect(getTabContent(42)).resolves.toEqual(content);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: ['content-script/index.js'],
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('returns a useful error for Chrome-restricted pages', async () => {
    (chrome.tabs.sendMessage as jest.Mock).mockImplementation((_tabId, _message, callback) => {
      (chrome.runtime as any).lastError = { message: 'Could not establish connection.' };
      callback(undefined);
      (chrome.runtime as any).lastError = null;
    });
    (chrome.scripting.executeScript as jest.Mock).mockRejectedValue(
      new Error('Cannot access a chrome:// URL')
    );

    await expect(getTabContent(42)).rejects.toThrow(
      'Chrome does not allow extensions to read this page'
    );
  });
});
