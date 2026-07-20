import type { ModelRouter } from '../api/router';
import type { ResearchJob } from '@/shared/types';

const REPORT_BATCH_SIZE = 20;
type ResearchRouter = Pick<ModelRouter, 'complete'>;

export async function synthesizeResearch(
  router: ResearchRouter,
  job: ResearchJob,
  signal: AbortSignal
) {
  const reports = job.tasks
    .filter(task => task.report)
    .map(task => `${task.label}\nSOURCE: ${task.sourceUrl}\n${task.report}`);
  if (reports.length === 0) {
    throw new Error('Deep Research could not produce a readable report for any source.');
  }

  const batchSummaries: string[] = [];
  for (let start = 0; start < reports.length; start += REPORT_BATCH_SIZE) {
    const batch = reports.slice(start, start + REPORT_BATCH_SIZE).join('\n\n---\n\n');
    const result = await router.complete(
      job.question,
      { hasLinks: true, contentLength: batch.length },
      `Combine these independent source reports into a coherent, cited answer plan for the user's request. Preserve source labels and URLs. Do not invent facts or metrics.\n\n${batch}`,
      { temperature: 0.2, maxTokens: 2200, signal }
    );
    batchSummaries.push(result.text);
  }

  const combined = batchSummaries.join('\n\n---\n\n');
  const final = await router.complete(
    job.question,
    { hasLinks: true, contentLength: combined.length },
    `Answer the user's request using the research reports below. Follow the requested output and tone instead of assuming a Jira or interview use case. Combine related findings, cite supporting URLs, and clearly label uncertain or missing evidence.\n\nUSER REQUEST:\n${job.question}\n\nRESEARCH:\n${combined}`,
    { temperature: 0.3, maxTokens: 4096, signal }
  );
  return final.text;
}
