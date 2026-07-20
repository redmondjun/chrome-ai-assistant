import type { StorageSettings, ModelSettings, LinkFollowSettings } from '@/shared/types';

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
  research: {
    workerConcurrency: 3,
    maxRelatedSourcesPerTask: 5,
    cloudNoticeAccepted: false,
  },
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

const SETTINGS_KEY = 'chrome-ai-settings';

export async function getSettings(): Promise<StorageSettings> {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  return deepMerge(DEFAULT_SETTINGS, result[SETTINGS_KEY] || {});
}

export async function saveSettings(settings: Partial<StorageSettings>): Promise<void> {
  const current = await getSettings();
  const merged = deepMerge(current, settings);
  await chrome.storage.sync.set({ [SETTINGS_KEY]: merged });
  return merged;
}

export function onSettingsChanged(callback: (settings: StorageSettings) => void): () => void {
  const listener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
    if (changes[SETTINGS_KEY]) {
      callback({ ...DEFAULT_SETTINGS, ...changes[SETTINGS_KEY].newValue });
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
  await chrome.storage.sync.remove(SETTINGS_KEY);
}
