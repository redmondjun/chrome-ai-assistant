export interface ExtensionSettings {
  model: {
    apiKey: string;
    cloudModel: string;
    customEndpoint: string;
    useLocal: boolean;
    autoRoute: boolean;
    forceCloudFor: string[];
  };
  links: {
    enabled: boolean;
    mode: 'ai-first' | 'deep';
    maxDepth: number;
    maxPages: number;
    rateLimitMs: number;
    requireConfirmation: boolean;
    allowedDomains: string;
    blockedDomains: string;
  };
  research: {
    workerConcurrency: number;
    maxRelatedSourcesPerTask: number;
    subjectBatchSize: number;
    maxUniqueSourcesPerJob: number;
    cloudNoticeAccepted: boolean;
  };
  ui: {
    theme: 'light' | 'dark' | 'system';
    showReasoning: boolean;
    showLinks: boolean;
    streaming: boolean;
  };
  privacy: {
    localOnly: boolean;
    clearOnClose: boolean;
  };
}

export type ModelSettings = ExtensionSettings['model'];
export type LinkSettings = ExtensionSettings['links'];
export type UiSettings = ExtensionSettings['ui'];
export type PrivacySettings = ExtensionSettings['privacy'];
export type ResearchSettings = ExtensionSettings['research'];

export const DEFAULT_SETTINGS: ExtensionSettings = {
  model: {
    apiKey: '',
    cloudModel: 'nemotron-3-nano',
    customEndpoint: '',
    useLocal: true,
    autoRoute: true,
    forceCloudFor: ['generate code', 'write document', 'create report'],
  },
  links: {
    enabled: true,
    mode: 'ai-first',
    maxDepth: 2,
    maxPages: 10,
    rateLimitMs: 500,
    requireConfirmation: false,
    allowedDomains: '',
    blockedDomains: 'facebook.com, twitter.com, x.com, instagram.com, tiktok.com, linkedin.com',
  },
  research: {
    workerConcurrency: 3,
    maxRelatedSourcesPerTask: 5,
    subjectBatchSize: 25,
    maxUniqueSourcesPerJob: 1000,
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

export function mergeSettings(saved?: Partial<ExtensionSettings>): ExtensionSettings {
  if (!saved) return DEFAULT_SETTINGS;

  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    model: { ...DEFAULT_SETTINGS.model, ...saved.model },
    links: { ...DEFAULT_SETTINGS.links, ...saved.links },
    research: { ...DEFAULT_SETTINGS.research, ...saved.research },
    ui: { ...DEFAULT_SETTINGS.ui, ...saved.ui },
    privacy: { ...DEFAULT_SETTINGS.privacy, ...saved.privacy },
  };
}
