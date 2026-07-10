import { extractContent } from './extractor';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_TAB_CONTENT') {
    try {
      const content = extractContent();
      sendResponse({ type: 'TAB_CONTENT', content });
    } catch (e) {
      sendResponse({ type: 'ERROR', message: String(e) });
    }
  }
  return true;
});
