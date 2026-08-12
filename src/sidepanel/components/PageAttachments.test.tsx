import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PageAttachments } from './PageAttachments';
import type { SavedPage, TabContent } from '@/shared/types';

const savedPage: SavedPage = {
  id: 'saved-1',
  url: 'https://wiki.example.com/promotion-plan',
  title: 'Promotion plan',
  text: 'Stored qualification snapshot',
  links: [],
  capturedAt: 1,
};

async function renderAttachments(
  overrides: Partial<React.ComponentProps<typeof PageAttachments>> = {}
) {
  const props: React.ComponentProps<typeof PageAttachments> = {
    pages: [savedPage],
    selectedIds: [savedPage.id],
    disabled: false,
    onAdd: jest.fn(),
    onSelect: jest.fn(),
    onRemove: jest.fn(),
    onRefresh: jest.fn(),
    onRefreshWarning: jest.fn(),
    ...overrides,
  };
  render(<PageAttachments {...props} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /attach pages/i }));
    await Promise.resolve();
  });
  return props;
}

describe('PageAttachments', () => {
  beforeEach(() => jest.clearAllMocks());

  it('closes the attachment panel from inside the panel', async () => {
    (chrome.tabs.query as jest.Mock).mockResolvedValue([]);
    await renderAttachments();
    expect(screen.getByLabelText('Attach pages')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close attach pages' }));

    expect(screen.queryByLabelText('Attach pages')).not.toBeInTheDocument();
  });

  it('adds readable open tabs to the saved page library', async () => {
    const tabContent: TabContent = {
      url: 'https://wiki.example.com/tickets',
      title: 'Ticket tracking',
      text: 'SQ-1',
      links: [],
      meta: {},
      timestamp: 2,
    };
    (chrome.tabs.query as jest.Mock).mockResolvedValue([
      { id: 1, active: true, title: 'Current', url: 'https://example.com' },
      { id: 2, active: false, title: tabContent.title, url: tabContent.url },
    ]);
    (chrome.runtime.sendMessage as jest.Mock).mockResolvedValue({
      type: 'TAB_CONTENT',
      content: tabContent,
    });
    const props = await renderAttachments({ pages: [], selectedIds: [] });

    fireEvent.click(await screen.findByRole('button', { name: tabContent.title }));
    await waitFor(() => expect(props.onAdd).toHaveBeenCalledWith(tabContent));
  });

  it('keeps the stored snapshot when manual refresh fails', async () => {
    (chrome.tabs.query as jest.Mock).mockResolvedValue([]);
    (chrome.runtime.sendMessage as jest.Mock).mockResolvedValue({ error: 'VPN required' });
    const props = await renderAttachments();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(props.onRefreshWarning).toHaveBeenCalledWith(
        savedPage.id,
        'Refresh failed: VPN required'
      )
    );
    expect(props.onRefresh).not.toHaveBeenCalled();
    expect(screen.getByText('Refresh failed: VPN required')).toBeInTheDocument();
  });

  it('detaches a page without deleting it and exposes a separate delete action', async () => {
    (chrome.tabs.query as jest.Mock).mockResolvedValue([]);
    const props = await renderAttachments();

    fireEvent.click(screen.getByRole('checkbox', { name: savedPage.title }));
    expect(props.onSelect).toHaveBeenCalledWith(savedPage.id, false);
    expect(props.onRemove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(props.onRemove).toHaveBeenCalledWith(savedPage.id);
  });
});
