import React from 'react';
import { ApiKeyOnboarding } from './components/ApiKeyOnboarding';
import { Composer } from './components/Composer';
import { Conversation } from './components/Conversation';
import { PageHeader } from './components/PageHeader';
import { useActiveTab } from './hooks/useActiveTab';
import { useChat } from './hooks/useChat';
import { useSidepanelSettings } from './hooks/useSidepanelSettings';
import './styles.css';

export default function App() {
  const activeTab = useActiveTab();
  const settings = useSidepanelSettings();
  const chat = useChat(activeTab.content);

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
      />
      <Conversation
        messages={chat.messages}
        promptsEnabled={pageReady}
        onPrompt={prompt => void chat.send(prompt)}
      />
      <Composer
        value={chat.input}
        onChange={chat.setInput}
        onSend={() => void chat.send()}
        pageReady={pageReady}
        busy={chat.isLoading}
      />
    </main>
  );
}

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <span className="loader" />
      <p>Preparing your assistant…</p>
    </main>
  );
}
