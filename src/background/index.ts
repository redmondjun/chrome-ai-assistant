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
import { ResearchCoordinator, RESEARCH_RESUME_ALARM } from './research/coordinator';
import { buildResearchConversationContext } from './research/context';
import {
  checkForStalledRuns,
  clearDiagnosticHistory,
  DIAGNOSTIC_STALL_ALARM,
  exportDiagnostics,
  finishAgentRun,
  getAgentRun,
  heartbeatAgentRun,
  reconcileInterruptedRuns,
  recordDiagnostic,
  startAgentRun,
  toAgentRunProgress,
} from './diagnostics';
import type { AgentOperation, BackgroundMessage, ChatMessage, TabContent } from '@/shared/types';

let router: ModelRouter | null = null;
let routerInitialization: Promise<ModelRouter> | null = null;
let currentContent: TabContent | null = null;
const activeAnalyses = new Map<string, { controller: AbortController; attemptId: string }>();

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
void reconcileInterruptedRuns();
chrome.alarms.create(DIAGNOSTIC_STALL_ALARM, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RESEARCH_RESUME_ALARM) void researchCoordinator.resumePendingJobs();
  if (alarm.name === DIAGNOSTIC_STALL_ALARM) {
    void checkForStalledRuns();
  }
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

        case 'ASK_QUESTION':
        case 'RETRY_AGENT_RUN': {
          if (!message.question) throw new Error('No question provided');
          const messageId = message.messageId;
          if (!messageId) throw new Error('No message ID');
          const run = await startAgentRun({
            kind: 'standard',
            messageId,
            activity: 'Preparing the request.',
          });
          await advanceRun(run.attemptId, 'Preparing the model.', 'router');
          let activeRouter: ModelRouter;
          let content = message.context || currentContent;
          let settings;
          let researchContext;
          try {
            activeRouter = await initializeRouter();
            if (!content) {
              await advanceRun(run.attemptId, 'Reading the active page.', 'content');
              const tabId = message.tabId || sender.tab?.id;
              if (!tabId) throw new Error('No tab ID');
              content = await getTabContent(tabId);
            }
            settings = await getSettings();
            researchContext = await getConversationResearchContext(message.history);
          } catch (error) {
            await finishAgentRun(run.attemptId, 'failed', error);
            throw error;
          }
          const controller = new AbortController();
          activeAnalyses.get(messageId)?.controller.abort('Replaced by a newer request.');
          activeAnalyses.set(messageId, { controller, attemptId: run.attemptId });
          const startedAt = Date.now();
          console.info('[analysis]', 'request-started', { messageId });
          let lastTokenHeartbeat = 0;
          let receivedFirstToken = false;

          const callbacks: AnalysisCallbacks = {
            onChunk: chunk => {
              sendRuntimeMessage({
                type: 'STREAM_CHUNK',
                chunk,
                messageId,
              });
              const now = Date.now();
              if (lastTokenHeartbeat === 0 || now - lastTokenHeartbeat >= 5000) {
                lastTokenHeartbeat = now;
                const activity = receivedFirstToken
                  ? 'Generating the answer.'
                  : 'Received the first model token.';
                receivedFirstToken = true;
                void advanceRun(run.attemptId, activity, 'model-request', 120_000);
              }
            },
            onReasoning: step => {
              sendRuntimeMessage({
                type: 'REASONING',
                step,
                messageId,
              });
              void advanceRun(
                run.attemptId,
                activityForReasoning(step.type),
                operationForReasoning(step.type)
              );
            },
            onLinkVisit: visit => {
              sendRuntimeMessage({
                type: 'LINK_VISIT',
                visit,
                messageId,
              });
              void advanceRun(
                run.attemptId,
                visit.status === 'fetching'
                  ? 'Opening a selected source.'
                  : 'Finished processing a selected source.',
                'source-fetch',
                visit.status === 'fetching' ? 30_000 : 0
              );
              if (visit.status !== 'fetching') {
                void recordDiagnostic({
                  level: visit.status === 'failed' ? 'warn' : 'info',
                  component: 'source-fetch',
                  event: `source-${visit.status}`,
                  attemptId: run.attemptId,
                  messageId,
                  operation: 'source-fetch',
                  url: visit.url,
                  error: visit.error,
                });
              }
            },
            onLinkDecision: decision => {
              sendRuntimeMessage({
                type: 'LINK_DECISION',
                decision,
                messageId,
              });
            },
            onDone: () => {
              sendRuntimeMessage({
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
            controller.signal,
            researchContext,
            { attemptId: run.attemptId, messageId }
          )
            .then(async () => {
              await finishAgentRun(run.attemptId, 'completed');
            })
            .catch(err => {
              if (controller.signal.aborted) {
                console.info('[analysis]', 'request-stopped', {
                  messageId,
                  elapsedMs: Date.now() - startedAt,
                });
                void finishAgentRun(run.attemptId, 'stopped', controller.signal.reason);
                return;
              }
              console.error('[analysis]', 'request-failed', {
                messageId,
                elapsedMs: Date.now() - startedAt,
                error: err instanceof Error ? err.message : String(err),
              });
              sendRuntimeMessage({
                type: 'ERROR',
                message: err instanceof Error ? err.message : String(err),
                messageId,
              });
              void finishAgentRun(run.attemptId, 'failed', err);
            })
            .finally(() => {
              if (activeAnalyses.get(messageId)?.controller === controller)
                activeAnalyses.delete(messageId);
            });

          const currentRun = (await getAgentRun(run.attemptId)) || run;
          sendResponse({
            ok: true,
            attemptId: run.attemptId,
            progress: toAgentRunProgress(currentRun),
          });
          break;
        }

        case 'START_RESEARCH': {
          if (!message.question || !message.messageId) throw new Error('Missing research request.');
          if (message.jobId) {
            const job = await researchCoordinator.retryInParallel(message.jobId, message.messageId);
            sendResponse({ ok: true, jobId: job.id, progress: job.progress });
            break;
          }
          let content = message.context || currentContent;
          if (!content) {
            const tabId = message.tabId || sender.tab?.id;
            if (!tabId) throw new Error('No tab ID');
            content = await getTabContent(tabId);
          }
          const job = await researchCoordinator.start(content, message.question, message.messageId);
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
          const active = messageId ? activeAnalyses.get(messageId) : undefined;
          active?.controller.abort('Stopped by user.');
          sendResponse({ ok: Boolean(active) });
          break;
        }

        case 'GET_DIAGNOSTICS': {
          const exported = await exportDiagnostics(await getSettings());
          sendResponse({ export: exported });
          break;
        }

        case 'CLEAR_DIAGNOSTICS': {
          sendResponse({ ok: true, diagnostics: await clearDiagnosticHistory() });
          break;
        }

        case 'GET_AGENT_RUN': {
          if (!message.attemptId) throw new Error('No attempt ID.');
          sendResponse({ run: await getAgentRun(message.attemptId) });
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

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function getConversationResearchContext(history: ChatMessage[] = []) {
  const jobId = [...history].reverse().find(message => message.researchJobId)?.researchJobId;
  if (!jobId) return undefined;
  const job = await researchCoordinator.getJob(jobId);
  return job ? buildResearchConversationContext(job) : undefined;
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
chrome.sidePanel.setOptions({ enabled: true, path: 'sidepanel/index.html' });

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: true, path: 'sidepanel/index.html' });
});

globalThis.addEventListener('error', event => {
  void recordDiagnostic({
    level: 'error',
    component: 'service-worker',
    event: 'uncaught-error',
    error: event.error || event.message,
  });
});

globalThis.addEventListener('unhandledrejection', event => {
  void recordDiagnostic({
    level: 'error',
    component: 'service-worker',
    event: 'unhandled-rejection',
    error: event.reason,
  });
});

async function advanceRun(
  attemptId: string,
  activity: string,
  operation?: AgentOperation,
  deadlineMs?: number
) {
  const run = await heartbeatAgentRun(attemptId, { activity, operation, deadlineMs });
  return run;
}

function sendRuntimeMessage(message: unknown) {
  void Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => undefined);
}

function operationForReasoning(type: string): AgentOperation {
  if (type === 'classify') return 'link-scoring';
  if (type === 'fetch' || type === 'extract') return 'source-fetch';
  return 'model-request';
}

function activityForReasoning(type: string) {
  if (type === 'classify') return 'Deciding which sources are needed.';
  if (type === 'fetch') return 'Fetching a selected source.';
  if (type === 'extract') return 'Reading retrieved content.';
  if (type === 'synthesize') return 'Synthesizing evidence.';
  return 'Generating the answer.';
}
