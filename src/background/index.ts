import { getSettings, onSettingsChanged, saveSettings } from './storage/settings';
import {
  getAccountState,
  initializeAccount,
  pullSync,
  pushConversations,
  pushSettings,
  requestRecovery,
  signIn,
  signInWithGoogle,
  signOut,
  signUp,
  updatePassword,
  verifyEmail,
  verifyRecovery,
} from './sync/supabase';
import { ModelRouter, createRouter } from './api/router';
import { analyzeWithReasoning, AnalysisCallbacks } from './pipeline/analyze';
import { getTabContent } from './content/tab-content';
import { fetchLinkContentInTab } from './content/link-tab-fetcher';
import { ResearchCoordinator, RESEARCH_RESUME_ALARM } from './research/coordinator';
import { buildConversationResearchContext } from './research/context';
import { buildConversationBrief, getPriorResearchJobIds } from './conversation-memory';
import { resolveDirectedResearchRequest } from './research/directed-request';
import type { BackgroundMessage, ChatMessage, SavedPage, TabContent } from '@/shared/types';

let router: ModelRouter | null = null;
let routerInitialization: Promise<ModelRouter> | null = null;
let currentContent: TabContent | null = null;
const activeAnalyses = new Map<string, AbortController>();

function initializeRouter(): Promise<ModelRouter> {
  if (router) return Promise.resolve(router);
  if (routerInitialization) return routerInitialization;

  routerInitialization = getSettings()
    .then(settings => {
      const initializedRouter = createRouter(settings.model, settings.privacy.localOnly);
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

const researchCoordinator = new ResearchCoordinator(initializeRouter, getSettings);

void initializeRouter().catch(() => undefined);
void initializeAccount().catch(error =>
  console.error('[account]', 'Initialization failed:', error)
);
void researchCoordinator.resumePendingJobs();

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RESEARCH_RESUME_ALARM) void researchCoordinator.resumePendingJobs();
});

chrome.runtime.onStartup.addListener(() => void researchCoordinator.resumePendingJobs());

