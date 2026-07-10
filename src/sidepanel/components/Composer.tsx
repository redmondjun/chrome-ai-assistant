import React, { useEffect, useRef } from 'react';

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  pageReady: boolean;
  busy: boolean;
}

export function Composer({ value, onChange, onSend, pageReady, busy }: ComposerProps) {
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
        <SendButton disabled={disabled || !value.trim()} onClick={onSend} />
      </div>
      <small>Enter to send · Shift + Enter for a new line</small>
    </footer>
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
