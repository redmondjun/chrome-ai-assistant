import React, { useState } from 'react';
import { useAccount } from '@/shared/useAccount';
import { CONTROL_CLASS, Field, SettingsSection } from './FormControls';

type Mode = 'sign-in' | 'sign-up' | 'verify' | 'recover' | 'recovery-code' | 'new-password';

export function AccountSyncSection() {
  const auth = useAccount();
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [notice, setNotice] = useState('');

  if (!auth.account.configured) {
    return (
      <SettingsSection
        title="Account and sync"
        description="Sign in to keep chats and preferences synchronized across devices."
      >
        <div className="settings-alert settings-alert-warning rounded-lg p-3" role="status">
          Supabase is not configured for this build. Add the documented build variables to enable
          accounts.
        </div>
      </SettingsSection>
    );
  }

  if (auth.account.user) {
    return (
      <SettingsSection
        title="Account and sync"
        description="Your chats and non-secret preferences sync while this account is signed in."
      >
        <div className="account-summary">
          <div>
            <strong>{auth.account.user.email}</strong>
            <p>{syncDescription(auth.syncStatus)}</p>
          </div>
          <span className={`sync-badge sync-${auth.syncStatus.state}`}>
            {auth.syncStatus.state}
          </span>
        </div>
        {auth.error && <AuthError message={auth.error} />}
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={auth.isLoading}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg"
            onClick={() => void auth.syncNow()}
          >
            Sync now
          </button>
          <button
            type="button"
            disabled={auth.isLoading}
            className="px-4 py-2 bg-gray-100 dark:bg-gray-700 rounded-lg"
            onClick={() => void auth.signOut()}
          >
            Sign out
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Your NVIDIA API key, local model, and local-only preference stay on this device.
        </p>
      </SettingsSection>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setNotice('');
    try {
      if (mode === 'sign-in') await auth.signIn(email, password);
      if (mode === 'sign-up') {
        const result = await auth.signUp(email, password);
        if (result?.needsVerification) {
          setMode('verify');
          setNotice('Enter the 6-digit code sent to your email.');
        }
      }
      if (mode === 'verify') await auth.verifyEmail(email, token);
      if (mode === 'recover') {
        await auth.requestRecovery(email);
        setMode('recovery-code');
        setNotice('Enter the recovery code sent to your email.');
      }
      if (mode === 'recovery-code') {
        await auth.verifyRecovery(email, token);
        setMode('new-password');
      }
      if (mode === 'new-password') {
        await auth.updatePassword(password);
        setMode('sign-in');
        setNotice('Password updated. You can now sign in.');
      }
    } catch {
      // useAccount exposes the readable error.
    }
  };

  const showPassword = mode === 'sign-in' || mode === 'sign-up' || mode === 'new-password';
  const showToken = mode === 'verify' || mode === 'recovery-code';

  return (
    <SettingsSection
      title="Account and sync"
      description="Sign in to keep chats and non-secret preferences synchronized across devices."
    >
      <form className="space-y-4" onSubmit={submit}>
        {mode !== 'new-password' && (
          <Field id="account-email" label="Email">
            <input
              id="account-email"
              type="email"
              required
              autoComplete="email"
              className={CONTROL_CLASS}
              value={email}
              onChange={event => setEmail(event.target.value)}
            />
          </Field>
        )}
        {showPassword && (
          <Field
            id="account-password"
            label={mode === 'new-password' ? 'New password' : 'Password'}
          >
            <input
              id="account-password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              className={CONTROL_CLASS}
              value={password}
              onChange={event => setPassword(event.target.value)}
            />
          </Field>
        )}
        {showToken && (
          <Field id="account-code" label="6-digit code">
            <input
              id="account-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              required
              className={CONTROL_CLASS}
              value={token}
              onChange={event => setToken(event.target.value)}
            />
          </Field>
        )}
        {notice && (
          <div className="settings-alert settings-alert-success rounded-lg p-3">{notice}</div>
        )}
        {auth.error && <AuthError message={auth.error} />}
        <button
          type="submit"
          disabled={auth.isLoading}
          className="w-full px-4 py-2 bg-primary-600 text-white rounded-lg"
        >
          {submitLabel(mode)}
        </button>
      </form>

      {(mode === 'sign-in' || mode === 'sign-up') && (
        <>
          <div className="auth-divider">
            <span>or</span>
          </div>
          <button
            type="button"
            disabled={auth.isLoading}
            className="w-full px-4 py-2 bg-gray-100 dark:bg-gray-700 rounded-lg"
            onClick={() => void auth.signInWithGoogle().catch(() => undefined)}
          >
            Continue with Google
          </button>
          <div className="auth-links">
            <button
              type="button"
              onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}
            >
              {mode === 'sign-in' ? 'Create account' : 'Already have an account?'}
            </button>
            {mode === 'sign-in' && (
              <button type="button" onClick={() => setMode('recover')}>
                Forgot password?
              </button>
            )}
          </div>
        </>
      )}
    </SettingsSection>
  );
}

function AuthError({ message }: { message: string }) {
  return (
    <div className="settings-alert settings-alert-warning rounded-lg p-3" role="alert">
      {message}
    </div>
  );
}

function submitLabel(mode: Mode) {
  return {
    'sign-in': 'Sign in',
    'sign-up': 'Create account',
    verify: 'Verify email',
    recover: 'Send recovery code',
    'recovery-code': 'Verify recovery code',
    'new-password': 'Update password',
  }[mode];
}

function syncDescription(status: ReturnType<typeof useAccount>['syncStatus']) {
  if (status.state === 'paused') return 'Sync paused by local-only mode.';
  if (status.state === 'error') return status.error || 'Sync needs attention.';
  if (status.lastSyncedAt) return `Last synced ${new Date(status.lastSyncedAt).toLocaleString()}`;
  return 'Ready to sync.';
}
