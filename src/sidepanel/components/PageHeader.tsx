import React from 'react';
import type { ChatConversation, ModelSettings, TabContent } from '@/shared/types';

interface PageHeaderProps {
  page: TabContent | null;
  isLoading: boolean;
  error: string;
  model: ModelSettings['cloudModel'];
  onModelChange: (model: ModelSettings['cloudModel']) => void;
  onRetry: () => void;
  onOpenSettings: () => void;
  conversations: ChatConversation[];
  activeConversationId?: string;
  onConversationChange: (id: string) => void;
  onNewConversation: () => void;
  conversationBusy: boolean;
}

export function PageHeader({
  page,
  isLoading,
  error,
  model,
  onModelChange,
  onRetry,
  onOpenSettings,
  conversations,
  activeConversationId,
  onConversationChange,
  onNewConversation,
  conversationBusy,
}: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="brand-row">
        <Brand />
        <HeaderActions
          model={model}
          onModelChange={onModelChange}
          onOpenSettings={onOpenSettings}
          conversations={conversations}
          activeConversationId={activeConversationId}
          onConversationChange={onConversationChange}
          onNewConversation={onNewConversation}
          conversationBusy={conversationBusy}
        />
      </div>
      <PageContext page={page} isLoading={isLoading} error={error} onRetry={onRetry} />
    </header>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        N
      </span>
      <span>Page Assistant</span>
    </div>
  );
}

function HeaderActions({
  model,
  onModelChange,
  onOpenSettings,
  conversations,
  activeConversationId,
  onConversationChange,
  onNewConversation,
  conversationBusy,
}: Pick<
  PageHeaderProps,
  | 'model'
  | 'onModelChange'
  | 'onOpenSettings'
  | 'conversations'
  | 'activeConversationId'
  | 'onConversationChange'
  | 'onNewConversation'
  | 'conversationBusy'
>) {
  return (
    <div className="header-actions">
      <label className="sr-only" htmlFor="conversation-select">
        Conversation
      </label>
      <select
        id="conversation-select"
        className="conversation-select"
        value={activeConversationId}
        disabled={conversationBusy}
        onChange={event => onConversationChange(event.target.value)}
      >
        {conversations.map(conversation => (
          <option key={conversation.id} value={conversation.id}>
            {conversation.title}
          </option>
        ))}
      </select>
      <button
        className="new-chat-button"
        type="button"
        disabled={conversationBusy}
        onClick={onNewConversation}
      >
        New chat
      </button>
      <label className="sr-only" htmlFor="model-select">
        AI model
      </label>
      <select
        id="model-select"
        className="model-select"
        value={model}
        onChange={event => onModelChange(event.target.value as ModelSettings['cloudModel'])}
      >
        <option value="nemotron-3-nano">Nano</option>
        <option value="nemotron-3-super">Super</option>
        <option value="nemotron-3-ultra">Ultra</option>
        <option value="custom">Custom</option>
      </select>
      <button
        className="icon-button"
        type="button"
        aria-label="Open settings"
        title="Settings"
        onClick={onOpenSettings}
      >
        <SettingsIcon />
      </button>
    </div>
  );
}

function PageContext({
  page,
  isLoading,
  error,
  onRetry,
}: Pick<PageHeaderProps, 'page' | 'isLoading' | 'error' | 'onRetry'>) {
  const host = page?.url ? new URL(page.url).hostname.replace(/^www\./, '') : '';
  const title = isLoading
    ? 'Reading this page…'
    : error
      ? 'This page can’t be read'
      : page?.title || 'Waiting for a page';
  const description = error || host || 'Open a regular website to start';
  const status = isLoading ? 'loading' : error ? 'error' : 'ready';

  return (
    <div className={`page-context ${error ? 'page-context-error' : ''}`}>
      <span className={`status-dot status-${status}`} aria-hidden="true" />
      <div className="page-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      {error && (
        <button type="button" className="retry-button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </svg>
  );
}
