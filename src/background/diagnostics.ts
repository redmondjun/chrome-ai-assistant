import type {
  AgentOperation,
  AgentRunProgress,
  AgentRunRecord,
  AgentRunStatus,
  DiagnosticEvent,
  DiagnosticExport,
  DiagnosticStore,
  SanitizedError,
  StorageSettings,
} from '@/shared/types';

export const DIAGNOSTIC_STORE_KEY = 'chrome-ai-diagnostics:v1';
export const DIAGNOSTIC_STALL_ALARM = 'check-agent-diagnostics';
export const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DIAGNOSTIC_MAX_EVENTS = 1000;
const MAX_PAYLOAD_CHARS = 4096;
const MAX_ERROR_CHARS = 2048;
const LOCAL_HEARTBEAT_LIMIT_MS = 120_000;
const TERMINAL_STATUSES = new Set<AgentRunStatus>([
  'completed',
  'failed',
  'stopped',
  'interrupted',
]);

export const SERVICE_WORKER_STARTUP_ID = crypto.randomUUID();

let writes = Promise.resolve();

type EventInput = Omit<DiagnosticEvent, 'id' | 'timestamp' | 'error' | 'url' | 'metadata'> & {
  error?: unknown;
  url?: string;
  metadata?: Record<string, unknown>;
};

interface StartRunInput {
  attemptId?: string;
  kind: AgentRunRecord['kind'];
  messageId: string;
  jobId?: string;
  taskId?: string;
  activity: string;
}

interface HeartbeatInput {
  activity: string;
  operation?: AgentOperation;
  deadlineMs?: number;
  taskId?: string;
}

export function createAttemptId() {
  return crypto.randomUUID();
}

export async function startAgentRun(input: StartRunInput): Promise<AgentRunRecord> {
  const now = Date.now();
  const interruptedRuns: AgentRunRecord[] = [];
  const run: AgentRunRecord = {
    attemptId: input.attemptId || createAttemptId(),
    kind: input.kind,
    messageId: input.messageId,
    jobId: input.jobId,
    taskId: input.taskId,
    status: 'accepted',
    health: 'healthy',
    activity: input.activity,
    lastHeartbeatAt: now,
    startedAt: now,
    startupId: SERVICE_WORKER_STARTUP_ID,
  };
  await updateStore(store => {
    if (input.kind === 'deep-research' && input.jobId) {
      for (const existing of store.runs) {
        if (
          existing.kind === 'deep-research' &&
          existing.jobId === input.jobId &&
          !TERMINAL_STATUSES.has(existing.status)
        ) {
          existing.status = 'interrupted';
          existing.health = 'healthy';
          existing.activity = 'Interrupted before a new research attempt started.';
          existing.finishedAt = now;
          existing.lastHeartbeatAt = now;
          existing.operationDeadlineAt = undefined;
          interruptedRuns.push(structuredClone(existing));
        }
      }
    }
    store.runs.push(run);
  });
  for (const interrupted of interruptedRuns) {
    const event = await recordDiagnostic(
      runEvent(interrupted, 'interrupted-by-new-attempt', 'warn')
    );
    if (event) {
      await updateStore(store => {
        const stored = store.runs.find(item => item.attemptId === interrupted.attemptId);
        if (stored) stored.diagnosticId = event.id;
      });
    }
  }
  await recordDiagnostic({
    level: 'info',
    component: input.kind === 'standard' ? 'analysis' : 'research',
    event: 'accepted',
    attemptId: run.attemptId,
    messageId: run.messageId,
    jobId: run.jobId,
    taskId: run.taskId,
  });
  return run;
}

