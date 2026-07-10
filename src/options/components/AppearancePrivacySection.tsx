import React from 'react';
import type { PrivacySettings, UiSettings } from '../settings-model';
import { CONTROL_CLASS, Field, SettingsSection, Toggle } from './FormControls';

interface Props {
  ui: UiSettings;
  privacy: PrivacySettings;
  onUiChange: (settings: UiSettings) => void;
  onPrivacyChange: (settings: PrivacySettings) => void;
}

export function AppearancePrivacySection({ ui, privacy, onUiChange, onPrivacyChange }: Props) {
  return (
    <SettingsSection
      title="Appearance and privacy"
      description="Set your theme, response behavior, and data preferences."
    >
      <Field id="theme" label="Theme">
        <select
          id="theme"
          value={ui.theme}
          onChange={event =>
            onUiChange({ ...ui, theme: event.target.value as UiSettings['theme'] })
          }
          className={CONTROL_CLASS}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </Field>

      <div className="flex flex-wrap gap-4">
        <Toggle
          checked={ui.streaming}
          label="Stream responses"
          onChange={checked => onUiChange({ ...ui, streaming: checked })}
        />
      </div>

      <div className="flex flex-wrap gap-4">
        <Toggle
          checked={privacy.localOnly}
          label="Local-only mode (no cloud calls)"
          onChange={checked => onPrivacyChange({ ...privacy, localOnly: checked })}
        />
        <Toggle
          checked={privacy.clearOnClose}
          label="Clear data on browser close"
          onChange={checked => onPrivacyChange({ ...privacy, clearOnClose: checked })}
        />
      </div>
    </SettingsSection>
  );
}
