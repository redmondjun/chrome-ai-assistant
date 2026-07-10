import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
jest.mock('marked', () => ({ marked: { parse: (value: string) => `<p>${value}</p>` } }));
import { AnswerDetails } from './AnswerDetails';
import { Composer } from './Composer';
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
    expect(screen.queryByText('Details')).not.toBeInTheDocument();
    rerender(
      <AnswerDetails
        reasoning={[
          { step: 1, type: 'answer', thought: 'Checking the page context', timestamp: 1 },
        ]}
      />
    );
    expect(screen.getByText('Details')).toBeInTheDocument();
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