export async function heartbeatAgentRun(
  attemptId: string,
  input: HeartbeatInput
): Promise<AgentRunRecord | undefined> {
  let updated: AgentRunRecord | undefined;
  let resumed = false;
  await updateStore(store => {
    const run = store.runs.find(item => item.attemptId === attemptId);
    if (!run || TERMINAL_STATUSES.has(run.status)) return;
    const now = Date.now();
    resumed = run.health === 'stalled-suspected';
    run.status = 'running';
    run.health = 'healthy';
    run.activity = sanitizeText(input.activity, 500);
    run.lastHeartbeatAt = now;
    run.taskId = input.taskId || run.taskId;
    const operationChanged = Boolean(input.operation && input.operation !== run.currentOperation);
    if (operationChanged) {
      run.currentOperation = input.operation;
      run.operationStartedAt = now;
    }
    if (operationChanged || input.deadlineMs !== undefined) {
      run.operationDeadlineAt = input.deadlineMs ? now + input.deadlineMs : undefined;
    }
    updated = structuredClone(run);
  });
  if (resumed && updated) {
    await recordDiagnostic(runEvent(updated, 'progress-resumed', 'info'));
  }
  if (updated) broadcastRun(updated);
  return updated;
}

export async function finishAgentRun(
  attemptId: string,
  status: Extract<AgentRunStatus, 'completed' | 'failed' | 'stopped' | 'interrupted'>,
  error?: unknown
): Promise<AgentRunRecord | undefined> {
  let updated: AgentRunRecord | undefined;
  await updateStore(store => {
    const run = store.runs.find(item => item.attemptId === attemptId);
    if (!run) return;
    const now = Date.now();
    run.status = status;
    run.health = 'healthy';
    run.activity = terminalActivity(status);
    run.lastHeartbeatAt = now;
    run.finishedAt = now;
    run.operationDeadlineAt = undefined;
    run.error = error === undefined ? undefined : sanitizeError(error);
    updated = structuredClone(run);
  });
  if (updated) {
    const event = await recordDiagnostic(
      runEvent(
        updated,
        status,
        status === 'failed' || status === 'interrupted' ? 'error' : 'info',
        error
      )
    );
    if (event) {
      await updateStore(store => {
        const run = store.runs.find(item => item.attemptId === attemptId);
        if (run) run.diagnosticId = event.id;
      });
      updated.diagnosticId = event.id;
    }
    broadcastRun(updated);
  }
  return updated;
}

export async function recordDiagnostic(input: EventInput): Promise<DiagnosticEvent | undefined> {
  const event: DiagnosticEvent = {
    ...input,
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    url: input.url ? sanitizeUrl(input.url) : undefined,
    error: input.error === undefined ? undefined : sanitizeError(input.error),
    metadata: sanitizeMetadata(input.metadata),
  };
  logToConsole(event);
  await updateStore(store => {
    store.events.push(event);
  });
  return event;
}

export async function getDiagnosticStore(): Promise<DiagnosticStore> {
  await writes;
  const result = await chrome.storage.local.get(DIAGNOSTIC_STORE_KEY);
  return pruneStore(normalizeStore(result?.[DIAGNOSTIC_STORE_KEY]));
}

export async function getAgentRun(attemptId: string) {
  const store = await getDiagnosticStore();
  return store.runs.find(run => run.attemptId === attemptId);
}

export async function clearDiagnosticHistory(): Promise<DiagnosticStore> {
  let cleared = emptyStore();
  await updateStore(store => {
    const activeRuns = store.runs.filter(run => !TERMINAL_STATUSES.has(run.status));
    store.events = [];
    store.runs = activeRuns;
    cleared = structuredClone(store);
  });
  await recordDiagnostic({
    level: 'info',
    component: 'service-worker',
    event: 'diagnostics-cleared',
  });
  return cleared;
}

export async function exportDiagnostics(settings: StorageSettings): Promise<DiagnosticExport> {
  return {
    schemaVersion: 1,
    exportedAt: Date.now(),
    extensionVersion: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    configuration: {
      cloudModel: settings.model.cloudModel,
      customEndpoint: settings.model.customEndpoint
        ? sanitizeUrl(settings.model.customEndpoint)
        : undefined,
      useLocal: settings.model.useLocal,
      localOnly: settings.privacy.localOnly,
      linkMode: settings.links.mode,
      researchConcurrency: settings.research.workerConcurrency,
    },
    store: await getDiagnosticStore(),
  };
}

