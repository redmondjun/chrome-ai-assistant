import { useEffect, useState } from 'react';
import { useTheme } from '@/shared/theme';
import { downloadLocalModel, hasLocalModel } from './model-storage';
import { DEFAULT_SETTINGS, mergeSettings, type ExtensionSettings } from './settings-model';

const SETTINGS_KEY = 'chrome-ai-settings';

export function useSettingsForm() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [localModelStatus, setLocalModelStatus] = useState({ ready: false, progress: 0 });
  useTheme(settings.ui.theme);

  useEffect(() => {
    void loadSettings();
    void refreshLocalModelStatus();
  }, []);

  async function loadSettings() {
    const result = await chrome.storage.sync.get(SETTINGS_KEY);
    setSettings(mergeSettings(result[SETTINGS_KEY]));
  }

  async function refreshLocalModelStatus() {
    const ready = await hasLocalModel();
    setLocalModelStatus({ ready, progress: ready ? 1 : 0 });
  }

  async function saveSettings(next = settings) {
    await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  }

  async function resetSettings() {
    await chrome.storage.sync.remove(SETTINGS_KEY);
    setSettings(DEFAULT_SETTINGS);
  }

  function exportSettings() {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'chrome-ai-settings.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function importSettings(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async loadEvent => {
      try {
        const imported = JSON.parse(loadEvent.target?.result as string);
        const next = mergeSettings(imported);
        setSettings(next);
        await saveSettings(next);
      } catch {
        alert('Invalid settings file');
      }
    };
    reader.readAsText(file);
  }

  async function startModelDownload() {
    setLocalModelStatus({ ready: false, progress: 0 });
    try {
      await downloadLocalModel(progress => {
        setLocalModelStatus({ ready: false, progress });
      });
      setLocalModelStatus({ ready: true, progress: 1 });
      alert('Model downloaded successfully!');
    } catch (error) {
      setLocalModelStatus({ ready: false, progress: 0 });
      alert(`Download failed: ${error}`);
    }
  }

  return {
    settings,
    setSettings,
    saved,
    localModelStatus,
    saveSettings,
    resetSettings,
    exportSettings,
    importSettings,
    startModelDownload,
  };
}
