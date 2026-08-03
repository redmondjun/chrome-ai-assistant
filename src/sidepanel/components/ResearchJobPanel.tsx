import React, { useEffect, useState } from 'react';
import { handleAnswerLinkClick } from './message-links';
import type { ResearchJob, ResearchProgress, ResearchTask } from '@/shared/types';

type ResearchAction = 'PAUSE_RESEARCH' | 'RESUME_RESEARCH' | 'RETRY_RESEARCH' | 'CANCEL_RESEARCH';

export function ResearchJobPanel({ progress }: { progress: ResearchProgress }) {
  const [job, setJob] = useState<ResearchJob>();
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let active = true;
    void Promise.resolve(
      chrome.runtime.sendMessage({ type: 'GET_RESEARCH_JOB', jobId: progress.jobId })
    ).then(response => {
      if (active) setJob(response?.job);
    });
    return () => {
      active = false;
    };
  }, [progress.jobId, progress.updatedAt]);

  useEffect(() => {
    const handleTaskUpdate = (message: { type?: string; jobId?: string; task?: ResearchTask }) => {
      if (
        message.type !== 'RESEARCH_TASK_UPDATE' ||
        message.jobId !== progress.jobId ||
        !message.task
      )
        return;
      setJob(current =>
        current
          ? {
              ...current,
              tasks: current.tasks.map(task =>
                task.id === message.task?.id ? message.task : task
              ),
            }
          : current
      );
    };
    chrome.runtime.onMessage.addListener(handleTaskUpdate);
    return () => chrome.runtime.onMessage.removeListener(handleTaskUpdate);
  }, [progress.jobId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const sendAction = (type: ResearchAction) =>
    void chrome.runtime.sendMessage({ type, jobId: progress.jobId });

  return (
    <section
      className="research-job"
      aria-label="Deep Research progress"
      onClick={handleAnswerLinkClick}
    >
      <div className="research-job-heading">
        <strong>{progressLabel(progress)}</strong>
        <span>{progress.status}</span>
      </div>
      <p>{progress.activity}</p>
      <progress value={progress.completedTasks + progress.failedTasks} max={progress.totalTasks} />
      <div className="stream-progress-meta">
        <span>
          {progress.completedTasks}/{progress.totalTasks} subjects
        </span>
        <span>{progress.activeWorkers} workers active</span>
        <span>{progress.seedsScanned ?? 0} seeds scanned</span>
        <span>{progress.subjectsExpanded ?? 0} subjects expanded</span>
        <span>{progress.uniqueSourcesSucceeded ?? progress.sourcesRead} unique sources read</span>
        {(progress.uniqueSourcesFailed ?? progress.sourcesFailed) > 0 && (
          <span className="danger-text">
            {progress.uniqueSourcesFailed ?? progress.sourcesFailed} source failures
          </span>
        )}
        {(progress.sourceCacheHits ?? 0) > 0 && <span>{progress.sourceCacheHits} cache hits</span>}
        {(progress.sourceRetries ?? 0) > 0 && <span>{progress.sourceRetries} retries</span>}
        <span>
          {progress.sourceBudgetUsed ?? 0}/{progress.sourceBudgetTotal ?? 0} source budget
        </span>
        {(progress.sourceBudgetOverflow ?? 0) > 0 && (
          <span className="danger-text">
            {progress.sourceBudgetOverflow} legacy sources above the current budget
          </span>
        )}
        {progress.failedTasks > 0 && (
          <span className="danger-text">{progress.failedTasks} failed</span>
        )}
      </div>
      <div className="research-job-actions">
        {progress.status === 'running' && (
          <Action label="Pause" onClick={() => sendAction('PAUSE_RESEARCH')} />
        )}
        {progress.status === 'paused' && (
          <Action label="Resume" onClick={() => sendAction('RESUME_RESEARCH')} />
        )}
        {progress.failedTasks > 0 && ['completed', 'failed'].includes(progress.status) && (
          <Action label="Retry failed" onClick={() => sendAction('RETRY_RESEARCH')} />
        )}
        {!['completed', 'cancelled'].includes(progress.status) && (
          <Action label="Cancel" onClick={() => sendAction('CANCEL_RESEARCH')} />
        )}
      </div>
      {job && <WorkerList tasks={job.tasks} now={now} />}
    </section>
  );
}

function Action({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}>
      {label}
    </button>
  );
}

function WorkerList({ tasks, now }: { tasks: ResearchTask[]; now: number }) {
  return (
    <div className="research-workers" aria-label="Research workers">
      {tasks.map(task => (
        <WorkerDetails key={task.id} task={task} now={now} />
      ))}
    </div>
  );
}

