import { useCallback, useEffect, useState } from 'react';
import type { ChatConversation, ChatMessage, TabContent } from '@/shared/types';

const CHAT_CONVERSATIONS_KEY = 'chrome-ai-conversations';
const ACTIVE_CONVERSATION_KEY = 'chrome-ai-active-conversation';
const LEGACY_CHAT_HISTORY_PREFIX = 'chrome-ai-chat-history:';
const MAX_STORED_MESSAGES = 100;

export function useChat(page: TabContent | null) {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeMessageId, setActiveMessageId] = useState<string>();
  const [isHistoryLoaded, setIsHistoryLoaded] = useState(false);
  const activeConversation = conversations.find(chat => chat.id === activeConversationId);
  const messages = activeConversation?.messages || [];

  useEffect(() => {
    let active = true;
    void chrome.storage.local.get(null).then(result => {
      if (!active) return;
      const saved = result[CHAT_CONVERSATIONS_KEY];
      const chats = Array.isArray(saved) ? saved : restoreLegacyConversations(result);
      const selected = chats.find(chat => chat.id === result[ACTIVE_CONVERSATION_KEY]) || chats[0];
      const initial = selected || createConversation();
      setConversations(selected ? chats : [initial]);
      setActiveConversationId(initial.id);
      setIsHistoryLoaded(true);
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isHistoryLoaded) return;
    void chrome.storage.local.set({
      [CHAT_CONVERSATIONS_KEY]: conversations.map(chat => ({
        ...chat,
        messages: chat.messages.filter(message => !message.isStreaming).slice(-MAX_STORED_MESSAGES),
      })),
      [ACTIVE_CONVERSATION_KEY]: activeConversationId,
    });
  }, [activeConversationId, conversations, isHistoryLoaded]);

  const updateMessage = useCallback(
    (messageId: string, update: (message: ChatMessage) => ChatMessage) => {
      setConversations(current =>
        current.map(chat =>
          chat.id === activeConversationId
            ? {
                ...chat,
                messages: chat.messages.map(message =>
                  message.id === messageId ? update(message) : message
                ),
                updatedAt: Date.now(),
              }
            : chat
        )
      );
    },
    [activeConversationId]
  );

  const finishMessage = useCallback(
    (messageId: string, content?: string) => {
      updateMessage(messageId, message => ({
        ...message,
        content: content ?? message.content,
        isStreaming: false,
      }));
      setIsLoading(false);
      setActiveMessageId(current => (current === messageId ? undefined : current));
    },
    [updateMessage]
  );

  useEffect(() => {
    const handleMessage = (message: any) => {
      switch (message.type) {
        case 'STREAM_CHUNK':
          updateMessage(message.messageId, current => ({
            ...current,
            content: current.content + (message.chunk || ''),
            reasoning: message.reasoning || current.reasoning,
            linkVisits: message.linkVisit
              ? [...(current.linkVisits || []), message.linkVisit]
              : current.linkVisits,
            isStreaming: !message.done,
          }));
          break;
        case 'REASONING':
          updateMessage(message.messageId, current => ({
            ...current,
            reasoning: [...(current.reasoning || []), message.step],
          }));
          break;
        case 'LINK_VISIT':
          updateMessage(message.messageId, current => ({
            ...current,
            linkVisits: [...(current.linkVisits || []), message.visit],
          }));
          break;
        case 'LINK_DECISION':
          updateMessage(message.messageId, current => ({
            ...current,
            linkDecisions: [...(current.linkDecisions || []), message.decision],
          }));
          break;
        case 'STREAM_DONE':
        case 'DONE':
          finishMessage(message.messageId);
          break;
        case 'ERROR':
          finishMessage(message.messageId, formatChatError(message.message));
          break;
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, [finishMessage, updateMessage]);

  const send = useCallback(
    async (prompt?: string) => {
      const question = (prompt ?? input).trim();
      if (!question || !page || isLoading) return;

      const userMessage = createMessage('user', question);
      const assistantMessage = createMessage('assistant', '', true);
      setConversations(current =>
        current.map(chat =>
          chat.id === activeConversationId
            ? {
                ...chat,
                title: chat.messages.length === 0 ? question.slice(0, 48) : chat.title,
                messages: [...chat.messages, userMessage, assistantMessage],
                updatedAt: Date.now(),
              }
            : chat
        )
      );
      setInput('');
      setIsLoading(true);
      setActiveMessageId(assistantMessage.id);

      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const response = await chrome.runtime.sendMessage({
          type: 'ASK_QUESTION',
          question,
          messageId: assistantMessage.id,
          context: page,
          history: messages,
          tabId: tab?.id,
        });
        if (response?.error) throw new Error(response.error);
      } catch (sendError) {
        finishMessage(assistantMessage.id, formatChatError(sendError));
      }
    },
    [activeConversationId, finishMessage, input, isLoading, messages, page]
  );

  const stop = useCallback(async () => {
    if (!activeMessageId) return;
    const messageId = activeMessageId;
    updateMessage(messageId, message => ({
      ...message,
      content: message.content || 'Response stopped.',
      isStreaming: false,
    }));
    setIsLoading(false);
    setActiveMessageId(undefined);
    try {
      await chrome.runtime.sendMessage({ type: 'STOP_GENERATION', messageId });
    } catch (error) {
      console.error('[chat]', 'Could not stop generation:', error);
    }
  }, [activeMessageId, updateMessage]);

  const startNewConversation = useCallback(() => {
    const conversation = createConversation();
    setConversations(current => [conversation, ...current]);
    setActiveConversationId(conversation.id);
    setInput('');
  }, []);

  return {
    conversations,
    activeConversationId,
    selectConversation: setActiveConversationId,
    startNewConversation,
    messages,
    input,
    setInput,
    isLoading,
    isHistoryLoaded,
    send,
    stop,
  };
}

function formatChatError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return `Error: ${message.replace(/^(?:Error:\s*)+/i, '')}`;
}

function createConversation(): ChatConversation {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: 'New chat',
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
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

function getHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function createMessage(
  role: ChatMessage['role'],
  content: string,
  isStreaming = false
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: Date.now(),
    isStreaming,
  };
}
