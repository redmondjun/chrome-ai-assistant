import type { ChatMessage } from '@/shared/types';

const ORIGINAL_REQUEST_LIMIT = 6000;
const USER_INSTRUCTION_BUDGET = 14000;
const USER_INSTRUCTION_LIMIT = 2000;
const ASSISTANT_CONTEXT_BUDGET = 8000;
const ASSISTANT_MESSAGE_LIMIT = 2000;

export function buildConversationBrief(history: ChatMessage[], currentQuestion: string): string {
  const completed = history.filter(message => !message.isStreaming && message.content.trim());
  const userMessages = completed.filter(message => message.role === 'user');
  const originalRequest =
    userMessages[0]?.content.slice(0, ORIGINAL_REQUEST_LIMIT) || currentQuestion;
  const laterInstructions = fitNewest(
    userMessages.slice(1).map(message => message.content),
    USER_INSTRUCTION_BUDGET,
    USER_INSTRUCTION_LIMIT
  );
  const recentAssistantContext = fitNewest(
    completed
      .filter(message => message.role === 'assistant' && !isErrorMessage(message.content))
      .map(message => message.content),
    ASSISTANT_CONTEXT_BUDGET,
    ASSISTANT_MESSAGE_LIMIT
  );

  return [
    `Original request:\n${originalRequest}`,
    laterInstructions.length > 0
      ? `User instructions and corrections, oldest to newest:\n${laterInstructions.join('\n\n')}`
      : '',
    recentAssistantContext.length > 0
      ? `Recent assistant context:\n${recentAssistantContext.join('\n\n')}`
      : '',
    `Current request (highest priority):\n${currentQuestion}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function getPriorResearchJobIds(history: ChatMessage[]): string[] {
  return [
    ...new Set(history.flatMap(message => (message.researchJobId ? [message.researchJobId] : []))),
  ];
}

function fitNewest(values: string[], budget: number, itemLimit: number): string[] {
  const selected: string[] = [];
  let remaining = budget;
  for (let index = values.length - 1; index >= 0 && remaining > 0; index--) {
    const value = values[index].slice(0, Math.min(itemLimit, remaining));
    selected.unshift(value);
    remaining -= value.length;
  }
  return selected;
}

function isErrorMessage(content: string): boolean {
  return /^(?:error:|failed to fetch|bodystreambuffer was aborted)/i.test(content.trim());
}