function WorkerDetails({ task, now }: { task: ResearchTask; now: number }) {
  const elapsed = formatDuration(Math.max(0, Math.floor((now - task.phaseStartedAt) / 1000)));
  const idleSeconds = Math.max(0, Math.floor((now - task.lastActivityAt) / 1000));
  return (
    <details className="research-worker">
      <summary>
        <span>
          <strong>{task.label}</strong>
          <small>
            {phaseLabel(task)} · {elapsed}
          </small>
        </span>
        <span>
          {task.sourceKeys?.length ?? task.evidence.length} associated ·{' '}
          {task.pendingSources.length} candidates
        </span>
      </summary>
      {idleSeconds >= 30 && task.status === 'running' && (
        <p className="stream-progress-warning">
          No worker update for {formatDuration(idleSeconds)}. The current page or model operation
          may still be running.
        </p>
      )}
      {task.currentSource && (
        <p>
          Current source: <a href={task.currentSource.url}>{task.currentSource.title}</a> · depth{' '}
          {task.currentSource.depth}
        </p>
      )}
      <p>
        {task.relatedSourcesAttempted} related sources attempted · {task.relatedSourcesRead} read
      </p>
      <p>
        Seed: {task.seedStatus || 'queued'} · Expansion: {task.expansionStatus || 'waiting'}
      </p>
      {task.error && <p className="danger-text">{task.error}</p>}
      <WorkerReasoning task={task} />
      <WorkerSources task={task} />
      {task.report && (
        <details>
          <summary>Worker report</summary>
          <pre>{task.report}</pre>
        </details>
      )}
    </details>
  );
}

function WorkerReasoning({ task }: { task: ResearchTask }) {
  return (
    <details>
      <summary>Reasoning ({task.reasoning.length})</summary>
      <ol>
        {task.reasoning.map((step, index) => (
          <li key={`${step.timestamp}-${index}`}>{step.thought}</li>
        ))}
      </ol>
    </details>
  );
}

function WorkerSources({ task }: { task: ResearchTask }) {
  return (
    <details>
      <summary>
        Sources and decisions ({task.linkVisits.length}/{task.decisions.length})
      </summary>
      <ul>
        {task.linkVisits.map((visit, index) => (
          <li key={`${visit.url}-${index}`}>
            {visit.status}: <a href={visit.url}>{visit.title}</a> ·{' '}
            {Math.round(visit.relevanceScore * 100)}%{visit.error ? ` — ${visit.error}` : ''}
          </li>
        ))}
      </ul>
      <ul>
        {task.decisions.map((decision, index) => (
          <li key={`${decision.url}-${index}`}>
            {decision.outcome}: <a href={decision.url}>{decision.title}</a> — {decision.reason}
            {decision.score === undefined ? '' : ` (${Math.round(decision.score * 100)}%)`}
          </li>
        ))}
      </ul>
    </details>
  );
}

function phaseLabel(task: ResearchTask) {
  if (task.seedStatus === 'running') return 'scanning seed';
  if (task.seedStatus === 'completed' && task.expansionStatus === 'waiting')
    return 'waiting for expansion plan';
  if (task.expansionStatus === 'running') return 'expanding evidence';
  if (task.status === 'completed') return 'included in completed batch';
  if (task.phase === 'opening') return 'waiting for page';
  if (task.phase === 'scoring') return 'waiting for AI scoring';
  if (task.phase === 'analyzing') return 'waiting for AI analysis';
  if (task.phase === 'reading') return 'reading page';
  return task.phase;
}

function progressLabel(progress: ResearchProgress) {
  const stage = progress.stage ? stageLabel(progress.stage) : progress.activity;
  if (
    progress.currentBatch &&
    progress.totalBatches &&
    ['seed-scan', 'expansion', 'batch-synthesis'].includes(progress.stage || '')
  ) {
    return `${stage} · batch ${progress.currentBatch} of ${progress.totalBatches}`;
  }
  return stage || progress.activity;
}

function stageLabel(stage: NonNullable<ResearchProgress['stage']>) {
  if (stage === 'seed-scan') return 'Seed scan';
  if (stage === 'expansion-planning') return 'Planning expansion';
  if (stage === 'expansion') return 'Selective expansion';
  if (stage === 'batch-synthesis') return 'Batch synthesis';
  if (stage === 'final-synthesis') return 'Final synthesis';
  return 'Research complete';
}

function formatDuration(totalSeconds: number) {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}
