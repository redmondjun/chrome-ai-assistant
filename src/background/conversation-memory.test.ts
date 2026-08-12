import { buildConversationBrief, getPriorResearchJobIds } from './conversation-memory';
import type { ChatMessage } from '@/shared/types';

describe('conversation memory', () => {
  it('keeps the original objective and later user corrections beyond twelve messages', () => {
    const history: ChatMessage[] = [message('user', 'Original promotion plan objective')];
    for (let index = 0; index < 14; index++) {
      history.push(message('assistant', `Assistant response ${index}`));
    }
    history.push(message('user', 'Use the exact qualification format'));

    const brief = buildConversationBrief(history, 'Continue with the remaining tickets');

    expect(brief).toContain('Original promotion plan objective');
    expect(brief).toContain('Use the exact qualification format');
    expect(brief).toContain(
      'Current request (highest priority):\nContinue with the remaining tickets'
    );
  });

  it('returns unique research jobs in conversation order', () => {
    const history = [
      { ...message('assistant', 'first'), researchJobId: 'job-1' },
      { ...message('assistant', 'same'), researchJobId: 'job-1' },
      { ...message('assistant', 'second'), researchJobId: 'job-2' },
    ];

    expect(getPriorResearchJobIds(history)).toEqual(['job-1', 'job-2']);
  });
});

function message(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: crypto.randomUUID(), role, content, timestamp: Date.now() };
}
