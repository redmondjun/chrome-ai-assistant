import React, { useMemo } from 'react';
import { marked } from 'marked';
import { AnswerDetails } from './AnswerDetails';
import { handleAnswerLinkClick } from './message-links';
import { ResearchJobPanel } from './ResearchJobPanel';
import { StreamingProgress } from './StreamingProgress';
import type { ChatMessage } from '@/shared/types';

export function MessageItem({
  message,
  onRetry,
}: {
  message: ChatMessage;
  onRetry?: (messageId: string) => void;
}) {
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
      {message.researchProgress ? (
        <ResearchJobPanel progress={message.researchProgress} />
      ) : (
        message.isStreaming && <StreamingProgress message={message} />
      )}
      {!isUser && (
        <AnswerDetails
          reasoning={message.reasoning}
          links={message.linkVisits}
          isStreaming={message.isStreaming}
        />
      )}
      <div className="message-body">
        {message.content ? (
          <div
            className="message-content"
            dangerouslySetInnerHTML={{ __html: renderedContent }}
            onClick={isUser ? undefined : handleAnswerLinkClick}
          />
        ) : (
          <TypingIndicator />
        )}
      </div>
      {message.agentRun?.diagnosticId &&
        ['failed', 'interrupted'].includes(message.agentRun.status) && (
          <small className="danger-text">Diagnostic ID: {message.agentRun.diagnosticId}</small>
        )}
      {message.agentRun?.health === 'stalled-suspected' && (
        <div className="research-job-actions" aria-label="Stalled request actions">
          <span className="danger-text">
            No operation progress was detected. Diagnostic ID:{' '}
            {message.agentRun.diagnosticId || message.agentRun.attemptId}
          </span>
          <button type="button" onClick={() => onRetry?.(message.id)}>
            Retry in parallel
          </button>
          <button
            type="button"
            onClick={() =>
              void chrome.runtime.sendMessage(
                message.researchJobId
                  ? { type: 'PAUSE_RESEARCH', jobId: message.researchJobId }
                  : { type: 'STOP_GENERATION', messageId: message.id }
              )
            }
          >
            Stop this attempt
          </button>
        </div>
      )}
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
