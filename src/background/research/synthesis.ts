import type { ModelRouter } from '../api/router';
import type { ResearchJob, ResearchTask } from '@/shared/types';

const MAX_SUMMARIES_PER_CALL = 10;
const LOCAL_INPUT_CHAR_LIMIT = 20000;
const CLOUD_INPUT_CHAR_LIMIT = 80000;
type ResearchRouter = Pick<ModelRouter, 'complete'>;

export async function summarizeDiscoveryBatch(
  router: ResearchRouter,
  question: string,
  tasks: ResearchTask[],
  localOnly: boolean,
  signal: AbortSignal
) {
  const inputs = tasks
    .filter(task => task.seedAssessment)
    .map(task => {
      const assessment = task.seedAssessment;
      return `${task.id} | ${task.label}\nSOURCE: ${task.sourceUrl}\nSUMMARY: ${assessment?.summary}\nTHEMES: ${assessment?.themes.join(', ')}\nGAPS: ${assessment?.evidenceGaps.join(', ')}\nEXPANSION: ${assessment?.expansionNeeded ? 'needed' : 'not needed'}`;
    });
  return reduceSummaries(
    router,
    question,
    inputs,
    localOnly,
    'Combine these seed assessments into a compact discovery summary. Preserve task IDs, source URLs, themes, evidence gaps, and which subjects need expansion.',
    1000,
    signal
  );
}

export async function summarizeFinalBatch(
  router: ResearchRouter,
  question: string,
  tasks: ResearchTask[],
  localOnly: boolean,
  signal: AbortSignal
) {
  const inputs = tasks
    .filter(task => task.report)
    .map(task => `${task.id} | ${task.label}\nSOURCE: ${task.sourceUrl}\n${task.report}`);
  return reduceSummaries(
    router,
    question,
    inputs,
    localOnly,
    'Combine these subject reports into a compact cited answer summary. Preserve task labels and source URLs, merge duplicate themes, and retain uncertainty.',
    1600,
    signal
  );
}

export async function synthesizeResearch(
  router: ResearchRouter,
  job: ResearchJob,
  localOnly: boolean,
  signal: AbortSignal,
  onLevel?: (level: number, summaries: string[]) => Promise<void>
) {
  let summaries = (job.batchSummaries || [])
    .filter(summary => summary.kind === 'final')
    .map(summary => summary.summary);
  if (summaries.length === 0) {
    throw new Error('Deep Research could not produce a readable report for any source.');
  }

  let level = 0;
  while (summaries.length > 1) {
    level++;
    const groups = groupInputs(summaries, inputLimit(localOnly));
    const next: string[] = [];
    for (const group of groups) {
      throwIfAborted(signal);
      const result = await router.complete(
        job.question,
        { hasLinks: true, contentLength: group.join('\n\n---\n\n').length },
        `Merge these research summaries into a more compact cited summary for the user request. Preserve URLs, important evidence, disagreements, and uncertainty. Do not invent facts.\n\nUSER REQUEST:\n${job.question}\n\nSUMMARIES:\n${group.join('\n\n---\n\n')}`,
        { temperature: 0.2, maxTokens: 1800, signal }
      );
      next.push(result.text);
    }
    summaries = next;
    await onLevel?.(level, summaries);
  }

  const final = await router.complete(
    job.question,
    { hasLinks: true, contentLength: summaries[0].length },
    `Answer the user's request using the compact research summary below. Follow the requested output and tone, combine related findings, cite supporting URLs, and clearly label uncertain or missing evidence. Do not recommend exporting to Word, PDF, or another format unless the user explicitly requested an export.\n\nUSER REQUEST:\n${job.question}\n\nRESEARCH:\n${summaries[0]}`,
    { temperature: 0.3, maxTokens: 4096, signal }
  );
  return final.text;
}

async function reduceSummaries(
  router: ResearchRouter,
  question: string,
  inputs: string[],
  localOnly: boolean,
  instruction: string,
  maxTokens: number,
  signal: AbortSignal
) {
  if (inputs.length === 0) return '';
  const groups = groupInputs(inputs, inputLimit(localOnly));
  const summaries: string[] = [];
  for (const group of groups) {
    throwIfAborted(signal);
    const content = group.join('\n\n---\n\n');
    const result = await router.complete(
      question,
      { hasLinks: true, contentLength: content.length },
      `${instruction}\n\nUSER REQUEST:\n${question}\n\nINPUT:\n${content}`,
      { temperature: 0.2, maxTokens, signal }
    );
    summaries.push(result.text);
  }
  return summaries.join('\n\n---\n\n');
}

function groupInputs(inputs: string[], characterLimit: number) {
  const separatorLength = '\n\n---\n\n'.length;
  const groups: string[][] = [];
  let group: string[] = [];
  let length = 0;
  inputs.forEach(input => {
    if (
      group.length > 0 &&
      (group.length >= MAX_SUMMARIES_PER_CALL ||
        length + separatorLength + input.length > characterLimit)
    ) {
      groups.push(group);
      group = [];
      length = 0;
    }
    group.push(input.slice(0, characterLimit));
    length += Math.min(input.length, characterLimit) + (group.length > 1 ? separatorLength : 0);
  });
  if (group.length > 0) groups.push(group);
  return groups;
}

function inputLimit(localOnly: boolean) {
  return localOnly ? LOCAL_INPUT_CHAR_LIMIT : CLOUD_INPUT_CHAR_LIMIT;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
}
