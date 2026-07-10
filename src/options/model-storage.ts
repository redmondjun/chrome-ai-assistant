const DATABASE_NAME = 'ChromeAIModels';
const MODEL_STORE = 'models';
const MODEL_NAME = 'nemotron-mini-4b-q4_k_m.gguf';
const MODEL_URL =
  'https://huggingface.co/NVIDIA/Nemotron-Mini-4B-GGUF/resolve/main/nemotron-mini-4b-q4_k_m.gguf';

export async function hasLocalModel(): Promise<boolean> {
  try {
    const database = await openModelDatabase();
    const transaction = database.transaction(MODEL_STORE, 'readonly');
    const model = await readRequest<Blob | undefined>(
      transaction.objectStore(MODEL_STORE).get(MODEL_NAME)
    );
    await waitForTransaction(transaction);
    return Boolean(model);
  } catch {
    return false;
  }
}

export async function downloadLocalModel(onProgress: (progress: number) => void): Promise<void> {
  const response = await fetch(MODEL_URL);
  if (!response.ok) {
    throw new Error(`Model download failed (${response.status})`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Model download returned no response body');

  const contentLength = Number(response.headers.get('content-length'));
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(contentLength ? received / contentLength : 0);
  }

  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  const database = await openModelDatabase();
  const transaction = database.transaction(MODEL_STORE, 'readwrite');
  transaction.objectStore(MODEL_STORE).put(new Blob([bytes.buffer]), MODEL_NAME);
  await waitForTransaction(transaction);
}

function openModelDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(MODEL_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readRequest<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
