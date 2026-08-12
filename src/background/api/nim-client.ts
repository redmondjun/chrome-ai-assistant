export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string[];
}

export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Partial<ChatMessage>;
    finish_reason: string | null;
  }>;
}

export const DEFAULT_NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const REQUEST_TIMEOUT_MS = 120000;
const MAX_TRANSIENT_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

export class NIMClient {
  private apiKey: string;
  private baseUrl: string;
  private modelMap: Record<string, string> = {
    'nemotron-3-nano': 'nvidia/nemotron-3-nano-30b-a3b',
    'nemotron-3-super': 'nvidia/nemotron-3-super-120b-a12b',
    'nemotron-3-ultra': 'nvidia/nemotron-3-ultra-550b-a55b',
    'glm-5.2': 'z-ai/glm-5.2',
    'minimax-m3': 'minimaxai/minimax-m3',
  };

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = this.normalizeBaseUrl(baseUrl);
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = this.normalizeBaseUrl(url);
  }

  private normalizeBaseUrl(url?: string): string {
    return (url?.trim() || DEFAULT_NIM_BASE_URL).replace(/\/$/, '');
  }

  getModelId(model: string): string {
    return this.modelMap[model] || model;
  }

  async chatCompletion(
    request: ChatRequest,
    signal?: AbortSignal,
    diagnostic?: CompletionOptions['diagnostic']
  ): Promise<string> {
    for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt++) {
      const requestSignal = createRequestSignal(signal);
      const startedAt = Date.now();
      await this.recordRequest('request-started', 'info', request, diagnostic);
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            ...request,
            model: this.getModelId(request.model),
          }),
          signal: requestSignal.signal,
        });

        await this.recordRequest(
          'response-received',
          response.ok ? 'info' : 'warn',
          request,
          diagnostic,
          {
            httpStatus: response.status,
            elapsedMs: Date.now() - startedAt,
          }
        );

        if (!response.ok) {
          const error = await this.createApiError(response);
          if (attempt === MAX_TRANSIENT_ATTEMPTS || !isTransientStatus(response.status)) {
            throw error;
          }
          const delayMs = getRetryDelay(response, attempt);
          console.warn('[nim]', 'transient-api-retry', {
            status: response.status,
            attempt,
            nextAttempt: attempt + 1,
            delayMs,
          });
          await waitForRetry(delayMs, signal);
          continue;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.length === 0) {
          throw new Error('NIM API returned no completion content.');
        }
        await this.recordRequest('request-completed', 'info', request, diagnostic, {
          elapsedMs: Date.now() - startedAt,
        });
        return content;
      } catch (error) {
        await this.recordRequest('request-failed', 'error', request, diagnostic, {
          elapsedMs: Date.now() - startedAt,
          error,
        });
        throw error;
      } finally {
        requestSignal.dispose();
      }
    }
    throw new Error('NIM request failed after transient retries.');
  }

  async *streamChatCompletion(
    request: ChatRequest,
    signal?: AbortSignal,
    diagnostic?: CompletionOptions['diagnostic']
  ): AsyncGenerator<string> {
    const requestSignal = createRequestSignal(signal);
    const startedAt = Date.now();
    let firstTokenAt = 0;
    let contentChunks = 0;
    let parseErrors = 0;
    await this.recordRequest('stream-started', 'info', request, diagnostic);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          ...request,
          model: this.getModelId(request.model),
          stream: true,
        }),
        signal: requestSignal.signal,
      });

      await this.recordRequest(
        'stream-response-received',
        response.ok ? 'info' : 'warn',
        request,
        diagnostic,
        {
          httpStatus: response.status,
          elapsedMs: Date.now() - startedAt,
        }
      );

      if (!response.ok) {
        throw await this.createApiError(response);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let streamFinished = false;

      try {
        while (!streamFinished) {
          if (requestSignal.signal.aborted) throw requestSignal.signal.reason;
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') {
                streamFinished = true;
                break;
              }
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices[0]?.delta?.content;
                if (content) {
                  contentChunks++;
                  if (!firstTokenAt) {
                    firstTokenAt = Date.now();
                    await this.recordRequest('first-token', 'info', request, diagnostic, {
                      elapsedMs: firstTokenAt - startedAt,
                    });
                  }
                  yield content;
                }
              } catch {
                parseErrors++;
              }
            }
          }
        }
      } catch (error) {
        if (requestSignal.signal.aborted) throw requestSignal.signal.reason;
        throw error;
      } finally {
        await reader.cancel?.().catch(() => undefined);
        reader.releaseLock();
      }
      if (contentChunks === 0) throw new Error('NIM API stream returned no completion content.');
      if (parseErrors > 0) {
        await this.recordRequest('stream-parse-warning', 'warn', request, diagnostic, {
          elapsedMs: Date.now() - startedAt,
        });
      }
      await this.recordRequest('stream-completed', 'info', request, diagnostic, {
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      await this.recordRequest('stream-failed', 'error', request, diagnostic, {
        elapsedMs: Date.now() - startedAt,
        error,
      });
      throw error;
    } finally {
      requestSignal.dispose();
    }
  }

  async testConnection(model = 'nemotron-3-nano'): Promise<boolean> {
    try {
      await this.chatCompletion({
        model,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 5,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async recordRequest(
    event: string,
    level: 'info' | 'warn' | 'error',
    request: ChatRequest,
    diagnostic?: CompletionOptions['diagnostic'],
    details: { httpStatus?: number; elapsedMs?: number; error?: unknown } = {}
  ) {
    if (!diagnostic) return;
    if (event.includes('started')) {
      await heartbeatAgentRun(diagnostic.attemptId, {
        activity: 'Waiting for the cloud model.',
        operation: 'model-request',
        deadlineMs: REQUEST_TIMEOUT_MS,
        taskId: diagnostic.taskId,
      });
    }
    await recordDiagnostic({
      level,
      component: 'nim',
      event,
      attemptId: diagnostic.attemptId,
      messageId: diagnostic.messageId,
      jobId: diagnostic.jobId,
      taskId: diagnostic.taskId,
      operation: 'model-request',
      model: this.getModelId(request.model),
      route: 'cloud',
      ...details,
    });
  }

  private async createApiError(response: Response): Promise<Error> {
    const body = await response.text().catch(() => '');
    let detail = body;

    if (body) {
      try {
        const parsed = JSON.parse(body);
        detail =
          parsed.error?.message ||
          (typeof parsed.error === 'string' ? parsed.error : '') ||
          parsed.detail ||
          parsed.message ||
          parsed.title ||
          body;
      } catch {
        // Keep the plain-text response body.
      }
    }

    const status =
      `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`.trim();
    return new Error(`NIM API error (${status}): ${detail || 'No error details returned'}`);
  }
}

function isTransientStatus(status: number) {
  return status === 429 || status === 503;
}

function getRetryDelay(response: Response, attempt: number) {
  const retryAfter = response.headers?.get?.('retry-after');
  const retryAfterSeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }
  return RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

function waitForRetry(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function createRequestSignal(parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  const timeout = setTimeout(
    () => controller.abort(new DOMException('The AI response timed out.', 'TimeoutError')),
    REQUEST_TIMEOUT_MS
  );
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abort);
    },
  };
}

export function createNIMClient(apiKey: string, baseUrl?: string): NIMClient {
  return new NIMClient(apiKey, baseUrl);
}
import { heartbeatAgentRun, recordDiagnostic } from '../diagnostics';
import type { CompletionOptions } from '@/shared/types';
