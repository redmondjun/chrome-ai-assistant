import { getSettings, onSettingsChanged } from './storage/settings';
import { ModelRouter, createRouter } from './api/router';
import { analyzeWithReasoning, AnalysisCallbacks } from './pipeline/analyze';
import { getTabContent } from './content/tab-content';
import type { BackgroundMessage, TabContent, StorageSettings } from '@/shared/types';

let router: ModelRouter | null = null;
let routerInitialization: Promise<ModelRouter> | null = null;
let currentContent: TabContent | null = null;
const activeAnalyses = new Map<string, AbortController>();

function initializeRouter(): Promise<ModelRouter> {
  if (router) return Promise.resolve(router);
  if (routerInitialization) return routerInitialization;

  routerInitialization = getSettings()
    .then(settings => {
      const initializedRouter = createRouter(settings.model);
      router = initializedRouter;
      void initializedRouter.ensureLocalReady().catch(error => {
        console.error('[router]', 'Local model initialization failed:', error);
      });
      return initializedRouter;
    })
    .catch(error => {
      console.error('[router]', 'Initialization failed:', error);
      throw error;
    })
    .finally(() => {
      routerInitialization = null;
    });

  return routerInitialization;
}

void initializeRouter().catch(() => undefined);

onSettingsChanged(async settings => {
  try {
    const activeRouter = await initializeRouter();
    activeRouter.updateSettings(settings.model);
    await activeRouter.ensureLocalReady();
  } catch (error) {
    console.error('[router]', 'Could not apply updated settings:', error);
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
          if (!message.question) throw new Error('No question provided');
          const activeRouter = await initializeRouter();

          let content = message.context || currentContent;
          if (!content) {
            const tabId = message.tabId || sender.tab?.id;
            if (!tabId) throw new Error('No tab ID');
            content = await getTabContent(tabId);
          }

          const settings = await getSettings();
          const messageId = message.messageId;
          if (!messageId) throw new Error('No message ID');
          const controller = new AbortController();
          activeAnalyses.get(messageId)?.abort('Replaced by a newer request.');
          activeAnalyses.set(messageId, controller);
          const startedAt = Date.now();
          console.info('[analysis]', 'request-started', { messageId });

          const callbacks: AnalysisCallbacks = {
            onChunk: chunk => {
              chrome.runtime.sendMessage({
                type: 'STREAM_CHUNK',
                chunk,
                messageId,
              });
            },
            onReasoning: step => {
              chrome.runtime.sendMessage({
                type: 'REASONING',
                step,
                messageId,
              });
            },
            onLinkVisit: visit => {
              chrome.runtime.sendMessage({
                type: 'LINK_VISIT',
                visit,
                messageId,
              });
            },
            onLinkDecision: decision => {
              chrome.runtime.sendMessage({
                type: 'LINK_DECISION',
                decision,
                messageId,
              });
            },
            onDone: () => {
              chrome.runtime.sendMessage({
                type: 'STREAM_DONE',
                messageId,
              });
            },
          };

          analyzeWithReasoning(
            activeRouter,
            content,
            message.question,
            settings,
            callbacks,
            message.history,
            controller.signal
          )
            .catch(err => {
              if (controller.signal.aborted) {
                console.info('[analysis]', 'request-stopped', {
                  messageId,
                  elapsedMs: Date.now() - startedAt,
                });
                return;
              }
              console.error('[analysis]', 'request-failed', {
                messageId,
                elapsedMs: Date.now() - startedAt,
                error: err instanceof Error ? err.message : String(err),
              });
              chrome.runtime.sendMessage({
                type: 'ERROR',
                message: err instanceof Error ? err.message : String(err),
                messageId,
              });
            })
            .finally(() => {
              if (activeAnalyses.get(messageId) === controller) activeAnalyses.delete(messageId);
            });

          sendResponse({ ok: true });
          break;
        }

        case 'STOP_GENERATION': {
          const messageId = message.messageId;
          const controller = messageId ? activeAnalyses.get(messageId) : undefined;
          controller?.abort('Stopped by user.');
          sendResponse({ ok: Boolean(controller) });
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
