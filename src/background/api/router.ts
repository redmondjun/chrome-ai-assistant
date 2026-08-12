import { NIMClient } from './nim-client';
import {
  completeLocal,
  streamLocal,
  initializeLocalModel,
  isLocalModelReady,
} from './local-client';
import type { ModelSettings, CompletionOptions, CompletionResult } from '@/shared/types';
import { heartbeatAgentRun, recordDiagnostic } from '../diagnostics';

export class ModelRouter {
  private nimClient: NIMClient;
  private settings: ModelSettings;
  private localOnly: boolean;

  constructor(settings: ModelSettings, localOnly = false) {
    this.settings = settings;
    this.localOnly = localOnly;
    this.nimClient = new NIMClient(settings.apiKey, settings.customEndpoint);
  }

  async complete(
    question: string,
    context: { hasLinks: boolean; contentLength: number },
    prompt: string,
    options: CompletionOptions = {}
  ): Promise<CompletionResult> {
    const useLocal = this.shouldUseLocal(question, context);

    if (this.localOnly && !isLocalModelReady()) {
      throw new Error('Local-only mode is enabled, but the local model is not ready.');
    }

    if (useLocal && isLocalModelReady()) {
      try {
        options.signal?.throwIfAborted();
        await recordLocalEvent(options, 'request-started');
        const text = await completeLocal(prompt, {
          ...options,
          onToken: createLocalHeartbeat(options),
        });
        options.signal?.throwIfAborted();
        await recordLocalEvent(options, 'request-completed');
        return { text, modelUsed: 'local' };
      } catch (e) {
        if (options.signal?.aborted) throw e;
        await recordLocalFailure(options, e);
        if (this.localOnly)
          throw new Error('The local model failed in local-only mode.', { cause: e });
        await recordFallback(options, e);
        console.warn('Local completion failed, falling back to cloud:', e);
      }
    }

    const messages = [
      { role: 'system' as const, content: 'You are a helpful AI assistant.' },
      { role: 'user' as const, content: prompt },
    ];

    const fullText = await this.nimClient.chatCompletion(
      {
        model: this.settings.cloudModel,
        messages,
        stream: false,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4096,
        top_p: options.topP ?? 0.9,
      },
      options.signal,
      options.diagnostic
    );

    return { text: fullText, modelUsed: 'cloud' };
  }

  async *streamComplete(
    question: string,
    context: { hasLinks: boolean; contentLength: number },
    prompt: string,
    options: CompletionOptions = {}
  ): AsyncGenerator<{ chunk: string; usedLocal: boolean }, CompletionResult, unknown> {
    const useLocal = this.shouldUseLocal(question, context);

    if (this.localOnly && !isLocalModelReady()) {
      throw new Error('Local-only mode is enabled, but the local model is not ready.');
    }

    if (useLocal && isLocalModelReady()) {
      try {
        let fullText = '';
        await recordLocalEvent(options, 'stream-started');
        for await (const { chunk } of streamLocal(prompt, {
          ...options,
          onToken: createLocalHeartbeat(options),
        })) {
          options.signal?.throwIfAborted();
          fullText += chunk;
          yield { chunk, usedLocal: true };
        }
        await recordLocalEvent(options, 'stream-completed');
        return { text: fullText, modelUsed: 'local' };
      } catch (e) {
        if (options.signal?.aborted) throw e;
        await recordLocalFailure(options, e);
        if (this.localOnly)
          throw new Error('The local model failed in local-only mode.', { cause: e });
        await recordFallback(options, e);
        console.warn('Local streaming failed, falling back to cloud:', e);
      }
    }

    let fullText = '';
    for await (const chunk of this.nimClient.streamChatCompletion(
      {
        model: this.settings.cloudModel,
        messages: [
          { role: 'system', content: 'You are a helpful AI assistant.' },
          { role: 'user', content: prompt },
        ],
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4096,
        top_p: options.topP ?? 0.9,
        stream: true,
      },
      options.signal,
      options.diagnostic
    )) {
      fullText += chunk;
      yield { chunk, usedLocal: false };
    }

    return { text: fullText, modelUsed: 'cloud' };
  }

  private shouldUseLocal(
    question: string,
    context: { hasLinks: boolean; contentLength: number }
  ): boolean {
    if (this.localOnly) return isLocalModelReady();
    if (!this.settings.useLocal || !isLocalModelReady()) return false;
    if (!this.settings.autoRoute) return false;
    if (this.settings.forceCloudFor.some(t => question.toLowerCase().includes(t.toLowerCase())))
      return false;

    const simpleTasks = ['extract', 'summarize', 'classify', 'list', 'find', 'what is', 'who is'];
    const isSimple = simpleTasks.some(t => question.toLowerCase().includes(t));
    const isShort = context.contentLength < 5000;
    const isClassification = context.hasLinks && question.toLowerCase().includes('which');

    return (isSimple || isShort || isClassification) && question.length < 200;
  }

  updateSettings(settings: ModelSettings, localOnly = this.localOnly): void {
    this.settings = settings;
    this.localOnly = localOnly;
    this.nimClient.setApiKey(settings.apiKey);
    this.nimClient.setBaseUrl(settings.customEndpoint || '');
  }

  async ensureLocalReady(onProgress?: (p: number) => void): Promise<boolean> {
    if (!this.settings.useLocal) return false;
    return initializeLocalModel(onProgress);
  }

  getLocalStatus(): { ready: boolean; progress?: number } {
    return { ready: isLocalModelReady() };
  }
}

function createLocalHeartbeat(options: CompletionOptions) {
  let lastHeartbeatAt = 0;
  let receivedFirstToken = false;
  return () => {
    if (!options.diagnostic) return;
    const now = Date.now();
    if (lastHeartbeatAt && now - lastHeartbeatAt < 5000) return;
    lastHeartbeatAt = now;
    if (!receivedFirstToken) {
      receivedFirstToken = true;
      void recordLocalEvent(options, 'first-token');
    }
    void heartbeatAgentRun(options.diagnostic.attemptId, {
      activity: 'Generating with the local model.',
      operation: 'local-generation',
      taskId: options.diagnostic.taskId,
    });
  };
}

async function recordLocalEvent(options: CompletionOptions, event: string) {
  if (!options.diagnostic) return;
  await recordDiagnostic({
    level: 'info',
    component: 'local-model',
    event,
    attemptId: options.diagnostic.attemptId,
    messageId: options.diagnostic.messageId,
    jobId: options.diagnostic.jobId,
    taskId: options.diagnostic.taskId,
    operation: 'local-generation',
    route: 'local',
  });
}

async function recordFallback(options: CompletionOptions, error: unknown) {
  if (!options.diagnostic) return;
  await recordDiagnostic({
    level: 'warn',
    component: 'router',
    event: 'local-fallback-to-cloud',
    attemptId: options.diagnostic.attemptId,
    messageId: options.diagnostic.messageId,
    jobId: options.diagnostic.jobId,
    taskId: options.diagnostic.taskId,
    operation: 'local-generation',
    route: 'local',
    error,
  });
}

async function recordLocalFailure(options: CompletionOptions, error: unknown) {
  if (!options.diagnostic) return;
  await recordDiagnostic({
    level: 'error',
    component: 'local-model',
    event: 'request-failed',
    attemptId: options.diagnostic.attemptId,
    messageId: options.diagnostic.messageId,
    jobId: options.diagnostic.jobId,
    taskId: options.diagnostic.taskId,
    operation: 'local-generation',
    route: 'local',
    error,
  });
}

export function createRouter(settings: ModelSettings, localOnly = false): ModelRouter {
  return new ModelRouter(settings, localOnly);
}
