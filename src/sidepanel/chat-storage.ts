import type { ChatConversation, ChatMessage } from '@/shared/types';
import { ANONYMOUS_SCOPE, activeConversationKey, conversationKey } from '@/shared/storage';

const CHAT_CONVERSATIONS_KEY = 'chrome-ai-conversations';
const ACTIVE_CONVERSATION_KEY = 'chrome-ai-active-conversation';
const LEGACY_CHAT_HISTORY_PREFIX = 'chrome-ai-chat-history:';
const MAX_STORED_MESSAGES = 100;

export async function loadChatState(scope = ANONYMOUS_SCOPE) {
  const result = await chrome.storage.local.get(null);
  const scopedConversationsKey = conversationKey(scope);
  const scopedActiveKey = activeConversationKey(scope);
  const saved =
    result[scopedConversationsKey] ??
    (scope === ANONYMOUS_SCOPE ? result[CHAT_CONVERSATIONS_KEY] : undefined);
  const restored = Array.isArray(saved) ? saved : restoreLegacyConversations(result);
  const savedActiveId =
    result[scopedActiveKey] ??
    (scope === ANONYMOUS_SCOPE ? result[ACTIVE_CONVERSATION_KEY] : undefined);
  if (
    scope === ANONYMOUS_SCOPE &&
    result[CHAT_CONVERSATIONS_KEY] &&
    !result[scopedConversationsKey]
  ) {
    await chrome.storage.local.set({
      [scopedConversationsKey]: restored,
      [scopedActiveKey]: savedActiveId,
    });
    await chrome.storage.local.remove([CHAT_CONVERSATIONS_KEY, ACTIVE_CONVERSATION_KEY]);
  }
  return {
    conversations: await hydrateResearchJobs(restored),
    activeConversationId: typeof savedActiveId === 'string' ? savedActiveId : undefined,
  };
}

export function saveChatState(
  conversations: ChatConversation[],
  activeConversationId?: string,
  scope = ANONYMOUS_SCOPE
) {
  return chrome.storage.local.set({
    [conversationKey(scope)]: conversations.map(chat => ({
      ...chat,
      messages: chat.messages
        .filter(message => !message.isStreaming || message.researchJobId)
        .map(message => (message.researchJobId ? { ...message, isStreaming: false } : message))
        .slice(-MAX_STORED_MESSAGES),
    })),
    [activeConversationKey(scope)]: activeConversationId,
  });
}

function restoreLegacyConversations(storage: { [key: string]: unknown }): ChatConversation[] {
  return Object.entries(storage)
    .filter(([key, value]) => key.startsWith(LEGACY_CHAT_HISTORY_PREFIX) && Array.isArray(value))
    .map(([key, value]) => {
      const url = key.slice(LEGACY_CHAT_HISTORY_PREFIX.length);
      const messages = value as ChatMessage[];
      const timestamp = messages.at(-1)?.timestamp || Date.now();
      return {
        id: crypto.randomUUID(),
        title: `Chat from ${getHost(url)}`,
        messages,
        createdAt: messages[0]?.timestamp || timestamp,
        updatedAt: timestamp,
      };
    });
}

async function hydrateResearchJobs(chats: ChatConversation[]): Promise<ChatConversation[]> {
  return Promise.all(
    chats.map(async chat => ({
      ...chat,
      messages: await Promise.all(chat.messages.map(hydrateResearchMessage)),
    }))
  );
}

async function hydrateResearchMessage(message: ChatMessage): Promise<ChatMessage> {
  if (!message.researchJobId) return message;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_RESEARCH_JOB',
      jobId: message.researchJobId,
    });
    const job = response?.job;
    if (!job) return message;
    return {
      ...message,
      content: job.finalAnswer || job.partialAnswer || message.content,
      researchProgress: job.progress,
      isStreaming: ['queued', 'running'].includes(job.status),
    };
  } catch {
    return message;
  }
}

function getHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
