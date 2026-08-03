import { useCallback, useEffect, useState } from 'react';
import type { AccountState, SyncStatus } from './types';
import { EMPTY_ACCOUNT_STATE, SYNC_STATUS_KEY } from './storage';

export function useAccount() {
  const [account, setAccount] = useState<AccountState>(EMPTY_ACCOUNT_STATE);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ state: 'idle' });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void Promise.all([
      chrome.runtime.sendMessage({ type: 'AUTH_GET_STATE' }),
      chrome.storage.local.get(SYNC_STATUS_KEY),
    ]).then(([response, stored]) => {
      if (!active) return;
      if (response?.account) setAccount(response.account);
      if (stored?.[SYNC_STATUS_KEY]) setSyncStatus(stored[SYNC_STATUS_KEY]);
      setIsLoading(false);
    });

    const listener = (message: any) => {
      if (message.type === 'ACCOUNT_STATE_CHANGED') setAccount(message.account);
      if (message.type === 'SYNC_STATUS_CHANGED') setSyncStatus(message.status);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      active = false;
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);

  const run = useCallback(async (message: Record<string, unknown>) => {
    setIsLoading(true);
    setError('');
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (response?.error) throw new Error(cleanError(response.error));
      return response;
    } catch (runError) {
      const text = runError instanceof Error ? runError.message : String(runError);
      setError(cleanError(text));
      throw runError;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return {
    account,
    syncStatus,
    isLoading,
    error,
    clearError: () => setError(''),
    signUp: (email: string, password: string) => run({ type: 'AUTH_SIGN_UP', email, password }),
    verifyEmail: (email: string, token: string) => run({ type: 'AUTH_VERIFY_EMAIL', email, token }),
    signIn: (email: string, password: string) => run({ type: 'AUTH_SIGN_IN', email, password }),
    signInWithGoogle: () => run({ type: 'AUTH_SIGN_IN_GOOGLE' }),
    requestRecovery: (email: string) => run({ type: 'AUTH_REQUEST_RECOVERY', email }),
    verifyRecovery: (email: string, token: string) =>
      run({ type: 'AUTH_VERIFY_RECOVERY', email, token }),
    updatePassword: (password: string) => run({ type: 'AUTH_UPDATE_PASSWORD', password }),
    signOut: () => run({ type: 'AUTH_SIGN_OUT' }),
    syncNow: () => run({ type: 'SYNC_PULL' }),
  };
}

function cleanError(error: string) {
  return error.replace(/^Error:\s*/, '');
}
