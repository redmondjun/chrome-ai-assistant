import React, { useState } from 'react';

interface ApiKeyOnboardingProps {
  onSave: (apiKey: string) => Promise<void>;
  onOpenSettings: () => void;
}

export function ApiKeyOnboarding({ onSave, onOpenSettings }: ApiKeyOnboardingProps) {
  const [apiKey, setApiKey] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextApiKey = apiKey.trim();
    if (!nextApiKey) return;

    setIsSaving(true);
    try {
      await onSave(nextApiKey);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <main className="onboarding">
      <section className="setup-card">
        <span className="setup-mark">N</span>
        <p className="eyebrow">One-time setup</p>
        <h1>Connect your AI assistant</h1>
        <p>Add an NVIDIA API key to ask questions about any page you visit.</p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="api-key">NVIDIA API key</label>
          <input
            id="api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={event => setApiKey(event.target.value)}
            placeholder="nvapi-…"
            autoFocus
          />
          <small>
            Your key stays on this device. Create one at{' '}
            <a href="https://build.nvidia.com" target="_blank" rel="noopener noreferrer">
              build.nvidia.com
            </a>
            .
          </small>
          <button className="primary-button" type="submit" disabled={!apiKey.trim() || isSaving}>
            {isSaving ? 'Saving…' : 'Save and continue'}
          </button>
        </form>
        <button className="text-button" type="button" onClick={onOpenSettings}>
          Open advanced settings
        </button>
      </section>
    </main>
  );
}
