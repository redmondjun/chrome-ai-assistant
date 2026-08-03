import { synthesizeResearch } from './synthesis';
import type { ResearchJob } from '@/shared/types';

describe('hierarchical research synthesis', () => {
  it('bounds local-only synthesis inputs and recursively reduces batches', async () => {
    const contentLengths: number[] = [];
    const prompts: string[] = [];
    const router = {
      complete: jest.fn(
        async (_question: string, context: { contentLength: number }, prompt: string) => {
          contentLengths.push(context.contentLength);
          prompts.push(prompt);
          return { text: 'Reduced cited summary', modelUsed: 'local' as const };
        }
      ),
    };
    const job = createSynthesisJob(25, 6000);
    const levels: number[] = [];

    const answer = await synthesizeResearch(
      router,
      job,
      true,
      new AbortController().signal,
      async level => {
        levels.push(level);
      }
    );

    expect(answer).toBe('Reduced cited summary');
    expect(contentLengths.slice(0, -1).every(length => length <= 20000)).toBe(true);
    expect(levels.length).toBeGreaterThanOrEqual(2);
    expect(prompts.at(-1)).toContain('Do not recommend exporting to Word, PDF, or another format');
  });
});

function createSynthesisJob(summaryCount: number, summaryLength: number): ResearchJob {
  const now = Date.now();
  return {
    id: 'synthesis-job',
    messageId: 'message',
    question: 'Create a research report',
    status: 'running',
    tasks: [],
    batchSummaries: Array.from({ length: summaryCount }, (_, index) => ({
      batchIndex: index,
      kind: 'final',
      taskIds: [],
      summary: `${index}:${'x'.repeat(summaryLength)}`,
      createdAt: now,
    })),
    progress: {
      jobId: 'synthesis-job',
      status: 'running',
      activity: 'Synthesizing',
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      activeWorkers: 0,
      sourcesRead: 0,
      sourcesFailed: 0,
      updatedAt: now,
      activeTaskIds: [],
    },
    createdAt: now,
    updatedAt: now,
  };
}
