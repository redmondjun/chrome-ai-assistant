import type { StorageSettings, ModelSettings, LinkFollowSettings } from '@/shared/types';
import {
  LEGACY_SETTINGS_KEY,
  LOCAL_SETTINGS_KEY,
  SETTINGS_UPDATED_AT_KEY,
  mergeSyncedSettings,
  toSyncedSettings,
} from '@/shared/storage';

const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  cloudModel: 'nemotron-3-nano',
  apiKey: '',
  useLocal: true,
  autoRoute: true,
  forceCloudFor: ['generate code', 'write document', 'create report'],
};

const DEFAULT_LINK_FOLLOWING: LinkFollowSettings = {
  enabled: true,
  mode: 'ai-first',
  maxDepth: 2,
  maxPages: 10,
  rateLimitMs: 500,
  requireConfirmation: false,
  allowedDomains: [],
  blockedDomains: [
    'facebook.com',
    'twitter.com',
    'x.com',
    'instagram.com',
    'tiktok.com',
    'linkedin.com',
  ],
};

export const DEFAULT_SETTINGS: StorageSettings = {
  model: DEFAULT_MODEL_SETTINGS,
  links: DEFAULT_LINK_FOLLOWING,
  ui: {
    theme: 'system',
    showReasoning: true,
    showLinks: true,
    streaming: true,
  },
  privacy: {
    localOnly: false,
    clearOnClose: false,
  },
};

export async function getSettings(): Promise<StorageSettings> {
  await migrateLegacySettings();
  const result = await chrome.storage.local.get(LOCAL_SETTINGS_KEY);
  return deepMerge(DEFAULT_SETTINGS, result[LOCAL_SETTINGS_KEY] || {});
}

export async function saveSettings(settings: Partial<StorageSettings>): Promise<void> {
  const current = await getSettings();
  const merged = deepMerge(current, settings);
  await chrome.storage.local.set({
    [LOCAL_SETTINGS_KEY]: merged,
    [SETTINGS_UPDATED_AT_KEY]: Date.now(),
  });
}

export function onSettingsChanged(callback: (settings: StorageSettings) => void): () => void {
  const listener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
    if (changes[LOCAL_SETTINGS_KEY]) {
      callback(deepMerge(DEFAULT_SETTINGS, changes[LOCAL_SETTINGS_KEY].newValue || {}));
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export async function clearSettings(): Promise<void> {
  await chrome.storage.local.remove(LOCAL_SETTINGS_KEY);
}

export async function applySyncedSettings(
  settings: unknown,
  updatedAt: number
): Promise<StorageSettings> {
  const current = await getSettings();
  const merged = mergeSyncedSettings(current, settings as any);
  await chrome.storage.local.set({
    [LOCAL_SETTINGS_KEY]: merged,
    [SETTINGS_UPDATED_AT_KEY]: updatedAt,
  });
  return merged;
}

export async function getSyncedSettings() {
  return toSyncedSettings(await getSettings());
}

export async function getSettingsUpdatedAt(): Promise<number> {
  const result = await chrome.storage.local.get(SETTINGS_UPDATED_AT_KEY);
  return Number(result[SETTINGS_UPDATED_AT_KEY] || 0);
}

async function migrateLegacySettings(): Promise<void> {
  const local = await chrome.storage.local.get(LOCAL_SETTINGS_KEY);
  if (local[LOCAL_SETTINGS_KEY]) return;

  const legacy = await chrome.storage.sync.get(LEGACY_SETTINGS_KEY);
  const merged = deepMerge(DEFAULT_SETTINGS, legacy[LEGACY_SETTINGS_KEY] || {});
  await chrome.storage.local.set({
    [LOCAL_SETTINGS_KEY]: merged,
    [SETTINGS_UPDATED_AT_KEY]: 0,
  });
  const verified = await chrome.storage.local.get(LOCAL_SETTINGS_KEY);
  if (verified[LOCAL_SETTINGS_KEY] && legacy[LEGACY_SETTINGS_KEY]) {
    await chrome.storage.sync.remove(LEGACY_SETTINGS_KEY);
  }
}
