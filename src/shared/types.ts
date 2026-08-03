export interface TabContent {
  url: string;
  title: string;
  text: string;
  links: LinkInfo[];
  meta: Record<string, string>;
  timestamp: number;
}

export interface LinkInfo {
  url: string;
  text: string;
  title?: string;
  context?: string;
  isExternal: boolean;
}

export interface LinkVisit {
  url: string;
  title: string;
  status: 'pending' | 'fetching' | 'success' | 'failed' | 'skipped';
  relevanceScore: number;
  snippet?: string;
  timestamp: number;
  error?: string;
  method?: 'direct-fetch' | 'browser-tab';
  depth?: number;
}

export interface LinkDecision {
  url: string;
  title: string;
  outcome: 'selected' | 'discarded' | 'skipped';
  reason: string;
  depth: number;
  score?: number;
  timestamp: number;
}

export interface ReasoningStep {
  step: number;
  type: 'classify' | 'fetch' | 'extract' | 'synthesize' | 'answer';
  thought: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ModelSettings {
  cloudModel: 'nemotron-3-nano' | 'nemotron-3-super' | 'nemotron-3-ultra' | 'custom';
  customEndpoint?: string;
  apiKey: string;
  useLocal: boolean;
  autoRoute: boolean;
  forceCloudFor: string[];
}

export interface LinkFollowSettings {
  enabled: boolean;
  mode: 'ai-first' | 'deep' | 'manual';
  maxDepth: number;
  maxPages: number;
  rateLimitMs: number;
  requireConfirmation: boolean;
  allowedDomains: string[];
  blockedDomains: string[];
}

export interface StorageSettings {
  model: ModelSettings;
  links: LinkFollowSettings;
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

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  reasoning?: ReasoningStep[];
  linkVisits?: LinkVisit[];
  linkDecisions?: LinkDecision[];
  modelUsed?: 'local' | 'cloud';
  isStreaming?: boolean;
}

export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface AccountState {
  configured: boolean;
  user: { id: string; email: string } | null;
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'synced' | 'paused' | 'error';
  lastSyncedAt?: number;
  error?: string;
}

/** Settings that are safe and meaningful to move between devices. */
export interface SyncedSettings {
  model: Omit<ModelSettings, 'apiKey' | 'useLocal'>;
  links: LinkFollowSettings;
  ui: StorageSettings['ui'];
  privacy: Omit<StorageSettings['privacy'], 'localOnly'>;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  modelUsed: 'local' | 'cloud';
  tokensUsed?: number;
}

export interface BackgroundMessage {
  type:
    | 'GET_TAB_CONTENT'
    | 'ASK_QUESTION'
    | 'STOP_GENERATION'
    | 'FOLLOW_LINKS'
    | 'GET_SETTINGS'
    | 'UPDATE_SETTINGS'
    | 'PING'
    | 'DOWNLOAD_MODEL'
    | 'AUTH_GET_STATE'
    | 'AUTH_SIGN_UP'
    | 'AUTH_VERIFY_EMAIL'
    | 'AUTH_SIGN_IN'
    | 'AUTH_SIGN_IN_GOOGLE'
    | 'AUTH_REQUEST_RECOVERY'
    | 'AUTH_VERIFY_RECOVERY'
    | 'AUTH_UPDATE_PASSWORD'
    | 'AUTH_SIGN_OUT'
    | 'SYNC_PULL'
    | 'SYNC_PUSH_CONVERSATIONS'
    | 'SYNC_PUSH_SETTINGS';
  tabId?: number;
  question?: string;
  context?: TabContent;
  history?: ChatMessage[];
  settings?: Partial<StorageSettings>;
  modelUrl?: string;
  messageId?: string;
  email?: string;
  password?: string;
  token?: string;
  conversations?: ChatConversation[];
}

export interface ContentScriptMessage {
  type: 'GET_TAB_CONTENT' | 'TAB_CONTENT' | 'ERROR';
  content?: TabContent;
  message?: string;
}

export interface SidePanelMessage {
  type: 'STREAM_CHUNK' | 'ERROR' | 'REASONING' | 'LINK_VISIT' | 'LINK_DECISION' | 'DONE';
  chunk?: string;
  messageId?: string;
  reasoning?: ReasoningStep[];
  linkVisit?: LinkVisit;
  linkDecision?: LinkDecision;
  done?: boolean;
  message?: string;
}

export type { StorageSettings as Settings };
