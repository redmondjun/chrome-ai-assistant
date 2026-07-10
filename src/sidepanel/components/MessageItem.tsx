import React, { useMemo } from 'react';
import { marked } from 'marked';
import type { ChatMessage } from '@/shared/types';
import { AnswerDetails } from './AnswerDetails';

export function MessageItem({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const isError = !isUser && message.content.startsWith('Error:');
  const renderedContent = useMemo(
    () => marked.parse(message.content || '', { async: false }) as string,
    [message.content]
  );

  const className = [
    'message',
    isUser ? 'message-user' : 'message-assistant',
    isError ? 'message-error' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={className}>
      {!isUser && <AssistantMetadata message={message} />}
      <div className="message-body">
        {message.content ? (
          <div className="message-content" dangerouslySetInnerHTML={{ __html: renderedContent }} />
        ) : (
          <TypingIndicator />
        )}
      </div>
      {!isUser && <AnswerDetails reasoning={message.reasoning} links={message.linkVisits} />}
    </article>
  );
}

function AssistantMetadata({ message }: { message: ChatMessage }) {
  return (
    <div className="message-meta">
      <span className="assistant-mark">N</span>
      <strong>Assistant</strong>
      {message.modelUsed && <span>{message.modelUsed}</span>}
      {message.isStreaming && (
        <span className="streaming">
          <i />
          Generating
        </span>
      )}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="typing" aria-label="Generating response">
      <i />
      <i />
      <i />
    </div>
  );
}
