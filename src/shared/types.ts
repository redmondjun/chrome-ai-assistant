import type { LinkSafetyResult } from './link-safety';

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
  safety?: LinkSafetyResult;
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

export interface ResearchSettings {
  workerConcurrency: number;
  maxRelatedSourcesPerTask: number;
  cloudNoticeAccepted: boolean;
}

export type ResearchJobStatus =
  'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';

export type ResearchTaskStatus = 'queued' | 'running' | 'completed' | 'skipped' | 'failed';
export type ResearchWorkerPhase =
  'queued' | 'scoring' | 'opening' | 'reading' | 'analyzing' | 'completed' | 'skipped' | 'failed';

export interface ResearchEvidence {
  url: string;
  title: string;
  category: 'ticket' | 'epic' | 'business' | 'documentation' | 'code-review' | 'other';
  excerpt: string;
  depth: number;
}

export interface ResearchSourceDecision {
  url: string;
  title: string;
  outcome: 'selected' | 'discarded' | 'skipped' | 'failed';
  reason: string;
  score?: number;
  depth: number;
  timestamp: number;
}

export interface ResearchTask {
  id: string;
  label: string;
  sourceUrl: string;
  title: string;
  status: ResearchTaskStatus;
  phase: ResearchWorkerPhase;
  phaseStartedAt: number;
  lastActivityAt: number;
  currentSource?: { url: string; title: string; depth: number };
  reasoning: ReasoningStep[];
  linkVisits: LinkVisit[];
  relatedSourcesRead: number;
  relatedSourcesAttempted: number;
  evidence: ResearchEvidence[];
  decisions: ResearchSourceDecision[];
  pendingSources: Array<{ url: string; title: string; depth: number; score?: number }>;
  visitedUrls: string[];
  report?: string;
  error?: string;
}

export interface ResearchProgress {
  jobId: string;
  status: ResearchJobStatus;
  activity: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  activeWorkers: number;
  sourcesRead: number;
  sourcesFailed: number;
  updatedAt: number;
  activeTaskIds: string[];
}

export interface ResearchJob {
  id: string;
  messageId: string;
  question: string;
  status: ResearchJobStatus;
  tasks: ResearchTask[];
  progress: ResearchProgress;
  finalAnswer?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StorageSettings {
  model: ModelSettings;
  links: LinkFollowSettings;
  research: ResearchSettings;
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
  researchJobId?: string;
  researchProgress?: ResearchProgress;
}

export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
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
    | 'START_RESEARCH'
    | 'PAUSE_RESEARCH'
    | 'RESUME_RESEARCH'
    | 'RETRY_RESEARCH'
    | 'CANCEL_RESEARCH'
    | 'GET_RESEARCH_JOB';
  tabId?: number;
  question?: string;
  context?: TabContent;
  history?: ChatMessage[];
  settings?: Partial<StorageSettings>;
  modelUrl?: string;
  messageId?: string;
  jobId?: string;
}

export interface ContentScriptMessage {
  type: 'GET_TAB_CONTENT' | 'TAB_CONTENT' | 'ERROR';
  content?: TabContent;
  message?: string;
}

export interface SidePanelMessage {
  type:
    | 'STREAM_CHUNK'
    | 'ERROR'
    | 'REASONING'
    | 'LINK_VISIT'
    | 'LINK_DECISION'
    | 'RESEARCH_PROGRESS'
    | 'RESEARCH_TASK_UPDATE'
    | 'DONE';
  chunk?: string;
  messageId?: string;
  reasoning?: ReasoningStep[];
  linkVisit?: LinkVisit;
  linkDecision?: LinkDecision;
  done?: boolean;
  message?: string;
  researchProgress?: ResearchProgress;
}

export type { StorageSettings as Settings };
