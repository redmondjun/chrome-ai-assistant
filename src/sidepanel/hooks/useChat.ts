import { useCallback, useEffect, useState } from 'react';
import { loadChatState, saveChatState } from '../chat-storage';
import type { ChatConversation, ChatMessage, TabContent } from '@/shared/types';

interface ResearchOptions {
  localOnly: boolean;
  cloudNoticeAccepted: boolean;
  cloudEndpoint: string;
  acceptCloudNotice: () => Promise<void>;
}

export function useChat(page: TabContent | null, researchOptions: ResearchOptions) {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeMessageId, setActiveMessageId] = useState<string>();
  const [isHistoryLoaded, setIsHistoryLoaded] = useState(false);
  const [deepResearch, setDeepResearch] = useState(false);
  const activeConversation = conversations.find(chat => chat.id === activeConversationId);
  const messages = activeConversation?.messages || [];

  useEffect(() => {
    let active = true;
    void loadChatState().then(({ conversations: chats, activeConversationId: savedActiveId }) => {
      if (!active) return;
      const selected = chats.find(chat => chat.id === savedActiveId) || chats[0];
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
    void saveChatState(conversations, activeConversationId);
  }, [activeConversationId, conversations, isHistoryLoaded]);

  useEffect(() => {
    const runningResearch = messages.find(
      message =>
        message.researchJobId &&
        ['queued', 'running'].includes(message.researchProgress?.status || '')
    );
    if (!runningResearch) return;
    setIsLoading(true);
    setActiveMessageId(runningResearch.id);
  }, [messages]);

  const updateMessage = useCallback(
    (messageId: string, update: (message: ChatMessage) => ChatMessage) => {
      setConversations(current =>
        current.map(chat => {
          if (!chat.messages.some(message => message.id === messageId)) return chat;
          return {
            ...chat,
            messages: chat.messages.map(message =>
              message.id === messageId ? update(message) : message
            ),
            updatedAt: Date.now(),
          };
        })
      );
    },
    []
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
        case 'RESEARCH_PROGRESS':
          updateMessage(message.messageId, current => ({
            ...current,
            researchJobId: message.progress.jobId,
            researchProgress: message.progress,
            isStreaming: ['queued', 'running'].includes(message.progress.status),
          }));
          if (['paused', 'cancelled', 'completed', 'failed'].includes(message.progress.status)) {
            setIsLoading(false);
          } else {
            setIsLoading(true);
            setActiveMessageId(message.messageId);
          }
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

      if (deepResearch && !researchOptions.localOnly && !researchOptions.cloudNoticeAccepted) {
        const accepted = window.confirm(
          `Deep Research sends internal page excerpts to ${researchOptions.cloudEndpoint || 'the configured NVIDIA endpoint'}. Continue only if this endpoint is approved for company data.`
        );
        if (!accepted) return;
        await researchOptions.acceptCloudNotice();
      }

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
          type: deepResearch ? 'START_RESEARCH' : 'ASK_QUESTION',
          question,
          messageId: assistantMessage.id,
          context: page,
          history: messages,
          tabId: tab?.id,
        });
        if (response?.error) throw new Error(response.error);
        if (response?.jobId) {
          updateMessage(assistantMessage.id, message => ({
            ...message,
            researchJobId: response.jobId,
            researchProgress: response.progress,
          }));
        }
      } catch (sendError) {
        finishMessage(assistantMessage.id, formatChatError(sendError));
      }
    },
    [
      activeConversationId,
      deepResearch,
      finishMessage,
      input,
      isLoading,
      messages,
      page,
      researchOptions,
      updateMessage,
    ]
  );

  const stop = useCallback(async () => {
    if (!activeMessageId) return;
    const messageId = activeMessageId;
    const activeMessage = messages.find(message => message.id === messageId);
    if (activeMessage?.researchJobId) {
      try {
        await chrome.runtime.sendMessage({
          type: 'PAUSE_RESEARCH',
          jobId: activeMessage.researchJobId,
        });
      } catch (error) {
        console.error('[chat]', 'Could not pause research:', error);
      }
      return;
    }
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
  }, [activeMessageId, messages, updateMessage]);

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
    deepResearch,
    setDeepResearch,
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
