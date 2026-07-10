import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('marked', () => ({ marked: { parse: (value: string) => `<p>${value}</p>` } }));

import App from './App';
import type { StorageSettings, TabContent } from '@/shared/types';

const page: TabContent = {
  url: 'https://example.com/article',
  title: 'Example article',
  text: 'This is the readable article body.',
  links: [],
  meta: {},
  timestamp: 1,
};

const savedSettings: StorageSettings = {
  model: {
    apiKey: 'nvapi-test',
    cloudModel: 'nemotron-3-nano',
    customEndpoint: '',
    useLocal: false,
    autoRoute: true,
    forceCloudFor: [],
  },
  links: {
    enabled: true,
    mode: 'ai-first',
    maxDepth: 2,
    maxPages: 10,
    rateLimitMs: 500,
    requireConfirmation: false,
    allowedDomains: [],
    blockedDomains: [],
  },
  ui: {
    theme: 'light',
    showReasoning: true,
    showLinks: true,
    streaming: true,
  },
  privacy: { localOnly: false, clearOnClose: false },
};

function mockMissingLocalModel() {
  (indexedDB.open as jest.Mock).mockImplementation(() => {
    const getRequest: any = {};
    const request: any = {
      result: {
        transaction: () => ({
          objectStore: () => ({
            get: () => {
              queueMicrotask(() => {
                getRequest.result = undefined;
                getRequest.onsuccess?.();
              });
              return getRequest;
            },
          }),
        }),
      },
    };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  });
}

describe('side panel App', () => {
  let runtimeListener: ((message: any) => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    runtimeListener = undefined;
    mockMissingLocalModel();
    (chrome.tabs.query as jest.Mock).mockResolvedValue([{ id: 42 }]);
    (chrome.runtime.onMessage.addListener as jest.Mock).mockImplementation(listener => {
      runtimeListener = listener;
    });
    (chrome.storage.sync.get as jest.Mock).mockResolvedValue({
      'chrome-ai-settings': savedSettings,
    });
    (chrome.runtime.sendMessage as jest.Mock).mockImplementation(async message => {
      if (message.type === 'GET_TAB_CONTENT') return { type: 'TAB_CONTENT', content: page };
      return { ok: true };
    });
  });

  it('shows API-key onboarding when neither cloud nor local AI is configured', async () => {
    (chrome.storage.sync.get as jest.Mock).mockResolvedValue({});

    render(<App />);

    expect(
      await screen.findByRole('heading', { name: /connect your ai assistant/i })
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/nvidia api key/i)).toBeInTheDocument();
  });

  it('loads page context, sends it with a message ID, and renders streamed output', async () => {
    render(<App />);

    expect(await screen.findByText('Example article')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: /ask about this page/i }), {
      target: { value: 'What is this about?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ASK_QUESTION',
          question: 'What is this about?',
          context: page,
          messageId: expect.any(String),
        })
      )
    );
    const ask = (chrome.runtime.sendMessage as jest.Mock).mock.calls
      .map(([message]) => message)
      .find(message => message.type === 'ASK_QUESTION');

    act(() =>
      runtimeListener?.({
        type: 'STREAM_CHUNK',
        messageId: ask.messageId,
        chunk: 'A concise answer.',
      })
    );
    act(() => runtimeListener?.({ type: 'STREAM_DONE', messageId: ask.messageId }));

    expect(screen.getByText('A concise answer.')).toBeInTheDocument();
    expect(screen.queryByText('Generating')).not.toBeInTheDocument();
  });

  it('shows a readable page error and retries successfully', async () => {
    (chrome.runtime.sendMessage as jest.Mock)
      .mockResolvedValueOnce({ error: 'Chrome does not allow extensions to read this page.' })
      .mockResolvedValueOnce({ type: 'TAB_CONTENT', content: page });

    render(<App />);

    expect(await screen.findByText('This page can’t be read')).toBeInTheDocument();
    expect(screen.getByText(/chrome does not allow extensions/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(await screen.findByText('Example article')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /ask about this page/i })).toBeEnabled();
  });
});
