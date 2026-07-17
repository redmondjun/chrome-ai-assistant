import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
jest.mock('marked', () => ({
  marked: {
    parse: (value: string) =>
      value === 'answer-link'
        ? '<p><a href="https://example.com/evidence">Open evidence</a></p>'
        : `<p>${value}</p>`,
  },
}));
import { AnswerDetails } from './AnswerDetails';
import { Composer } from './Composer';
import { Conversation } from './Conversation';
import { EmptyState } from './EmptyState';
import { MessageItem } from './MessageItem';
import { PageHeader } from './PageHeader';

describe('side panel UI', () => {
  it('offers useful prompts and sends the selected prompt', () => {
    const onPrompt = jest.fn();
    render(<EmptyState enabled onPrompt={onPrompt} />);
    fireEvent.click(screen.getByRole('button', { name: /summarize this page/i }));
    expect(onPrompt).toHaveBeenCalledWith('Summarize this page');
  });

  it('disables the composer and explains when a page is unavailable', () => {
    render(
      <Composer
        value="Question"
        onChange={jest.fn()}
        onSend={jest.fn()}
        pageReady={false}
        busy={false}
      />
    );
    expect(screen.getByText(/open a readable webpage/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: /send message/i })).toBeDisabled();
  });

  it('sends on Enter but keeps Shift+Enter for a new line', () => {
    const onSend = jest.fn();
    render(
      <Composer value="Question" onChange={jest.fn()} onSend={onSend} pageReady busy={false} />
    );
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('only shows answer details when metadata exists', () => {
    const { rerender } = render(<AnswerDetails />);
    expect(screen.queryByText('Reasoning')).not.toBeInTheDocument();
    rerender(
      <AnswerDetails
        reasoning={[
          { step: 1, type: 'answer', thought: 'Checking the page context', timestamp: 1 },
        ]}
      />
    );
    expect(screen.getByText('Reasoning')).toBeInTheDocument();
    expect(screen.getByText('Checking the page context')).toBeInTheDocument();
  });

  it('marks streaming and error assistant messages clearly', () => {
    const { rerender } = render(
      <MessageItem
        message={{ id: '1', role: 'assistant', content: '', timestamp: 1, isStreaming: true }}
      />
    );
    expect(screen.getByText('Generating')).toBeInTheDocument();
    rerender(
      <MessageItem
        message={{ id: '1', role: 'assistant', content: 'Error: request failed', timestamp: 1 }}
      />
    );
    expect(screen.getByText(/request failed/i)).toBeInTheDocument();
  });

  it('opens web links from generated answers in a browser tab', () => {
    render(
      <MessageItem
        message={{ id: '1', role: 'assistant', content: 'answer-link', timestamp: Date.now() }}
      />
    );

    fireEvent.click(screen.getByRole('link', { name: 'Open evidence' }));

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com/evidence',
      active: true,
    });
  });

  it('shows the current source-research progress while streaming', () => {
    render(
      <MessageItem
        message={{
          id: '1',
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          isStreaming: true,
          reasoning: [
            { step: 1, type: 'fetch', thought: 'Researching sources', timestamp: Date.now() },
            { step: 2, type: 'extract', thought: 'Reading source content', timestamp: Date.now() },
          ],
          linkVisits: [
            {
              url: 'https://example.com/finished',
              title: 'Finished source',
              status: 'fetching',
              relevanceScore: 0.9,
              timestamp: Date.now(),
            },
            {
              url: 'https://example.com/finished',
              title: 'Finished source',
              status: 'success',
              relevanceScore: 0.9,
              timestamp: Date.now(),
            },
            {
              url: 'https://example.com/current',
              title: 'Current source',
              status: 'fetching',
              relevanceScore: 0.8,
              timestamp: Date.now(),
            },
          ],
        }}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent('Opening Current source');
    expect(screen.getByRole('status')).toHaveTextContent('1 source read');
    expect(screen.getByRole('status')).toHaveTextContent('0s elapsed');
    expect(screen.getByText('Reasoning').closest('details')).toHaveAttribute('open');
    expect(screen.getByText('Sources visited').closest('details')).toHaveAttribute('open');
  });

  it('closes reasoning after the answer is generated', () => {
    const message = {
      id: '1',
      role: 'assistant' as const,
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      reasoning: [{ step: 1, type: 'classify' as const, thought: 'Analyzing', timestamp: 1 }],
    };
    const { rerender } = render(<MessageItem message={message} />);
    expect(screen.getByText('Reasoning').closest('details')).toHaveAttribute('open');

    rerender(<MessageItem message={{ ...message, content: 'Answer', isStreaming: false }} />);
    expect(screen.getByText('Reasoning').closest('details')).not.toHaveAttribute('open');
  });

  it('does not pull the reader back to the bottom while streaming updates arrive', () => {
    const firstMessage = { id: '1', role: 'assistant' as const, content: 'First', timestamp: 1 };
    const { container, rerender } = render(
      <Conversation messages={[firstMessage]} promptsEnabled onPrompt={jest.fn()} />
    );
    const conversation = container.querySelector('.conversation')!;
    Object.defineProperties(conversation, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 0 },
    });
    const scrollIntoView = Element.prototype.scrollIntoView as jest.Mock;
    const callsBeforeScroll = scrollIntoView.mock.calls.length;

    fireEvent.scroll(conversation);
    rerender(
      <Conversation
        messages={[{ ...firstMessage, content: 'First streamed update' }]}
        promptsEnabled
        onPrompt={jest.fn()}
      />
    );

    expect(scrollIntoView).toHaveBeenCalledTimes(callsBeforeScroll);
  });

  it('changes models, opens settings, and retries page errors', () => {
    const onModelChange = jest.fn();
    const onOpenSettings = jest.fn();
    const onRetry = jest.fn();
    render(
      <PageHeader
        page={null}
        isLoading={false}
        error="Page unavailable"
        model="nemotron-3-nano"
        conversations={[
          {
            id: 'chat-1',
            title: 'Current chat',
            messages: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
        activeConversationId="chat-1"
        onConversationChange={jest.fn()}
        onNewConversation={jest.fn()}
        conversationBusy={false}
        onModelChange={onModelChange}
        onOpenSettings={onOpenSettings}
        onRetry={onRetry}
      />
    );

    fireEvent.change(screen.getByLabelText(/ai model/i), { target: { value: 'nemotron-3-super' } });
    fireEvent.click(screen.getByRole('button', { name: /open settings/i }));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(onModelChange).toHaveBeenCalledWith('nemotron-3-super');
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
