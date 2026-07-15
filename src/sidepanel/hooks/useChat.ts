import { useCallback, useEffect, useState } from 'react';
import type { ChatMessage, TabContent } from '@/shared/types';

const CHAT_HISTORY_PREFIX = 'chrome-ai-chat-history:';
const MAX_STORED_MESSAGES = 100;

export function useChat(page: TabContent | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadedHistoryKey, setLoadedHistoryKey] = useState<string>();
  const historyKey = page ? `${CHAT_HISTORY_PREFIX}${page.url}` : undefined;

  useEffect(() => {
    if (!historyKey) {
      setMessages([]);
      setLoadedHistoryKey(undefined);
      return;
    }

    let active = true;
    setLoadedHistoryKey(undefined);
    setMessages([]);

    void chrome.storage.local.get(historyKey).then(result => {
      if (!active) return;
      const saved = result[historyKey];
      setMessages(Array.isArray(saved) ? saved : []);
      setLoadedHistoryKey(historyKey);
    });

    return () => {
      active = false;
    };
  }, [historyKey]);

  useEffect(() => {
    if (!historyKey || loadedHistoryKey !== historyKey) return;

    const completedMessages = messages.filter(message => !message.isStreaming).slice(-MAX_STORED_MESSAGES);
    void chrome.storage.local.set({ [historyKey]: completedMessages });
  }, [historyKey, loadedHistoryKey, messages]);

  const updateMessage = useCallback(
    (messageId: string, update: (message: ChatMessage) => ChatMessage) => {
      setMessages(current =>
        current.map(message => (message.id === messageId ? update(message) : message))
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
        case 'STREAM_DONE':
        case 'DONE':
          finishMessage(message.messageId);
          break;
        case 'ERROR':
          finishMessage(message.messageId, `Error: ${message.message}`);
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
      setMessages(current => [...current, userMessage, assistantMessage]);
      setInput('');
      setIsLoading(true);

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
        const error = sendError instanceof Error ? sendError.message : String(sendError);
        finishMessage(assistantMessage.id, `Error: ${error}`);
      }
    },
    [finishMessage, input, isLoading, messages, page]
  );

  return {
    messages,
    input,
    setInput,
    isLoading,
    isHistoryLoaded: Boolean(historyKey && loadedHistoryKey === historyKey),
    send,
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
