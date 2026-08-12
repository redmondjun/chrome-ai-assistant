import type {
  ResearchConversationContext,
  ResearchJob,
  ResearchJobConversationContext,
  ResearchJobConversationMetadata,
  ResearchSourceRecord,
  ResearchTask,
} from '@/shared/types';

const PARTIAL_CONTENT_LIMIT = 20000;
const CONVERSATION_RESEARCH_LIMIT = 40000;

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
  const totalSubjects = job.tasks.filter(task => task.status !== 'skipped').length;
  const header = [
    'Partial Deep Research result',
    '',
    `Completed subjects: ${completedSubjects}/${totalSubjects}`,
    `Validated readable sources: ${successfulSources}`,
    `Failed or inaccessible sources: ${failedSources}`,
    ...(job.contextWarnings || []).map(warning => `Saved page warning: ${warning}`),
    error ? `Research stopped: ${error}` : '',
    '',
    'Validated evidence was retained in this research job and will be reused when the job is retried or the conversation continues.',
  ]
    .filter(Boolean)
    .join('\n');

  return header;
}

export function buildResearchConversationContext(
  job: ResearchJob
): ResearchJobConversationContext | undefined {
  const partial = job.partialAnswer;
  const summary =
    job.finalAnswer ||
    (partial && !partial.startsWith('Partial Deep Research result')
      ? partial
      : fitFindings(collectCompactFindings(job), PARTIAL_CONTENT_LIMIT));
  if (!summary) return undefined;
  const registry = job.sourceRegistry || [];
  return {
    jobId: job.id,
    originalQuestion: job.question,
    status: job.status,
    completedSubjects: job.tasks.filter(task => task.status === 'completed').length,
    totalSubjects: job.tasks.filter(task => task.status !== 'skipped').length,
    successfulSources: registry.filter(source => source.status === 'success' && source.evidence)
      .length,
    failedSources: registry.filter(source => source.status === 'failed').length,
    summary: summary.slice(0, PARTIAL_CONTENT_LIMIT),
    partial: !job.finalAnswer,
    createdAt: job.createdAt,
    error: job.error,
  };
}

export function buildConversationResearchContext(
  jobs: ResearchJob[]
): ResearchConversationContext | undefined {
  const contexts = jobs
    .map(buildResearchConversationContext)
    .filter(context => context !== undefined);
  if (contexts.length === 0) return undefined;

  const ranked = [...contexts].sort(compareResearchContext);
  const newest = [...contexts].sort((left, right) => right.createdAt - left.createdAt)[0];
  const ordered = [
    ranked[0],
    ...(newest.jobId === ranked[0].jobId ? [] : [newest]),
    ...ranked,
  ].filter(
    (context, index, all) => all.findIndex(candidate => candidate.jobId === context.jobId) === index
  );
  const included: ResearchJobConversationContext[] = [];
  const omitted: ResearchJobConversationMetadata[] = [];
  let remaining = CONVERSATION_RESEARCH_LIMIT;
  ordered.forEach(context => {
    if (remaining <= 0) {
      omitted.push(toMetadata(context));
      return;
    }
    const summary = context.summary.slice(0, remaining);
    included.push({ ...context, summary });
    remaining -= summary.length;
  });
  return { jobs: included, omittedJobs: omitted };
}

function compareResearchContext(
  left: ResearchJobConversationContext,
  right: ResearchJobConversationContext
) {
  return (
    right.successfulSources - left.successfulSources ||
    right.completedSubjects - left.completedSubjects ||
    Number(left.partial) - Number(right.partial) ||
    right.createdAt - left.createdAt
  );
}

function toMetadata(context: ResearchJobConversationContext) {
  return {
    jobId: context.jobId,
    originalQuestion: context.originalQuestion,
    status: context.status,
    completedSubjects: context.completedSubjects,
    totalSubjects: context.totalSubjects,
    successfulSources: context.successfulSources,
    failedSources: context.failedSources,
    partial: context.partial,
    createdAt: context.createdAt,
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