export async function reconcileInterruptedRuns(): Promise<AgentRunRecord[]> {
  const interrupted: AgentRunRecord[] = [];
  await updateStore(store => {
    const now = Date.now();
    for (const run of store.runs) {
      if (
        run.startupId !== SERVICE_WORKER_STARTUP_ID &&
        !TERMINAL_STATUSES.has(run.status) &&
        run.kind === 'standard'
      ) {
        run.status = 'interrupted';
        run.health = 'healthy';
        run.activity = terminalActivity('interrupted');
        run.finishedAt = now;
        run.lastHeartbeatAt = now;
        run.operationDeadlineAt = undefined;
        run.error = sanitizeError(new Error('The extension service worker restarted.'));
        interrupted.push(structuredClone(run));
      }
    }
  });
  for (const run of interrupted) {
    const event = await recordDiagnostic(runEvent(run, 'interrupted', 'error', run.error));
    if (event) {
      run.diagnosticId = event.id;
      await updateStore(store => {
        const stored = store.runs.find(item => item.attemptId === run.attemptId);
        if (stored) stored.diagnosticId = event.id;
      });
    }
    broadcastRun(run);
  }
  return interrupted;
}

export async function checkForStalledRuns(): Promise<AgentRunRecord[]> {
  const stalled: AgentRunRecord[] = [];
  await updateStore(store => {
    const now = Date.now();
    for (const run of store.runs) {
      if (TERMINAL_STATUSES.has(run.status) || run.health === 'stalled-suspected') continue;
      const deadlineMissed = run.operationDeadlineAt !== undefined && now > run.operationDeadlineAt;
      const localHeartbeatMissed =
        run.currentOperation === 'local-generation' &&
        now - run.lastHeartbeatAt > LOCAL_HEARTBEAT_LIMIT_MS;
      if (!deadlineMissed && !localHeartbeatMissed) continue;
      run.health = 'stalled-suspected';
      stalled.push(structuredClone(run));
    }
  });
  for (const run of stalled) {
    const event = await recordDiagnostic(runEvent(run, 'stalled-suspected', 'warn'));
    if (event) {
      run.diagnosticId = event.id;
      await updateStore(store => {
        const stored = store.runs.find(item => item.attemptId === run.attemptId);
        if (stored) stored.diagnosticId = event.id;
      });
    }
    broadcastRun(run);
  }
  return stalled;
}

export function toAgentRunProgress(run: AgentRunRecord): AgentRunProgress {
  return {
    attemptId: run.attemptId,
    status: run.status,
    health: run.health,
    activity: run.activity,
    startedAt: run.startedAt,
    operationStartedAt: run.operationStartedAt,
    lastHeartbeatAt: run.lastHeartbeatAt,
    diagnosticId: run.diagnosticId,
  };
}

