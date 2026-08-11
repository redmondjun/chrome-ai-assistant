import React, { useEffect, useRef } from 'react';
import type { ChatMessage } from '@/shared/types';
import { EmptyState } from './EmptyState';
import { MessageItem } from './MessageItem';

interface ConversationProps {
  messages: ChatMessage[];
  promptsEnabled: boolean;
  onPrompt: (prompt: string) => void;
  discreet?: boolean;
}

export function Conversation({
  messages,
  promptsEnabled,
  onPrompt,
  discreet = false,
}: ConversationProps) {
  const conversationRef = useRef<HTMLElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages]);

  const handleScroll = () => {
    const conversation = conversationRef.current;
    if (!conversation) return;

    shouldAutoScrollRef.current =
      conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 48;
  };

  return (
    <section
      ref={conversationRef}
      className="conversation"
      aria-live="polite"
      onScroll={handleScroll}
    >
      {messages.length === 0 ? (
        <EmptyState enabled={promptsEnabled} onPrompt={onPrompt} discreet={discreet} />
      ) : (
        messages.map(message => (
          <MessageItem key={message.id} message={message} discreet={discreet} />
        ))
      )}
      <div ref={endRef} />
    </section>
  );
}
