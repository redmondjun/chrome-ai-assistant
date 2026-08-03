import React from 'react';
import { AppearancePrivacySection } from './components/AppearancePrivacySection';
import { AccountSyncSection } from './components/AccountSyncSection';
import { BackupRestoreSection } from './components/BackupRestoreSection';
import { LinkSettingsSection } from './components/LinkSettingsSection';
import { ModelSettingsSection } from './components/ModelSettingsSection';
import { ResearchSettingsSection } from './components/ResearchSettingsSection';
import { useSettingsForm } from './useSettingsForm';

export function SettingsForm() {
  const {
    settings,
    setSettings,
    saved,
    localModelStatus,
    saveSettings,
    resetSettings,
    exportSettings,
    importSettings,
    startModelDownload,
  } = useSettingsForm();

  return (
    <main className="settings-page max-w-3xl mx-auto p-6">
      <header className="settings-heading mb-6">
        <p className="settings-eyebrow">Page Assistant</p>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Configure models, page research, appearance, and privacy.
        </p>
      </header>

      {saved && (
        <div className="save-notice mb-4 p-3 rounded" role="status">
          Settings saved.
        </div>
      )}

      <div className="space-y-6">
        <AccountSyncSection />
        <ModelSettingsSection
          settings={settings.model}
          localModelStatus={localModelStatus}
          onChange={model => setSettings(current => ({ ...current, model }))}
          onDownloadModel={() => void startModelDownload()}
        />
        <LinkSettingsSection
          settings={settings.links}
          onChange={links => setSettings(current => ({ ...current, links }))}
        />
        <ResearchSettingsSection
          settings={settings.research}
          onChange={research => setSettings(current => ({ ...current, research }))}
        />
        <AppearancePrivacySection
          ui={settings.ui}
          privacy={settings.privacy}
          onUiChange={ui => setSettings(current => ({ ...current, ui }))}
          onPrivacyChange={privacy => setSettings(current => ({ ...current, privacy }))}
        />
        <BackupRestoreSection
          onExport={exportSettings}
          onImport={importSettings}
          onReset={() => void resetSettings()}
        />
      </div>

      <div className="save-bar mt-6 flex justify-end gap-4">
        <button
          type="button"
          onClick={() => void saveSettings()}
          className="px-6 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
        >
          Save Settings
        </button>
      </div>
    </main>
  );
}
