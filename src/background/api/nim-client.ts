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

export class NIMClient {
  private apiKey: string;
  private baseUrl: string;
  private modelMap: Record<string, string> = {
    'nemotron-3-nano': 'nvidia/nemotron-3-nano-30b-a3b',
    'nemotron-3-super': 'nvidia/nemotron-3-super-120b-a12b',
    'nemotron-3-ultra': 'nvidia/nemotron-3-ultra-550b-a55b',
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

  async chatCompletion(request: ChatRequest): Promise<string> {
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
    });

    if (!response.ok) {
      throw await this.createApiError(response);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  }

  async *streamChatCompletion(request: ChatRequest): AsyncGenerator<string> {
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
    });

    if (!response.ok) {
      throw await this.createApiError(response);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') return;
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices[0]?.delta?.content;
              if (content) yield content;
            } catch {
              // Ignore parse errors
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
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

export function createNIMClient(apiKey: string, baseUrl?: string): NIMClient {
  return new NIMClient(apiKey, baseUrl);
}