onSettingsChanged(async settings => {
  try {
    const activeRouter = await initializeRouter();
    activeRouter.updateSettings(settings.model, settings.privacy.localOnly);
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

        case 'GET_URL_CONTENT': {
          if (!message.url) throw new Error('No page URL provided.');
          const result = await fetchLinkContentInTab(message.url);
          if (!result.content || !result.finalUrl || !result.title) {
            throw new Error(result.error || 'The page did not return readable content.');
          }
          sendResponse({
            type: 'TAB_CONTENT',
            content: {
              url: result.finalUrl,
              title: result.title,
              text: result.content,
              links: result.links || [],
              meta: {},
              timestamp: Date.now(),
            },
          });
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
          const researchContext = await getConversationResearchContext(message.history);
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
            mergeContextPages(content, message.contextPages || []),
            message.question,
            settings,
            callbacks,
            message.history,
            controller.signal,
            researchContext
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

        case 'START_RESEARCH': {
          if (!message.question || !message.messageId) throw new Error('Missing research request.');
          let content = message.context || currentContent;
          if (!content) {
            const tabId = message.tabId || sender.tab?.id;
            if (!tabId) throw new Error('No tab ID');
            content = await getTabContent(tabId);
          }
          const researchRequest = await resolveDirectedResearchRequest(
            content,
            message.contextPages || [],
            message.question,
            fetchRequestPage
          );
          const job = await researchCoordinator.start(
            researchRequest.content,
            researchRequest.contextPages,
            message.question,
            message.messageId,
            buildConversationBrief(message.history || [], message.question),
            getPriorResearchJobIds(message.history || []),
            researchRequest.subjectSelection
          );
          sendResponse({ ok: true, jobId: job.id, progress: job.progress });
          break;
        }

        case 'PAUSE_RESEARCH': {
          if (!message.jobId) throw new Error('No research job ID.');
          const job = await researchCoordinator.pause(message.jobId);
          sendResponse({ ok: Boolean(job), progress: job?.progress });
          break;
        }

        case 'RESUME_RESEARCH': {
          if (!message.jobId) throw new Error('No research job ID.');
          const job = await researchCoordinator.resume(message.jobId);
          sendResponse({ ok: Boolean(job), progress: job?.progress });
          break;
        }

        case 'CANCEL_RESEARCH': {
          if (!message.jobId) throw new Error('No research job ID.');
          const job = await researchCoordinator.cancel(message.jobId);
          sendResponse({ ok: Boolean(job), progress: job?.progress });
          break;
        }

        case 'RETRY_RESEARCH': {
          if (!message.jobId) throw new Error('No research job ID.');
          const job = await researchCoordinator.retry(message.jobId);
          sendResponse({ ok: Boolean(job), progress: job?.progress });
          break;
        }

        case 'GET_RESEARCH_JOB': {
          if (!message.jobId) throw new Error('No research job ID.');
          sendResponse({ job: await researchCoordinator.getJob(message.jobId) });
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
          void pushSettings().catch(error => console.warn('[sync]', error));
          sendResponse({ ok: true });
          break;
        }

        case 'AUTH_GET_STATE': {
          sendResponse({ account: await getAccountState() });
          break;
        }

        case 'AUTH_SIGN_UP': {
          sendResponse(
            await signUp(required(message.email, 'email'), required(message.password, 'password'))
          );
          break;
        }

        case 'AUTH_VERIFY_EMAIL': {
          await verifyEmail(required(message.email, 'email'), required(message.token, 'token'));
          sendResponse({ ok: true });
          break;
        }

        case 'AUTH_SIGN_IN': {
          await signIn(required(message.email, 'email'), required(message.password, 'password'));
          sendResponse({ ok: true });
          break;
        }

        case 'AUTH_SIGN_IN_GOOGLE': {
          await signInWithGoogle();
          sendResponse({ ok: true });
          break;
        }

        case 'AUTH_REQUEST_RECOVERY': {
          await requestRecovery(required(message.email, 'email'));
          sendResponse({ ok: true });
          break;
        }

        case 'AUTH_VERIFY_RECOVERY': {
          await verifyRecovery(required(message.email, 'email'), required(message.token, 'token'));
          sendResponse({ ok: true });
          break;
        }

        case 'AUTH_UPDATE_PASSWORD': {
          await updatePassword(required(message.password, 'password'));
          sendResponse({ ok: true });
          break;
        }

        case 'AUTH_SIGN_OUT': {
          await signOut();
          sendResponse({ ok: true });
          break;
        }

        case 'SYNC_PULL': {
          sendResponse({ conversations: await pullSync() });
          break;
        }

        case 'SYNC_PUSH_CONVERSATIONS': {
          await pushConversations(message.conversations || []);
          sendResponse({ ok: true });
          break;
        }

        case 'SYNC_PUSH_SETTINGS': {
          await pushSettings();
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
      sendResponse({ error: error instanceof Error ? error.message : String(error) });
    }
  })();
  return true;
});

function mergeContextPages(primary: TabContent, pages: SavedPage[]): TabContent {
  if (pages.length === 0) return primary;
  const warnings = pages
    .filter(page => page.refreshWarning)
    .map(page => `${page.title}: ${page.refreshWarning}`);
  return {
    ...primary,
    text: [
      `PRIMARY PAGE\n${primary.title}\n${primary.url}\n\n${primary.text}`,
      ...pages.map(
        page =>
          `ATTACHED SAVED PAGE\n${page.title}\n${page.url}\nCaptured: ${new Date(page.capturedAt).toISOString()}${page.refreshWarning ? `\nWarning: ${page.refreshWarning}` : ''}\n\n${page.text}`
      ),
      warnings.length > 0 ? `ATTACHMENT WARNINGS\n${warnings.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n---\n\n'),
    links: [...primary.links, ...pages.flatMap(page => page.links)],
  };
}

async function fetchRequestPage(url: string): Promise<TabContent> {
  const result = await fetchLinkContentInTab(url);
  if (!result.content || !result.finalUrl) {
    throw new Error(result.error || `Could not read the requested research page: ${url}`);
  }
  return {
    url: result.finalUrl,
    title: result.title || result.finalUrl,
    text: result.content,
    links: result.links || [],
    meta: {},
    timestamp: Date.now(),
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function getConversationResearchContext(history: ChatMessage[] = []) {
  const jobIds = getPriorResearchJobIds(history);
  if (jobIds.length === 0) return undefined;
  const jobs = (await Promise.all(jobIds.map(jobId => researchCoordinator.getJob(jobId)))).filter(
    job => job !== undefined
  );
  return buildConversationResearchContext(jobs);
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
chrome.sidePanel.setOptions({ enabled: true, path: 'sidepanel/index.html' });

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: true, path: 'sidepanel/index.html' });
});
