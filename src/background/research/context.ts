import type {
  ResearchConversationContext,
  ResearchJob,
  ResearchSourceRecord,
  ResearchTask,
} from '@/shared/types';

const PARTIAL_CONTENT_LIMIT = 20000;

export function createPartialResearchAnswer(
  job: ResearchJob,
  error = job.error
): string | undefined {
  const findings = collectCompactFindings(job);
  if (findings.length === 0) return undefined;

  const successfulSources = (job.sourceRegistry || []).filter(
    source => source.status === 'success' && source.evidence
  ).length;
  const failedSources = (job.sourceRegistry || []).filter(
    source => source.status === 'failed'
  ).length;
  const completedSubjects = job.tasks.filter(task => task.status === 'completed').length;
  const header = [
    'Partial Deep Research result',
    '',
    `Completed subjects: ${completedSubjects}/${job.tasks.length}`,
    `Validated readable sources: ${successfulSources}`,
    `Failed or inaccessible sources: ${failedSources}`,
    error ? `Research stopped: ${error}` : '',
    '',
    'Findings collected before the research stopped:',
  ]
    .filter(Boolean)
    .join('\n');

  return `${header}\n\n${fitFindings(findings, PARTIAL_CONTENT_LIMIT - header.length)}`;
}

export function buildResearchConversationContext(
  job: ResearchJob
): ResearchConversationContext | undefined {
  const summary = job.finalAnswer || job.partialAnswer || createPartialResearchAnswer(job);
  if (!summary) return undefined;
  const registry = job.sourceRegistry || [];
  return {
    jobId: job.id,
    originalQuestion: job.question,
    status: job.status,
    completedSubjects: job.tasks.filter(task => task.status === 'completed').length,
    totalSubjects: job.tasks.length,
    successfulSources: registry.filter(source => source.status === 'success' && source.evidence)
      .length,
    failedSources: registry.filter(source => source.status === 'failed').length,
    summary: summary.slice(0, PARTIAL_CONTENT_LIMIT),
    partial: !job.finalAnswer,
    error: job.error,
  };
}

function collectCompactFindings(job: ResearchJob): string[] {
  const finalSummaries = (job.batchSummaries || [])
    .filter(summary => summary.kind === 'final' && summary.summary)
    .map(summary => `Final batch ${summary.batchIndex + 1}\n${summary.summary}`);
  if (finalSummaries.length > 0) return finalSummaries;

  const reports = job.tasks
    .filter(hasReport)
    .map(task => `${task.label}\nSource: ${task.sourceUrl}\n${task.report}`);
  if (reports.length > 0) return reports;

  const assessments = job.tasks
    .filter(hasSeedAssessment)
    .map(task => `${task.label}\nSource: ${task.sourceUrl}\n${task.seedAssessment.summary}`);
  if (assessments.length > 0) return assessments;

  return (job.sourceRegistry || [])
    .filter(hasEvidence)
    .map(source => `${source.title}\nSource: ${source.evidence.url}\n${source.evidence.excerpt}`);
}

function fitFindings(findings: string[], limit: number): string {
  const separator = '\n\n---\n\n';
  const contentBudget = Math.max(0, limit - separator.length * Math.max(0, findings.length - 1));
  const itemLimit = Math.max(1, Math.floor(contentBudget / findings.length));
  return findings.map(finding => finding.slice(0, itemLimit)).join(separator);
}

function hasReport(task: ResearchTask): task is ResearchTask & { report: string } {
  return typeof task.report === 'string' && task.report.length > 0;
}

function hasSeedAssessment(
  task: ResearchTask
): task is ResearchTask & { seedAssessment: NonNullable<ResearchTask['seedAssessment']> } {
  return task.seedAssessment !== undefined;
}

function hasEvidence(
  source: ResearchSourceRecord
): source is ResearchSourceRecord & { evidence: NonNullable<ResearchSourceRecord['evidence']> } {
  return source.status === 'success' && source.evidence !== undefined;
}
