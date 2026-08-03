import React, { useEffect, useState } from 'react';
import type { ChatMessage, LinkVisit } from '@/shared/types';

export function StreamingProgress({ message }: { message: ChatMessage }) {
  const [now, setNow] = useState(Date.now);
  const [lastActivityAt, setLastActivityAt] = useState(Date.now);

  useEffect(() => {
    setLastActivityAt(Date.now());
  }, [message.content, message.reasoning?.length, message.linkVisits?.length]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const visits = getLatestVisits(message.linkVisits ?? []);
  const activeVisit = visits.find(visit => visit.status === 'fetching');
  const successCount = visits.filter(visit => visit.status === 'success').length;
  const failedCount = visits.filter(visit => visit.status === 'failed').length;
  const elapsedSeconds = Math.max(0, Math.floor((now - message.timestamp) / 1000));
  const idleSeconds = Math.max(0, Math.floor((now - lastActivityAt) / 1000));
  const activity = getCurrentActivity(message, activeVisit);

  return (
    <div className="stream-progress" role="status" aria-live="polite">
      <div className="stream-progress-row">
        <span className="stream-progress-spinner" aria-hidden="true" />
        <strong>{activity}</strong>
      </div>
      <div className="stream-progress-meta">
        <span>{formatDuration(elapsedSeconds)} elapsed</span>
        {visits.length > 0 && (
          <span>
            {successCount} {successCount === 1 ? 'source' : 'sources'} read
          </span>
        )}
        {failedCount > 0 && <span className="danger-text">{failedCount} failed</span>}
      </div>
      {idleSeconds >= 30 && (
        <p className="stream-progress-warning">
          No progress update for {formatDuration(idleSeconds)}. This step may still be running; you
          can stop and retry if it does not continue.
        </p>
      )}
    </div>
  );
}

function getLatestVisits(visits: LinkVisit[]) {
  const latestByUrl = new Map<string, LinkVisit>();
  visits.forEach(visit => latestByUrl.set(visit.url, visit));
  return [...latestByUrl.values()];
}

function getCurrentActivity(message: ChatMessage, activeVisit?: LinkVisit) {
  if (activeVisit) return `Opening ${activeVisit.title || activeVisit.url}`;
  const latestStep = message.reasoning?.at(-1);
  if (latestStep?.type === 'classify') return 'Deciding which sources are needed';
  if (latestStep?.type === 'fetch') return 'Preparing source retrieval';
  if (latestStep?.type === 'extract') return 'Reading retrieved content';
  if (latestStep?.type === 'synthesize' || message.content) return 'Generating the answer';
  return 'Starting analysis';
}

function formatDuration(totalSeconds: number) {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}
