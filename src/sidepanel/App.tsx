import React from 'react';
import { ApiKeyOnboarding } from './components/ApiKeyOnboarding';
import { PageAttachments } from './components/PageAttachments';
import { Composer } from './components/Composer';
import { Conversation } from './components/Conversation';
import { PageHeader } from './components/PageHeader';
import { useActiveTab } from './hooks/useActiveTab';
import { useChat } from './hooks/useChat';
import { useSavedPages } from './hooks/useSavedPages';
import { useSidepanelSettings } from './hooks/useSidepanelSettings';
import { isEvidenceLink } from '@/background/research/link-policy';
import type { LinkInfo } from '@/shared/types';

export default function App() {
  const activeTab = useActiveTab();
  const settings = useSidepanelSettings();
  const chat = useChat(activeTab.content, {
    localOnly: settings.localOnly,
    cloudNoticeAccepted: settings.research.cloudNoticeAccepted,
    cloudEndpoint: settings.model.customEndpoint || 'https://integrate.api.nvidia.com',
    acceptCloudNotice: settings.acceptCloudNotice,
  });
  const savedPages = useSavedPages(chat.activeConversationId);

  const openSettings = () => chrome.runtime.openOptionsPage();

  if (!settings.isLoaded) {
    return <LoadingScreen />;
  }

  if (!settings.model.apiKey.trim() && !settings.localModelReady) {
    return (
      <ApiKeyOnboarding
        onSave={apiKey => settings.updateModel({ apiKey, useLocal: false })}
        onOpenSettings={openSettings}
      />
    );
  }

  const pageReady = Boolean(activeTab.content && !activeTab.isLoading && !activeTab.error);

  return (
    <main className="app-shell">
      <PageHeader
        page={activeTab.content}
        isLoading={activeTab.isLoading}
        error={activeTab.error}
        model={settings.model.cloudModel}
        onModelChange={cloudModel => void settings.updateModel({ cloudModel })}
        onRetry={() => void activeTab.reload()}
        onOpenSettings={openSettings}
        conversations={chat.conversations}
        activeConversationId={chat.activeConversationId}
        onConversationChange={chat.selectConversation}
        onNewConversation={chat.startNewConversation}
        conversationBusy={chat.isLoading}
      />
      <Conversation
        messages={chat.messages}
        promptsEnabled={pageReady}
        onPrompt={prompt => void chat.send(prompt, savedPages.selectedPages)}
        onRetry={messageId => void chat.retry(messageId)}
      />
      <PageAttachments
        pages={savedPages.pages}
        selectedIds={savedPages.selectedIds}
        disabled={chat.isLoading || !savedPages.isLoaded}
        onAdd={savedPages.addSnapshot}
        onSelect={savedPages.select}
        onRemove={savedPages.remove}
        onRefresh={savedPages.replaceSnapshot}
        onRefreshWarning={savedPages.setRefreshWarning}
      />
      <Composer
        value={chat.input}
        onChange={chat.setInput}
        onSend={() => void chat.send(undefined, savedPages.selectedPages)}
        pageReady={pageReady}
        busy={chat.isLoading || !chat.isHistoryLoaded}
        generating={chat.isLoading}
        onStop={() => void chat.stop()}
        deepResearch={chat.deepResearch}
        onDeepResearchChange={chat.setDeepResearch}
        researchSubjectCount={countResearchLinks([
          ...(activeTab.content?.links || []),
          ...savedPages.selectedPages.flatMap(page => page.links),
        ])}
      />
    </main>
  );
}

function countResearchLinks(links: LinkInfo[]) {
  const sources = new Set<string>();
  links.forEach(link => {
    if (!isEvidenceLink(link)) return;
    try {
      const url = new URL(link.url);
      url.hash = '';
      sources.add(url.href);
    } catch {
      // Ignore invalid extracted URLs.
    }
  });
  return sources.size;
}

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <span className="loader" />
      <p>Preparing your assistant…</p>
    </main>
  );
}
