import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAccount } from '@/shared/useAccount';
import { AccountSyncSection } from './AccountSyncSection';

jest.mock('@/shared/useAccount', () => ({ useAccount: jest.fn() }));

const mockedUseAccount = useAccount as jest.MockedFunction<typeof useAccount>;

function accountHook(overrides: Record<string, unknown> = {}) {
  return {
    account: { configured: true, user: null },
    syncStatus: { state: 'idle' as const },
    isLoading: false,
    error: '',
    clearError: jest.fn(),
    signUp: jest.fn(),
    verifyEmail: jest.fn(),
    signIn: jest.fn(),
    signInWithGoogle: jest.fn(),
    requestRecovery: jest.fn(),
    verifyRecovery: jest.fn(),
    updatePassword: jest.fn(),
    signOut: jest.fn(),
    syncNow: jest.fn(),
    ...overrides,
  } as ReturnType<typeof useAccount>;
}

describe('AccountSyncSection', () => {
  it('explains when account support is not configured', () => {
    mockedUseAccount.mockReturnValue(accountHook({ account: { configured: false, user: null } }));
    render(<AccountSyncSection />);
    expect(screen.getByText(/supabase is not configured/i)).toBeInTheDocument();
  });

  it('submits email and password sign-in', async () => {
    const signIn = jest.fn().mockResolvedValue({ ok: true });
    mockedUseAccount.mockReturnValue(accountHook({ signIn }));
    render(<AccountSyncSection />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(signIn).toHaveBeenCalledWith('user@example.com', 'password123'));
  });

  it('shows account sync state and allows manual sync and sign-out', () => {
    const syncNow = jest.fn();
    const signOut = jest.fn();
    mockedUseAccount.mockReturnValue(
      accountHook({
        account: { configured: true, user: { id: 'user-1', email: 'user@example.com' } },
        syncStatus: { state: 'synced', lastSyncedAt: 1 },
        syncNow,
        signOut,
      })
    );
    render(<AccountSyncSection />);

    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(syncNow).toHaveBeenCalled();
    expect(signOut).toHaveBeenCalled();
  });
});
