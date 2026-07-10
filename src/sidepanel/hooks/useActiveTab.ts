import { useCallback, useEffect, useState } from 'react';
import type { TabContent } from '@/shared/types';

export function useActiveTab() {
  const [content, setContent] = useState<TabContent | null>(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab was found.');

      const response = await chrome.runtime.sendMessage({
        type: 'GET_TAB_CONTENT',
        tabId: tab.id,
      });
      if (response?.type !== 'TAB_CONTENT') {
        throw new Error(response?.error || 'The active page did not return readable content.');
      }
      setContent(response.content);
    } catch (loadError) {
      setContent(null);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const handleActivated = () => void load();
    const handleUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab
    ) => {
      if (tab.active && changeInfo.status === 'complete') void load();
    };

    chrome.tabs.onActivated.addListener(handleActivated);
    chrome.tabs.onUpdated.addListener(handleUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(handleActivated);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
    };
  }, [load]);

  return { content, error, isLoading, reload: load };
}
