import { NIMClient } from './nim-client';
import {
  completeLocal,
  streamLocal,
  initializeLocalModel,
  isLocalModelReady,
} from './local-client';
import type { ModelSettings, CompletionOptions, CompletionResult } from '@/shared/types';

export class ModelRouter {
  private nimClient: NIMClient;
  private settings: ModelSettings;

  constructor(settings: ModelSettings) {
    this.settings = settings;
    this.nimClient = new NIMClient(settings.apiKey, settings.customEndpoint);
  }

  async complete(
    question: string,
    context: { hasLinks: boolean; contentLength: number },
    prompt: string,
    options: CompletionOptions = {}
  ): Promise<CompletionResult> {
    const useLocal = this.shouldUseLocal(question, context);

    if (useLocal && isLocalModelReady()) {
      try {
        const text = await completeLocal(prompt, options);
        return { text, modelUsed: 'local' };
      } catch (e) {
        console.warn('Local completion failed, falling back to cloud:', e);
      }
    }

    const messages = [
      { role: 'system' as const, content: 'You are a helpful AI assistant.' },
      { role: 'user' as const, content: prompt },
    ];

    const fullText = await this.nimClient.chatCompletion({
      model: this.settings.cloudModel,
      messages,
      stream: false,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      top_p: options.topP ?? 0.9,
    });

    return { text: fullText, modelUsed: 'cloud' };
  }

  async *streamComplete(
    question: string,
    context: { hasLinks: boolean; contentLength: number },
    prompt: string,
    options: CompletionOptions = {}
  ): AsyncGenerator<{ chunk: string; usedLocal: boolean }, CompletionResult, unknown> {
    const useLocal = this.shouldUseLocal(question, context);

    if (useLocal && isLocalModelReady()) {
      try {
        let fullText = '';
        for await (const { chunk } of streamLocal(prompt, options)) {
          fullText += chunk;
          yield { chunk, usedLocal: true };
        }
        return { text: fullText, modelUsed: 'local' };
      } catch (e) {
        console.warn('Local streaming failed, falling back to cloud:', e);
      }
    }

    let fullText = '';
    for await (const chunk of this.nimClient.streamChatCompletion({
      model: this.settings.cloudModel,
      messages: [
        { role: 'system', content: 'You are a helpful AI assistant.' },
        { role: 'user', content: prompt },
      ],
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      top_p: options.topP ?? 0.9,
      stream: true,
    })) {
      fullText += chunk;
      yield { chunk, usedLocal: false };
    }

    return { text: fullText, modelUsed: 'cloud' };
  }

  private shouldUseLocal(
    question: string,
    context: { hasLinks: boolean; contentLength: number }
  ): boolean {
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

  updateSettings(settings: ModelSettings): void {
    this.settings = settings;
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

export function createRouter(settings: ModelSettings): ModelRouter {
  return new ModelRouter(settings);
}
