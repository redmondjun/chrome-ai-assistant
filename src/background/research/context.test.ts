import { buildResearchConversationContext, createPartialResearchAnswer } from './context';
import type { ResearchJob, ResearchTask } from '@/shared/types';

describe('persisted research context', () => {
  it('builds compact partial findings with trustworthy source outcomes', () => {
    const job = createJob();

    const partial = createPartialResearchAnswer(job, '370 subjects failed');
    job.partialAnswer = partial;
    const context = buildResearchConversationContext(job);

    expect(partial).toContain('Completed subjects: 1/2');
    expect(partial).toContain('Validated readable sources: 1');
    expect(partial).toContain('Failed or inaccessible sources: 1');
    expect(partial).toContain('Validated impact report');
    expect(context).toEqual(
      expect.objectContaining({
        status: 'failed',
        completedSubjects: 1,
        totalSubjects: 2,
        successfulSources: 1,
        failedSources: 1,
        partial: true,
      })
    );
  });
});

function createJob(): ResearchJob {
  const now = Date.now();
  const completed = createTask('completed', 'completed');
  completed.report = 'Validated impact report';
  const failed = createTask('failed', 'failed');
  return {
    id: 'job',
    messageId: 'message',
    question: 'Summarize impact',
    status: 'failed',
    tasks: [completed, failed],
    sourceRegistry: [
      {
        key: completed.sourceUrl,
        url: completed.sourceUrl,
        title: completed.title,
        status: 'success',
        taskIds: [completed.id],
        evidence: {
          url: completed.sourceUrl,
          title: completed.title,
          category: 'other',
          excerpt: 'Validated evidence',
          depth: 0,
        },
        retries: 0,
        cacheHits: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        key: failed.sourceUrl,
        url: failed.sourceUrl,
        title: failed.title,
        status: 'failed',
        taskIds: [failed.id],
        error: 'Access denied',
        failureReason: 'access-denied',
        retries: 0,
        cacheHits: 0,
        createdAt: now,
        updatedAt: now,
      },
    ],
    progress: {
      jobId: 'job',
      status: 'failed',
      activity: 'Partial',
      totalTasks: 2,
      completedTasks: 1,
      failedTasks: 1,
      activeWorkers: 0,
      sourcesRead: 1,
      sourcesFailed: 1,
      updatedAt: now,
      activeTaskIds: [],
    },
    error: '370 subjects failed',
    createdAt: now,
    updatedAt: now,
  };
}

function createTask(id: string, status: ResearchTask['status']): ResearchTask {
  const now = Date.now();
  return {
    id,
    label: id,
    sourceUrl: `https://example.com/${id}`,
    title: id,
    status,
    phase: status,
    phaseStartedAt: now,
    lastActivityAt: now,
    reasoning: [],
    linkVisits: [],
    relatedSourcesRead: 0,
    relatedSourcesAttempted: 0,
    evidence: [],
    decisions: [],
    pendingSources: [],
    visitedUrls: [],
  };
}
