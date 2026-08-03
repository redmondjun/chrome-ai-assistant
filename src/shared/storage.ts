import type { AccountState, ChatConversation, StorageSettings, SyncedSettings } from './types';

export const LEGACY_SETTINGS_KEY = 'chrome-ai-settings';
export const LOCAL_SETTINGS_KEY = 'chrome-ai-local-settings';
export const SETTINGS_UPDATED_AT_KEY = 'chrome-ai-settings-updated-at';
export const ACCOUNT_STATE_KEY = 'chrome-ai-account-state';
export const SYNC_STATUS_KEY = 'chrome-ai-sync-status';
export const ANONYMOUS_SCOPE = 'anonymous';

export const conversationKey = (scope: string) => `chrome-ai-conversations:${scope}`;
export const activeConversationKey = (scope: string) => `chrome-ai-active-conversation:${scope}`;

export const EMPTY_ACCOUNT_STATE: AccountState = { configured: true, user: null };

export function toSyncedSettings(settings: StorageSettings): SyncedSettings {
  return {
    model: {
      cloudModel: settings.model.cloudModel,
      customEndpoint: settings.model.customEndpoint,
      autoRoute: settings.model.autoRoute,
      forceCloudFor: settings.model.forceCloudFor,
    },
    links: settings.links,
    research: settings.research,
    ui: settings.ui,
    privacy: { clearOnClose: settings.privacy.clearOnClose },
  };
}

export function mergeSyncedSettings(
  local: StorageSettings,
  synced?: Partial<SyncedSettings>
): StorageSettings {
  if (!synced) return local;
  return {
    ...local,
    model: { ...local.model, ...synced.model },
    links: { ...local.links, ...synced.links },
    research: { ...local.research, ...synced.research },
    ui: { ...local.ui, ...synced.ui },
    privacy: { ...local.privacy, ...synced.privacy },
  };
}

export interface CachedConversations {
  conversations: ChatConversation[];
  activeConversationId?: string;
}
