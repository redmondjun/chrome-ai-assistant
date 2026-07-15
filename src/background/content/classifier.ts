import { ModelRouter } from '../api/router';
import type { LinkInfo } from '../../shared/types';

export async function classifyLinks(
  router: ModelRouter,
  links: LinkInfo[],
  question: string
): Promise<number[]> {
  if (links.length === 0) return [];

  const prompt = `Score each link 0-1 for relevance to: "${question}"

Links:
${links.map((l, i) => `${i + 1}. ${l.text} (${l.url}) - Context: ${l.context || 'none'}`).join('\n')}

Output ONLY a JSON array of numbers: [0.8, 0.2, ...]`;

  const { text } = await router.complete(question, { hasLinks: true, contentLength: 0 }, prompt, {
    temperature: 0.1,
    maxTokens: 512,
  });

  try {
    const scores = JSON.parse(text);
    return Array.isArray(scores) ? scores.map(n => Math.max(0, Math.min(1, Number(n) || 0))) : [];
  } catch {
    return links.map(() => 0.5);
  }
}

export async function shouldFollowLinks(
  router: ModelRouter,
  question: string,
  linkCount: number
): Promise<boolean> {
  const prompt = `Does this question require visiting links to answer well?
The current page contains ${linkCount} links that the assistant can visit.
Question: "${question}"

Answer ONLY "yes" or "no".`;

  try {
    const { text } = await router.complete(question, { hasLinks: true, contentLength: 0 }, prompt, {
      temperature: 0,
      maxTokens: 10,
    });
    return text.toLowerCase().includes('yes');
  } catch {
    return /\b(link|source|reference|citation|ticket|pull request|pr|supporting material|peer feedback)\b/i.test(
      question
    );
  }
}
