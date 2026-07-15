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
    (chrome.storage.local.get as jest.Mock).mockResolvedValue({});
    (chrome.storage.local.set as jest.Mock).mockResolvedValue(undefined);
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
    await waitFor(() =>
      expect(chrome.storage.local.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'chrome-ai-chat-history:https://example.com/article': expect.arrayContaining([
            expect.objectContaining({ role: 'user', content: 'What is this about?' }),
            expect.objectContaining({ role: 'assistant', content: 'A concise answer.' }),
          ]),
        })
      )
    );

    fireEvent.change(screen.getByRole('textbox', { name: /ask about this page/i }), {
      target: { value: 'Can you expand on that?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => {
      const requests = (chrome.runtime.sendMessage as jest.Mock).mock.calls
        .map(([message]) => message)
        .filter(message => message.type === 'ASK_QUESTION');
      expect(requests).toHaveLength(2);
      expect(requests[1].history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'What is this about?' }),
          expect.objectContaining({ role: 'assistant', content: 'A concise answer.' }),
        ])
      );
    });
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

  it('restores the saved conversation for the current page', async () => {
    (chrome.storage.local.get as jest.Mock).mockResolvedValue({
      'chrome-ai-chat-history:https://example.com/article': [
        {
          id: 'previous-user',
          role: 'user',
          content: 'What changed?',
          timestamp: 1,
        },
        {
          id: 'previous-assistant',
          role: 'assistant',
          content: 'The link-following behavior changed.',
          timestamp: 2,
        },
      ],
    });

    render(<App />);

    expect(await screen.findByText('What changed?')).toBeInTheDocument();
    expect(screen.getByText('The link-following behavior changed.')).toBeInTheDocument();
  });
});
