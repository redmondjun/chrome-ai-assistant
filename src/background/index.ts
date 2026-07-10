import { getSettings, onSettingsChanged } from './storage/settings';
import { ModelRouter, createRouter } from './api/router';
import { analyzeWithReasoning, AnalysisCallbacks } from './pipeline/analyze';
import { getTabContent } from './content/tab-content';
import type { BackgroundMessage, TabContent, StorageSettings } from '@/shared/types';

let router: ModelRouter | null = null;
let currentContent: TabContent | null = null;

async function init() {
  const settings = await getSettings();
  router = createRouter(settings.model);
  await router.ensureLocalReady();
}

init();

onSettingsChanged(async settings => {
  if (router) {
    router.updateSettings(settings.model);
    await router.ensureLocalReady();
  }
});

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'GET_TAB_CONTENT': {
          const tabId = message.tabId || sender.tab?.id;
          if (!tabId) throw new Error('No tab ID');

          const content = await getTabContent(tabId);
          currentContent = content;
          sendResponse({ type: 'TAB_CONTENT', content });
          break;
        }

        case 'ASK_QUESTION': {
          if (!router) throw new Error('Router not initialized');
          if (!message.question) throw new Error('No question provided');

          let content = message.context || currentContent;
          if (!content) {
            const tabId = message.tabId || sender.tab?.id;
            if (!tabId) throw new Error('No tab ID');
            content = await getTabContent(tabId);
          }

          const settings = await getSettings();

          const callbacks: AnalysisCallbacks = {
            onChunk: chunk => {
              chrome.runtime.sendMessage({
                type: 'STREAM_CHUNK',
                chunk,
                messageId: message.messageId,
              });
            },
            onReasoning: step => {
              chrome.runtime.sendMessage({
                type: 'REASONING',
                step,
                messageId: message.messageId,
              });
            },
            onLinkVisit: visit => {
              chrome.runtime.sendMessage({
                type: 'LINK_VISIT',
                visit,
                messageId: message.messageId,
              });
            },
            onDone: () => {
              chrome.runtime.sendMessage({
                type: 'STREAM_DONE',
                messageId: message.messageId,
              });
            },
          };

          analyzeWithReasoning(router, content, message.question, settings, callbacks).catch(
            err => {
              chrome.runtime.sendMessage({
                type: 'ERROR',
                message: err.message,
                messageId: message.messageId,
              });
            }
          );

          sendResponse({ ok: true });
          break;
        }

        case 'FOLLOW_LINKS': {
          sendResponse({ ok: true });
          break;
        }

        case 'GET_SETTINGS': {
          const settings = await getSettings();
          sendResponse({ type: 'SETTINGS', settings });
          break;
        }

        case 'UPDATE_SETTINGS': {
          await saveSettings(message.settings || {});
          sendResponse({ ok: true });
          break;
        }

        case 'PING': {
          sendResponse({ type: 'PONG' });
          break;
        }

        default:
          sendResponse({ error: 'Unknown message type' });
      }
    } catch (error) {
      sendResponse({ error: String(error) });
    }
  })();
  return true;
});

async function saveSettings(settings: Partial<StorageSettings>): Promise<void> {
  const current = await getSettings();
  const merged = deepMerge(current, settings);
  await chrome.storage.sync.set({ 'chrome-ai-settings': merged });
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
chrome.sidePanel.setOptions({ enabled: true, path: 'sidepanel/index.html' });

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: true, path: 'sidepanel/index.html' });
});
