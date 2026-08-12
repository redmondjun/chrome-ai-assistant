import {
  checkForStalledRuns,
  clearDiagnosticHistory,
  DIAGNOSTIC_MAX_EVENTS,
  DIAGNOSTIC_RETENTION_MS,
  DIAGNOSTIC_STORE_KEY,
  exportDiagnostics,
  getDiagnosticStore,
  heartbeatAgentRun,
  recordDiagnostic,
  reconcileInterruptedRuns,
  sanitizeError,
  sanitizeUrl,
  startAgentRun,
} from './diagnostics';
import { DEFAULT_SETTINGS } from './storage/settings';
import type { DiagnosticStore } from '@/shared/types';

describe('durable diagnostics', () => {
  let storage: Record<string, unknown>;

  beforeEach(() => {
    storage = {};
    (chrome.storage.local.get as jest.Mock).mockReset();
    (chrome.storage.local.set as jest.Mock).mockReset();
    (chrome.storage.local.get as jest.Mock).mockImplementation(async (key?: string) => {
      if (typeof key === 'string') return { [key]: storage[key] };
      return { ...storage };
    });
    (chrome.storage.local.set as jest.Mock).mockImplementation(async values => {
      Object.assign(storage, structuredClone(values));
    });
    (chrome.runtime as typeof chrome.runtime & { getManifest: jest.Mock }).getManifest = jest.fn(
      () => ({ version: '1.0.0' })
    );
  });

  it('keeps URL paths while removing credentials, query strings, and fragments', () => {
    expect(sanitizeUrl('https://user:pass@example.com/tickets/ABC-1?token=secret#comment')).toBe(
      'https://example.com/tickets/ABC-1'
    );
  });

  it('redacts secrets and extension IDs from errors', () => {
    const error = new Error('Bearer secret-token failed for nvapi-abcdefghijk');
    error.stack = 'Error at chrome-extension://abcdef/background/index.js:12:3';
    const sanitized = sanitizeError(error);
    expect(sanitized.message).not.toContain('secret-token');
    expect(sanitized.message).not.toContain('nvapi-abcdefghijk');
    expect(sanitized.stack).toContain('chrome-extension://<extension>/background/index.js');
  });

  it('prunes by age and the 1,000 event limit', async () => {
    const now = Date.now();
    const events = Array.from({ length: DIAGNOSTIC_MAX_EVENTS + 10 }, (_, index) => ({
      id: `event-${index}`,
      timestamp: index === 0 ? now - DIAGNOSTIC_RETENTION_MS - 1 : now - index,
      level: 'info' as const,
      component: 'analysis' as const,
      event: 'heartbeat',
    }));
    storage[DIAGNOSTIC_STORE_KEY] = { version: 1, events, runs: [] } satisfies DiagnosticStore;

    await recordDiagnostic({ level: 'info', component: 'analysis', event: 'latest' });
    const store = await getDiagnosticStore();

    expect(store.events).toHaveLength(DIAGNOSTIC_MAX_EVENTS);
    expect(store.events.some(event => event.id === 'event-0')).toBe(false);
    expect(store.events.at(-1)?.event).toBe('latest');
  });

  it('serializes concurrent writes without losing events', async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        recordDiagnostic({
          level: 'info',
          component: 'analysis',
          event: `event-${index}`,
        })
      )
    );
    expect((await getDiagnosticStore()).events).toHaveLength(50);
  });

  it('prunes and retries once after a storage quota write failure', async () => {
    let attempts = 0;
    (chrome.storage.local.set as jest.Mock).mockImplementation(async values => {
      attempts++;
      if (attempts === 1) throw new Error('QUOTA_BYTES exceeded');
      Object.assign(storage, structuredClone(values));
    });

    await recordDiagnostic({ level: 'error', component: 'analysis', event: 'quota-test' });

    expect(attempts).toBe(2);
    expect((await getDiagnosticStore()).events.at(-1)?.event).toBe('quota-test');
  });

  it('marks an expired operation once and restores health on heartbeat', async () => {
    const run = await startAgentRun({
      kind: 'standard',
      messageId: 'message-1',
      activity: 'Starting',
    });
    await heartbeatAgentRun(run.attemptId, {
      activity: 'Waiting for model',
      operation: 'model-request',
      deadlineMs: 1,
    });
    await new Promise(resolve => setTimeout(resolve, 5));

    expect(await checkForStalledRuns()).toHaveLength(1);
    expect(await checkForStalledRuns()).toHaveLength(0);
    await heartbeatAgentRun(run.attemptId, {
      activity: 'Received a token',
      operation: 'model-request',
      deadlineMs: 120_000,
    });
    const restored = (await getDiagnosticStore()).runs.find(
      candidate => candidate.attemptId === run.attemptId
    );
    expect(restored?.health).toBe('healthy');
    expect(
      (await getDiagnosticStore()).events.some(event => event.event === 'progress-resumed')
    ).toBe(true);
  });

  it('marks standard runs from an earlier service worker startup as interrupted', async () => {
    const now = Date.now();
    storage[DIAGNOSTIC_STORE_KEY] = {
      version: 1,
      events: [],
      runs: [
        {
          attemptId: 'old-attempt',
          kind: 'standard',
          messageId: 'message-1',
          status: 'running',
          health: 'healthy',
          activity: 'Generating',
          startedAt: now - 10_000,
          lastHeartbeatAt: now - 5_000,
          startupId: 'old-startup',
        },
      ],
    } satisfies DiagnosticStore;

    const interrupted = await reconcileInterruptedRuns();

    expect(interrupted).toHaveLength(1);
    expect(interrupted[0].status).toBe('interrupted');
    expect(interrupted[0].diagnosticId).toBeDefined();
  });

  it('does not flag long research orchestration when it has no operation deadline', async () => {
    const run = await startAgentRun({
      kind: 'deep-research',
      messageId: 'message-1',
      jobId: 'job-1',
      activity: 'Starting research',
    });
    await heartbeatAgentRun(run.attemptId, {
      activity: 'Coordinating Deep Research.',
      operation: 'research-orchestration',
    });
    const store = await getDiagnosticStore();
    const stored = store.runs.find(candidate => candidate.attemptId === run.attemptId);
    if (stored) {
      stored.startedAt = Date.now() - 40 * 60 * 1000;
      storage[DIAGNOSTIC_STORE_KEY] = store;
    }

    expect(await checkForStalledRuns()).toHaveLength(0);
  });

  it('clears terminal history while retaining active runs', async () => {
    const run = await startAgentRun({
      kind: 'standard',
      messageId: 'message-1',
      activity: 'Starting',
    });
    await recordDiagnostic({ level: 'error', component: 'analysis', event: 'failure' });
    await clearDiagnosticHistory();
    const store = await getDiagnosticStore();
    expect(store.runs.some(candidate => candidate.attemptId === run.attemptId)).toBe(true);
    expect(store.events.map(event => event.event)).toEqual(['diagnostics-cleared']);
  });

  it('exports configuration without API keys or endpoint query secrets', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.model.apiKey = 'nvapi-super-secret-value';
    settings.model.customEndpoint = 'https://models.example.com/v1?token=secret';
    await recordDiagnostic({
      level: 'error',
      component: 'nim',
      event: 'failure',
      error: new Error('Bearer hidden-token failed'),
    });

    const json = JSON.stringify(await exportDiagnostics(settings));

    expect(json).not.toContain('nvapi-super-secret-value');
    expect(json).not.toContain('hidden-token');
    expect(json).not.toContain('token=secret');
    expect(json).toContain('https://models.example.com/v1');
  });
});
