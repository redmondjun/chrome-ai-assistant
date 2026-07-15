import React from 'react';
import type { LinkVisit, ReasoningStep } from '@/shared/types';

interface AnswerDetailsProps {
  reasoning?: ReasoningStep[];
  links?: LinkVisit[];
}

export function AnswerDetails({ reasoning = [], links = [] }: AnswerDetailsProps) {
  const detailCount = reasoning.length + links.length;
  if (detailCount === 0) return null;

  return (
    <details className="answer-details">
      <summary>
        Details <span>{detailCount}</span>
      </summary>
      <div className="details-content">
        {reasoning.length > 0 && <ReasoningList steps={reasoning} />}
        {links.length > 0 && <SourceList links={links} />}
      </div>
    </details>
  );
}

function ReasoningList({ steps }: { steps: ReasoningStep[] }) {
  return (
    <section>
      <h4>Reasoning</h4>
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
      <h4>Sources visited</h4>
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
