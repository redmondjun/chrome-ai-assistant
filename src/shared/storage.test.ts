import type { StorageSettings } from './types';
import { mergeSyncedSettings, toSyncedSettings } from './storage';

const settings: StorageSettings = {
  model: {
    cloudModel: 'nemotron-3-super',
    customEndpoint: 'https://models.example.com',
    apiKey: 'device-secret',
    useLocal: true,
    autoRoute: true,
    forceCloudFor: ['reports'],
  },
  links: {
    enabled: true,
    mode: 'ai-first',
    maxDepth: 2,
    maxPages: 10,
    rateLimitMs: 500,
    requireConfirmation: false,
    allowedDomains: [],
    blockedDomains: [],
  },
  research: {
    workerConcurrency: 3,
    maxRelatedSourcesPerTask: 5,
    subjectBatchSize: 25,
    maxUniqueSourcesPerJob: 1000,
    cloudNoticeAccepted: false,
  },
  ui: { theme: 'dark', showReasoning: true, showLinks: true, streaming: true },
  privacy: { localOnly: true, clearOnClose: false },
};

describe('settings sync boundary', () => {
  it('excludes device-only secrets and preferences', () => {
    const synced = toSyncedSettings(settings);
    expect(synced.model).not.toHaveProperty('apiKey');
    expect(synced.model).not.toHaveProperty('useLocal');
    expect(synced.privacy).not.toHaveProperty('localOnly');
  });

  it('preserves device-only values when cloud settings are merged', () => {
    const merged = mergeSyncedSettings(settings, {
      model: { ...toSyncedSettings(settings).model, cloudModel: 'nemotron-3-ultra' },
      ui: { ...settings.ui, theme: 'light' },
    });
    expect(merged.model.apiKey).toBe('device-secret');
    expect(merged.model.useLocal).toBe(true);
    expect(merged.privacy.localOnly).toBe(true);
    expect(merged.model.cloudModel).toBe('nemotron-3-ultra');
    expect(merged.ui.theme).toBe('light');
  });
});
