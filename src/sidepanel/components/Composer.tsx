import React, { useEffect, useRef } from 'react';

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  pageReady: boolean;
  busy: boolean;
  generating: boolean;
  onStop: () => void;
  deepResearch?: boolean;
  onDeepResearchChange?: (enabled: boolean) => void;
  researchSubjectCount?: number;
}

export function Composer({
  value,
  onChange,
  onSend,
  pageReady,
  busy,
  generating,
  onStop,
  deepResearch = false,
  onDeepResearchChange,
  researchSubjectCount = 0,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const disabled = !pageReady || busy;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 128)}px`;
  }, [value]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;

    event.preventDefault();
    if (value.trim() && !disabled) onSend();
  };

  return (
    <footer className="composer-wrap">
      {!pageReady && (
        <p className="composer-note">Open a readable webpage before asking a question.</p>
      )}
      <label className="deep-research-toggle">
        <input
          type="checkbox"
          checked={deepResearch}
          disabled={generating}
          onChange={event => onDeepResearchChange?.(event.target.checked)}
        />
        <span>Deep Research</span>
        <small>
          {researchSubjectCount > 0
            ? `${researchSubjectCount} researchable link${researchSubjectCount === 1 ? '' : 's'} detected`
            : 'Use independent workers to investigate links from this page'}
        </small>
      </label>
      <div className="composer">
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          onChange={event => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={pageReady ? 'Ask about this page…' : 'Page unavailable'}
          aria-label="Ask about this page"
        />
        {generating ? (
          <StopButton onClick={onStop} />
        ) : (
          <SendButton disabled={disabled || !value.trim()} onClick={onSend} />
        )}
      </div>
      <small>Enter to send · Shift + Enter for a new line</small>
    </footer>
  );
}

function StopButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="stop-button" aria-label="Stop response">
      <span aria-hidden="true" />
    </button>
  );
}

function SendButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label="Send message">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m5 12 14-7-4 14-3-5-7-2Z" />
        <path d="m12 14 7-9" />
      </svg>
    </button>
  );
}
