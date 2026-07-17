import React from 'react';
import type { LinkVisit, ReasoningStep } from '@/shared/types';

interface AnswerDetailsProps {
  reasoning?: ReasoningStep[];
  links?: LinkVisit[];
  isStreaming?: boolean;
}

export function AnswerDetails({
  reasoning = [],
  links = [],
  isStreaming = false,
}: AnswerDetailsProps) {
  if (reasoning.length === 0 && links.length === 0) return null;

  return (
    <div className="answer-details">
      {reasoning.length > 0 && (
        <details className="answer-detail" open={isStreaming}>
          <summary>
            Reasoning <span>{reasoning.length}</span>
          </summary>
          <div className="details-content">
            <ReasoningList steps={reasoning} />
          </div>
        </details>
      )}
      {links.length > 0 && (
        <details className="answer-detail" open={isStreaming}>
          <summary>
            Sources visited <span>{getLatestVisits(links).length}</span>
          </summary>
          <div className="details-content">
            <SourceList links={getLatestVisits(links)} />
          </div>
        </details>
      )}
    </div>
  );
}

function getLatestVisits(links: LinkVisit[]) {
  const latestByUrl = new Map<string, LinkVisit>();
  links.forEach(link => latestByUrl.set(link.url, link));
  return [...latestByUrl.values()];
}

function ReasoningList({ steps }: { steps: ReasoningStep[] }) {
  return (
    <section>
      <ol>
        {steps.map((step, index) => (
          <li key={`${step.timestamp}-${index}`}>{step.thought}</li>
        ))}
      </ol>
    </section>
  );
}

function SourceList({ links }: { links: LinkVisit[] }) {
  return (
    <section>
      <ul className="source-list">
        {links.map((link, index) => (
          <li key={`${link.url}-${index}`}>
            <span className={`source-status ${link.status}`} />
            <div>
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                {link.title || link.url}
              </a>
              <small>
                {link.status}
                {Number.isFinite(link.relevanceScore)
                  ? ` · ${Math.round(link.relevanceScore * 100)}% selection score`
                  : ''}
                {link.method ? ` · ${link.method}` : ''}
                {link.depth ? ` · depth ${link.depth}` : ''}
              </small>
              {link.error && <small className="danger-text">{link.error}</small>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
