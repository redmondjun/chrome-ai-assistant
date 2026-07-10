import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsForm } from './SettingsForm';

const storedSettings = {
  model: {
    apiKey: 'nvapi-test',
    cloudModel: 'nemotron-3-super',
    customEndpoint: '',
    useLocal: true,
    autoRoute: true,
    forceCloudFor: ['create report'],
  },
  links: {
    enabled: true,
    maxDepth: 2,
    maxPages: 10,
    rateLimitMs: 500,
    requireConfirmation: false,
    allowedDomains: '',
    blockedDomains: 'example.org',
  },
  ui: {
    theme: 'dark',
    showReasoning: false,
    showLinks: false,
    streaming: true,
  },
  privacy: { localOnly: false, clearOnClose: false },
};

function mockLocalModel(result?: Blob) {
  (indexedDB.open as jest.Mock).mockImplementation(() => {
    const modelRequest: any = {};
    const transaction: any = {
      objectStore: () => ({
        get: () => {
          queueMicrotask(() => {
            modelRequest.result = result;
            modelRequest.onsuccess?.();
            queueMicrotask(() => transaction.oncomplete?.());
          });
          return modelRequest;
        },
      }),
    };
    const openRequest: any = {
      result: { transaction: () => transaction },
    };
    queueMicrotask(() => openRequest.onsuccess?.());
    return openRequest;
  });
}

describe('SettingsForm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLocalModel();
    (chrome.storage.sync.get as jest.Mock).mockResolvedValue({
      'chrome-ai-settings': storedSettings,
    });
    (chrome.storage.sync.set as jest.Mock).mockResolvedValue(undefined);
    (chrome.storage.sync.remove as jest.Mock).mockResolvedValue(undefined);
  });

  it('loads the stored theme and preserves hidden detail preferences when saving', async () => {
    render(<SettingsForm />);

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'light' } });
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() =>
      expect(chrome.storage.sync.set).toHaveBeenCalledWith({
        'chrome-ai-settings': expect.objectContaining({
          ui: expect.objectContaining({
            theme: 'light',
            showReasoning: false,
            showLinks: false,
          }),
        }),
      })
    );
    expect(screen.getByRole('status')).toHaveTextContent('Settings saved.');
  });

  it('shows a contrast-safe local-model warning when no model is stored', async () => {
    render(<SettingsForm />);

    const warning = await screen.findByText(/local model not downloaded/i);
    const alert = warning.closest('.settings-alert-warning');
    expect(alert).not.toBeNull();
    expect(alert?.querySelector('button')).toHaveClass('bg-primary-600');
    expect(screen.queryByText(/local model is ready/i)).not.toBeInTheDocument();
  });

  it('resets stored settings and returns the theme to system', async () => {
    render(<SettingsForm />);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));

    fireEvent.click(screen.getByRole('button', { name: /reset to defaults/i }));

    await waitFor(() =>
      expect(chrome.storage.sync.remove).toHaveBeenCalledWith('chrome-ai-settings')
    );
    expect(screen.getByLabelText('Theme')).toHaveValue('system');
  });
});
