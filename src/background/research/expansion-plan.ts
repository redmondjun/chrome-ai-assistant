import { canonicalizeUrl } from './link-policy';
import type { ResearchExpansionItem, ResearchJob, StorageSettings } from '@/shared/types';

export function buildExpansionPlan(job: ResearchJob, settings: StorageSettings) {
  if ((job.expansionPlan?.length || 0) > 0) return;
  const candidates = job.tasks
    .filter(task => task.seedStatus === 'completed' && task.seedAssessment?.expansionNeeded)
    .flatMap(task =>
      task.pendingSources.map(source => ({
        task,
        source,
        priority:
          (source.score || 0) * (0.5 + (task.seedAssessment?.relevance || 0.5) / 2) +
          Math.min(0.1, (task.seedAssessment?.evidenceGaps.length || 0) * 0.02),
      }))
    )
    .sort((left, right) => right.priority - left.priority);
  const plan: ResearchExpansionItem[] = [];
  const plannedKeys = new Set((job.sourceRegistry || []).map(source => source.key));
  const perTask = new Map<string, number>();
  let uniqueSources = plannedKeys.size;
  const sourceBudget = job.sourceBudget || settings.research.maxUniqueSourcesPerJob;

  candidates.forEach(candidate => {
    const count = perTask.get(candidate.task.id) || 0;
    const key = canonicalizeUrl(candidate.source.url);
    let reason: string | undefined;
    if (count >= settings.research.maxRelatedSourcesPerTask) reason = 'per-subject-source-budget';
    else if (!plannedKeys.has(key) && uniqueSources >= sourceBudget)
      reason = 'global-source-budget';
    if (reason) {
      candidate.task.decisions.push({
        ...candidate.source,
        outcome: 'skipped',
        reason,
        timestamp: Date.now(),
      });
      return;
    }
    plan.push({
      taskId: candidate.task.id,
      source: { ...candidate.source, score: candidate.source.score || 0 },
      priority: candidate.priority,
      status: 'planned',
    });
    perTask.set(candidate.task.id, count + 1);
    candidate.task.expansionStatus = 'planned';
    if (!plannedKeys.has(key)) {
      plannedKeys.add(key);
      uniqueSources++;
    }
  });
  job.tasks.forEach(task => {
    if (task.seedStatus === 'completed' && task.expansionStatus !== 'planned') {
      task.expansionStatus = 'skipped';
    }
  });
  job.expansionPlan = plan;
}
