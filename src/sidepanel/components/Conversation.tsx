import React, { useEffect, useRef } from 'react';
import type { ChatMessage } from '@/shared/types';
import { EmptyState } from './EmptyState';
import { MessageItem } from './MessageItem';

interface ConversationProps {
  messages: ChatMessage[];
  promptsEnabled: boolean;
  onPrompt: (prompt: string) => void;
}

export function Conversation({ messages, promptsEnabled, onPrompt }: ConversationProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <section className="conversation" aria-live="polite">
      {messages.length === 0 ? (
        <EmptyState enabled={promptsEnabled} onPrompt={onPrompt} />
      ) : (
        messages.map(message => <MessageItem key={message.id} message={message} />)
      )}
      <div ref={endRef} />
    </section>
  );
}
