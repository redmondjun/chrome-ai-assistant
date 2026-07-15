import { openDB } from 'idb';

const MODEL_URL =
  'https://huggingface.co/NVIDIA/Nemotron-Mini-4B-GGUF/resolve/main/nemotron-mini-4b-q4_k_m.gguf';
const MODEL_NAME = 'nemotron-mini-4b-q4_k_m.gguf';

let wllama: any = null;
let isInitializing = false;
let initPromise: Promise<boolean> | null = null;

async function getDB() {
  return openDB('chrome-ai-models', 1, {
    upgrade(db) {
      db.createObjectStore('models');
    },
  });
}

export async function initializeLocalModel(
  onProgress?: (progress: number, status: string) => void
): Promise<boolean> {
  if (wllama) return true;
  if (isInitializing && initPromise) return initPromise;

  isInitializing = true;
  initPromise = (async () => {
    try {
      onProgress?.(0, 'Initializing WLLama...');
      const { Wllama } = await import('@wllama/wllama');
      wllama = new Wllama({
        default: 'https://cdn.jsdelivr.net/npm/@wllama/wllama@latest/dist/',
      });

      onProgress?.(5, 'Checking for cached model...');
      const db = await getDB();
      const cached = await db.get('models', MODEL_NAME);

      let modelBuffer: ArrayBuffer;
      if (cached) {
        onProgress?.(10, 'Loading cached model...');
        modelBuffer = cached;
      } else {
        onProgress?.(10, 'Downloading model (2.5GB)...');
        modelBuffer = await downloadModel(progress => {
          onProgress?.(10 + progress * 80, `Downloading: ${Math.round(progress * 100)}%`);
        });
        const db = await getDB();
        await db.put('models', modelBuffer, MODEL_NAME);
        onProgress?.(90, 'Model cached successfully');
      }

      onProgress?.(90, 'Loading model into memory...');
      await wllama.loadModel(modelBuffer, {
        nGpuLayers: 0,
        contextSize: 8192,
      });

      onProgress?.(100, 'Ready!');
      return true;
    } catch (error) {
      console.error('Failed to initialize local model:', error);
      throw error;
    } finally {
      isInitializing = false;
    }
  })();

  return initPromise;
}

async function downloadModel(onProgress?: (progress: number) => void): Promise<ArrayBuffer> {
  const response = await fetch(MODEL_URL);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  const contentLength = parseInt(response.headers.get('content-length') || '0');
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received / contentLength);
  }

  const result = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

export async function completeLocal(
  prompt: string,
  options: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stop?: string[];
    onToken?: (token: string) => void;
    signal?: AbortSignal;
  } = {}
): Promise<string> {
  if (!wllama) throw new Error('Local model not initialized');

  const {
    maxTokens = 1024,
    temperature = 0.7,
    topP = 0.9,
    stop = ['\n\n'],
    onToken,
    signal,
  } = options;

  let fullResponse = '';
  await wllama.createCompletion({
    prompt,
    max_tokens: maxTokens,
    temperature,
    top_p: topP,
    stop,
    stream: true,
    abortSignal: signal,
    onData: (data: any) => {
      const chunk = data.text || '';
      fullResponse += chunk;
      onToken?.(chunk);
    },
  });

  return fullResponse;
}

export async function* streamLocal(
  prompt: string,
  options: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stop?: string[];
    signal?: AbortSignal;
  } = {}
): AsyncGenerator<{ chunk: string }> {
  if (!wllama) throw new Error('Local model not initialized');

  const { maxTokens = 1024, temperature = 0.7, topP = 0.9, stop = ['\n\n'], signal } = options;

  const chunks: string[] = [];
  await wllama.createCompletion({
    prompt,
    max_tokens: maxTokens,
    temperature,
    top_p: topP,
    stop,
    stream: true,
    abortSignal: signal,
    onData: (data: any) => {
      const chunk = data.text || '';
      chunks.push(chunk);
    },
  });

  for (const chunk of chunks) {
    yield { chunk };
  }
}

export function isLocalModelReady(): boolean {
  return !!wllama;
}

export function getLocalModelStatus(): { ready: boolean; progress: number } {
  return {
    ready: !!wllama,
    progress: 0,
  };
}

export async function clearLocalModel(): Promise<void> {
  wllama = null;

  const db = await getDB();
  await db.delete('models', MODEL_NAME);
}
