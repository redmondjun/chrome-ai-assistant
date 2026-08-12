import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DiagnosticsSection } from './DiagnosticsSection';
import type { DiagnosticExport, DiagnosticStore } from '@/shared/types';

describe('DiagnosticsSection', () => {
  const store: DiagnosticStore = {
    version: 1,
    runs: [
      {
        attemptId: 'attempt-1',
        kind: 'standard',
        messageId: 'message-1',
        status: 'running',
        health: 'stalled-suspected',
        activity: 'Waiting for model',
        startedAt: 1,
        lastHeartbeatAt: 2,
        startupId: 'startup-1',
      },
    ],
    events: [
      {
        id: 'diagnostic-1',
        timestamp: Date.now(),
        level: 'error',
        component: 'nim',
        event: 'request-failed',
        attemptId: 'attempt-1',
        error: { name: 'Error', message: 'The AI response timed out.' },
      },
    ],
  };
  const exported: DiagnosticExport = {
    schemaVersion: 1,
    exportedAt: Date.now(),
    extensionVersion: '1.0.0',
    userAgent: 'test',
    configuration: {},
    store,
  };

  beforeEach(() => {
    (chrome.runtime.sendMessage as jest.Mock).mockImplementation(async message => {
      if (message.type === 'CLEAR_DIAGNOSTICS') return { ok: true, diagnostics: store };
      return { diagnostics: store, export: exported };
    });
  });

  it('shows active and stalled summaries with recent errors', async () => {
    render(<DiagnosticsSection />);

    expect(await screen.findByText('1 active runs')).toBeInTheDocument();
    expect(screen.getByText('1 suspected stalled')).toBeInTheDocument();
    expect(screen.getByText('The AI response timed out.')).toBeInTheDocument();
    expect(screen.getByText(/Diagnostic ID: diagnostic-1/)).toBeInTheDocument();
  });

  it('clears local diagnostic history', async () => {
    render(<DiagnosticsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear Diagnostic History' }));

    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'CLEAR_DIAGNOSTICS' })
    );
  });
});
