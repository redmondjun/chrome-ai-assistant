import React from 'react';

const SUGGESTED_PROMPTS = [
  'Summarize this page',
  'What are the key takeaways?',
  'Explain this in simple terms',
];

interface EmptyStateProps {
  enabled: boolean;
  onPrompt: (prompt: string) => void;
  discreet?: boolean;
}

export function EmptyState({ enabled, onPrompt, discreet = false }: EmptyStateProps) {
  return (
    <section className={`empty-state ${discreet ? 'empty-state-discreet' : ''}`}>
      {!discreet && <span className="empty-mark">N</span>}
      {!discreet && <h1>Understand any page, faster.</h1>}
      {!discreet && <p>Ask a question or start with one of these.</p>}
      <div className="prompt-list">
        {SUGGESTED_PROMPTS.map(prompt => (
          <button key={prompt} type="button" disabled={!enabled} onClick={() => onPrompt(prompt)}>
            {prompt}
            <span aria-hidden="true">→</span>
          </button>
        ))}
      </div>
    </section>
  );
}
