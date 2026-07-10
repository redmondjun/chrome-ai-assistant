import React from 'react';
import type { LinkSettings } from '../settings-model';
import { CONTROL_CLASS, Field, SettingsSection, Toggle } from './FormControls';

interface Props {
  settings: LinkSettings;
  onChange: (settings: LinkSettings) => void;
}

export function LinkSettingsSection({ settings, onChange }: Props) {
  const update = <Key extends keyof LinkSettings>(key: Key, value: LinkSettings[Key]) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <SettingsSection
      title="Link following"
      description="Control how the assistant researches links from the current page."
    >
      <Toggle
        checked={settings.enabled}
        label="Enable automatic link following"
        onChange={checked => update('enabled', checked)}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <NumberField
          id="max-depth"
          label="Max Depth"
          min={1}
          max={5}
          value={settings.maxDepth}
          onChange={value => update('maxDepth', value)}
        />
        <NumberField
          id="max-pages"
          label="Max Pages"
          min={1}
          max={50}
          value={settings.maxPages}
          onChange={value => update('maxPages', value)}
        />
        <NumberField
          id="rate-limit"
          label="Rate Limit (ms)"
          min={100}
          max={10000}
          step={100}
          value={settings.rateLimitMs}
          onChange={value => update('rateLimitMs', value)}
        />
      </div>

      <Toggle
        checked={settings.requireConfirmation}
        label="Require confirmation before following links"
        onChange={checked => update('requireConfirmation', checked)}
      />

      <Field id="allowed-domains" label="Allowed Domains (comma-separated, empty = all)">
        <input
          id="allowed-domains"
          type="text"
          value={settings.allowedDomains}
          onChange={event => update('allowedDomains', event.target.value)}
          className={CONTROL_CLASS}
        />
      </Field>

      <Field id="blocked-domains" label="Blocked Domains (comma-separated)">
        <input
          id="blocked-domains"
          type="text"
          value={settings.blockedDomains}
          onChange={event => update('blockedDomains', event.target.value)}
          className={CONTROL_CLASS}
        />
      </Field>
    </SettingsSection>
  );
}

interface NumberFieldProps {
  id: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
}

function NumberField({ id, label, min, max, step, value, onChange }: NumberFieldProps) {
  return (
    <Field id={id} label={label}>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
        className={CONTROL_CLASS}
      />
    </Field>
  );
}
