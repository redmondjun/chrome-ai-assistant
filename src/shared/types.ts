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
  modelUsed?: 'local' | 'cloud';
  isStreaming?: boolean;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
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
    | 'FOLLOW_LINKS'
    | 'GET_SETTINGS'
    | 'UPDATE_SETTINGS'
    | 'PING'
    | 'DOWNLOAD_MODEL';
  tabId?: number;
  question?: string;
  context?: TabContent;
  settings?: Partial<StorageSettings>;
  modelUrl?: string;
  messageId?: string;
}

export interface ContentScriptMessage {
  type: 'GET_TAB_CONTENT' | 'TAB_CONTENT' | 'ERROR';
  content?: TabContent;
  message?: string;
}

export interface SidePanelMessage {
  type: 'STREAM_CHUNK' | 'ERROR' | 'REASONING' | 'LINK_VISIT' | 'DONE';
  chunk?: string;
  messageId?: string;
  reasoning?: ReasoningStep[];
  linkVisit?: LinkVisit;
  done?: boolean;
  message?: string;
}

export type { StorageSettings as Settings };
