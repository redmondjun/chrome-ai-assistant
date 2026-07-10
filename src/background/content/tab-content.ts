import type { TabContent } from '@/shared/types';

export async function getTabContent(tabId: number): Promise<TabContent> {
  try {
    return await requestTabContent(tabId);
  } catch (firstError) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-script/index.js'],
      });
      return await requestTabContent(tabId);
    } catch (injectionError) {
      const message =
        injectionError instanceof Error ? injectionError.message : String(injectionError);
      throw new Error(
        message.includes('Cannot access') || message.includes('chrome://')
          ? 'Chrome does not allow extensions to read this page. Open a regular website and try again.'
          : `Could not read the active page: ${message || String(firstError)}`
      );
    }
  }
}

function requestTabContent(tabId: number): Promise<TabContent> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_TAB_CONTENT' }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.type === 'TAB_CONTENT') {
        resolve(response.content);
      } else {
        reject(new Error('Failed to get tab content'));
      }
    });
  });
}