export function sanitizeUrl(value: string): string {
  try {
    return stripUrlSecrets(value);
  } catch {
    return value.split(/[?#]/, 1)[0].slice(0, 1000);
  }
}

export function sanitizeError(error: unknown): SanitizedError {
  if (!(error instanceof Error) && isSanitizedError(error)) {
    return {
      name: sanitizeText(error.name, 100),
      message: sanitizeText(error.message, MAX_ERROR_CHARS),
      stack: error.stack ? sanitizeText(error.stack, MAX_PAYLOAD_CHARS) : undefined,
      code: error.code ? sanitizeText(error.code, 100) : undefined,
    };
  }
  const candidate = error instanceof Error ? error : new Error(String(error));
  const code =
    'code' in candidate ? String((candidate as Error & { code?: unknown }).code || '') : '';
  return {
    name: sanitizeText(candidate.name || 'Error', 100),
    message: sanitizeText(candidate.message || String(error), MAX_ERROR_CHARS),
    stack: candidate.stack ? sanitizeText(candidate.stack, MAX_PAYLOAD_CHARS) : undefined,
    code: code ? sanitizeText(code, 100) : undefined,
  };
}

function updateStore(mutator: (store: DiagnosticStore) => void | Promise<void>): Promise<void> {
  const operation = writes.then(async () => {
    const result = await chrome.storage.local.get(DIAGNOSTIC_STORE_KEY);
    const store = pruneStore(normalizeStore(result?.[DIAGNOSTIC_STORE_KEY]));
    await mutator(store);
    pruneStore(store);
    try {
      await chrome.storage.local.set({ [DIAGNOSTIC_STORE_KEY]: store });
    } catch (error) {
      store.events = store.events.slice(Math.floor(store.events.length / 2));
      try {
        await chrome.storage.local.set({ [DIAGNOSTIC_STORE_KEY]: store });
      } catch (retryError) {
        console.error('[diagnostics] persistent-write-failed', { error, retryError });
      }
    }
  });
  writes = operation.catch(() => undefined);
  return operation;
}

function normalizeStore(value: unknown): DiagnosticStore {
  if (!value || typeof value !== 'object') return emptyStore();
  const candidate = value as Partial<DiagnosticStore>;
  return {
    version: 1,
    events: Array.isArray(candidate.events) ? candidate.events : [],
    runs: Array.isArray(candidate.runs) ? candidate.runs : [],
  };
}

function emptyStore(): DiagnosticStore {
  return { version: 1, events: [], runs: [] };
}

function pruneStore(store: DiagnosticStore): DiagnosticStore {
  const cutoff = Date.now() - DIAGNOSTIC_RETENTION_MS;
  store.events = store.events
    .filter(event => event.timestamp >= cutoff)
    .slice(-DIAGNOSTIC_MAX_EVENTS);
  store.runs = store.runs.filter(
    run => !run.finishedAt || run.finishedAt >= cutoff || !TERMINAL_STATUSES.has(run.status)
  );
  return store;
}

function sanitizeMetadata(metadata?: Record<string, unknown>) {
  if (!metadata) return undefined;
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (isSensitiveKey(key)) continue;
    if (value === null || ['number', 'boolean'].includes(typeof value)) {
      result[key] = value as number | boolean | null;
    } else if (typeof value === 'string') {
      result[key] = /url/i.test(key) ? sanitizeUrl(value) : sanitizeText(value, 1000);
    }
  }
  return JSON.stringify(result).length > MAX_PAYLOAD_CHARS
    ? { truncated: true }
    : Object.keys(result).length
      ? result
      : undefined;
}

function sanitizeText(value: string, maxLength: number) {
  return value
    .replace(/https?:\/\/[^\s<>"']+/gi, candidate => {
      try {
        return stripUrlSecrets(candidate);
      } catch {
        return candidate.split(/[?#]/, 1)[0];
      }
    })
    .replace(/chrome-extension:\/\/[^/\s]+/gi, 'chrome-extension://<extension>')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:nvapi|sk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/([?&](?:token|key|auth|session|password|secret)\s*=)[^&#\s]*/gi, '$1[REDACTED]')
    .slice(0, maxLength);
}

function stripUrlSecrets(value: string) {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function isSensitiveKey(key: string) {
  return /prompt|content|text|excerpt|response|authorization|cookie|api.?key|password|email|token|session|secret/i.test(
    key
  );
}

function isSanitizedError(value: unknown): value is SanitizedError {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as SanitizedError).name === 'string' &&
    typeof (value as SanitizedError).message === 'string'
  );
}

function runEvent(
  run: AgentRunRecord,
  event: string,
  level: DiagnosticEvent['level'],
  error?: unknown
): EventInput {
  return {
    level,
    component: run.kind === 'standard' ? 'analysis' : 'research',
    event,
    attemptId: run.attemptId,
    messageId: run.messageId,
    jobId: run.jobId,
    taskId: run.taskId,
    operation: run.currentOperation,
    elapsedMs: Date.now() - run.startedAt,
    error,
  };
}

function terminalActivity(status: AgentRunStatus) {
  if (status === 'completed') return 'Completed.';
  if (status === 'stopped') return 'Stopped by user.';
  if (status === 'interrupted') return 'Interrupted by extension restart.';
  return 'Failed.';
}

function logToConsole(event: DiagnosticEvent) {
  const details = { ...event, error: event.error?.message };
  if (event.level === 'error') console.error('[diagnostics]', event.event, details);
  else if (event.level === 'warn') console.warn('[diagnostics]', event.event, details);
  else console.info('[diagnostics]', event.event, details);
}

function broadcastRun(run: AgentRunRecord) {
  void Promise.resolve(
    chrome.runtime.sendMessage({
      type: 'AGENT_RUN_PROGRESS',
      messageId: run.messageId,
      progress: toAgentRunProgress(run),
    })
  ).catch(() => undefined);
}
