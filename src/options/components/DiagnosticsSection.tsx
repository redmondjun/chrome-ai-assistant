import React, { useEffect, useMemo, useState } from 'react';
import { SettingsSection } from './FormControls';
import type { DiagnosticEvent, DiagnosticExport, DiagnosticStore } from '@/shared/types';

export function DiagnosticsSection() {
  const [store, setStore] = useState<DiagnosticStore>();
  const [exportData, setExportData] = useState<DiagnosticExport>();
  const [error, setError] = useState('');

  const refresh = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' });
      if (response?.error) throw new Error(response.error);
      setStore(response?.export?.store || response?.diagnostics);
      setExportData(response?.export);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  };

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(interval);
  }, []);

  const recentIssues = useMemo(
    () =>
      [...(store?.events || [])]
        .filter(event => event.level === 'warn' || event.level === 'error')
        .sort((left, right) => right.timestamp - left.timestamp)
        .slice(0, 20),
    [store]
  );
  const activeRuns = (store?.runs || []).filter(run =>
    ['accepted', 'running'].includes(run.status)
  );
  const stalledRuns = activeRuns.filter(run => run.health === 'stalled-suspected');

  const exportLog = () => {
    if (!exportData) return;
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `chrome-ai-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const clear = async () => {
    const response = await chrome.runtime.sendMessage({ type: 'CLEAR_DIAGNOSTICS' });
    if (response?.error) {
      setError(response.error);
      return;
    }
    await refresh();
  };

  return (
    <SettingsSection
      title="Diagnostics"
      description="Durable local agent activity and error logs. Retention: 7 days or 1,000 events. Diagnostics are never synced."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-4 text-sm">
          <span>{activeRuns.length} active runs</span>
          <span className={stalledRuns.length ? 'danger-text' : ''}>
            {stalledRuns.length} suspected stalled
          </span>
          <span>{store?.events.length || 0} stored events</span>
        </div>
        {error && <p className="danger-text">{error}</p>}
        <div className="flex flex-wrap gap-4">
          <button
            type="button"
            onClick={exportLog}
            disabled={!exportData}
            className="px-4 py-2 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50"
          >
            Export Diagnostic Log
          </button>
          <button
            type="button"
            onClick={() => void clear()}
            className="px-4 py-2 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-lg hover:bg-red-200 dark:hover:bg-red-900/50"
          >
            Clear Diagnostic History
          </button>
        </div>
        <div>
          <h3 className="font-semibold mb-2">Recent issues</h3>
          {recentIssues.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              No warnings or errors recorded.
            </p>
          ) : (
            <ul className="space-y-2 text-sm" aria-label="Recent diagnostic issues">
              {recentIssues.map(event => (
                <DiagnosticIssue key={event.id} event={event} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

function DiagnosticIssue({ event }: { event: DiagnosticEvent }) {
  return (
    <li className="p-3 rounded bg-gray-50 dark:bg-gray-800">
      <div className="flex flex-wrap gap-2">
        <time>{new Date(event.timestamp).toLocaleString()}</time>
        <strong>{event.component}</strong>
        <span>{event.event}</span>
        {event.operation && <span>{event.operation}</span>}
      </div>
      <div>{event.error?.message || 'No additional error message.'}</div>
      <small>Diagnostic ID: {event.id}</small>
      {event.attemptId && <small> · Attempt: {event.attemptId}</small>}
    </li>
  );
}
