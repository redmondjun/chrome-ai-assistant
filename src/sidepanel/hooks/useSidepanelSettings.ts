import { useCallback, useEffect, useState } from 'react';
import { useTheme, type ThemePreference } from '@/shared/theme';
import type { ModelSettings, ResearchSettings, StorageSettings } from '@/shared/types';

const DEFAULT_MODEL: ModelSettings = {
  cloudModel: 'nemotron-3-nano',
  customEndpoint: '',
  apiKey: '',
  useLocal: true,
  autoRoute: true,
  forceCloudFor: ['generate code', 'write document', 'create report'],
};
const DEFAULT_RESEARCH: ResearchSettings = {
  workerConcurrency: 3,
  maxRelatedSourcesPerTask: 5,
  subjectBatchSize: 25,
  maxUniqueSourcesPerJob: 1000,
  cloudNoticeAccepted: false,
};

export function useSidepanelSettings() {
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [theme, setTheme] = useState<ThemePreference>('system');
  const [research, setResearch] = useState(DEFAULT_RESEARCH);
  const [localOnly, setLocalOnly] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [localModelReady, setLocalModelReady] = useState(false);
  useTheme(theme);

  useEffect(() => {
    void (async () => {
      const result = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      const saved = result?.settings as Partial<StorageSettings> | undefined;
      const nextModel = { ...DEFAULT_MODEL, ...saved?.model };

      setModel(nextModel);
      setTheme(saved?.ui?.theme || 'system');
      setResearch({ ...DEFAULT_RESEARCH, ...saved?.research });
      setLocalOnly(saved?.privacy?.localOnly || false);
      setLocalModelReady(await checkLocalModel());
      setIsLoaded(true);
    })();
  }, []);

  const updateModel = useCallback(
    async (change: Partial<ModelSettings>) => {
      const nextModel = { ...model, ...change };
      setModel(nextModel);
      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: { model: nextModel },
      });
    },
    [model]
  );

  const acceptCloudNotice = useCallback(async () => {
    const nextResearch = { ...research, cloudNoticeAccepted: true };
    setResearch(nextResearch);
    await chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      settings: { research: nextResearch },
    });
  }, [research]);

  return {
    model,
    research,
    localOnly,
    isLoaded,
    localModelReady,
    updateModel,
    acceptCloudNotice,
  };
}

function checkLocalModel(): Promise<boolean> {
  return new Promise(resolve => {
    const request = indexedDB.open('ChromeAIModels', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('models');
    request.onerror = () => resolve(false);
    request.onsuccess = () => {
      const modelRequest = request.result
        .transaction('models', 'readonly')
        .objectStore('models')
        .get('nemotron-mini-4b-q4_k_m.gguf');
      modelRequest.onsuccess = () => resolve(Boolean(modelRequest.result));
      modelRequest.onerror = () => resolve(false);
    };
  });
}
