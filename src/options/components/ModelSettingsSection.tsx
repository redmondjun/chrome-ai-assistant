import React from 'react';
import type { ModelSettings } from '../settings-model';
import { CONTROL_CLASS, Field, SettingsSection, Toggle } from './FormControls';

interface Props {
  settings: ModelSettings;
  localModelStatus: { ready: boolean; progress: number };
  onChange: (settings: ModelSettings) => void;
  onDownloadModel: () => void;
}

export function ModelSettingsSection({
  settings,
  localModelStatus,
  onChange,
  onDownloadModel,
}: Props) {
  const update = <Key extends keyof ModelSettings>(key: Key, value: ModelSettings[Key]) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <SettingsSection title="AI model" description="Choose how responses are generated and routed.">
      <Field
        id="nvidia-api-key"
        label="NVIDIA API Key"
        hint={
          <>
            Get your key at{' '}
            <a href="https://build.nvidia.com" target="_blank" rel="noopener">
              build.nvidia.com
            </a>
          </>
        }
      >
        <input
          id="nvidia-api-key"
          type="password"
          value={settings.apiKey}
          onChange={event => update('apiKey', event.target.value)}
          placeholder="Enter your NVIDIA API key"
          className={CONTROL_CLASS}
        />
      </Field>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field id="cloud-model" label="Cloud Model">
          <select
            id="cloud-model"
            value={settings.cloudModel}
            onChange={event => update('cloudModel', event.target.value)}
            className={CONTROL_CLASS}
          >
            <option value="nemotron-3-nano">Nemotron 3 Nano (Fast, 1M ctx)</option>
            <option value="nemotron-3-super">Nemotron 3 Super (Balanced)</option>
            <option value="nemotron-3-ultra">Nemotron 3 Ultra (Best quality)</option>
          </select>
        </Field>

        <Field id="custom-endpoint" label="Custom NIM Endpoint (optional)">
          <input
            id="custom-endpoint"
            type="text"
            value={settings.customEndpoint}
            onChange={event => update('customEndpoint', event.target.value)}
            placeholder="https://your-nim.example.com/v1"
            className={CONTROL_CLASS}
          />
        </Field>
      </div>

      <div className="flex flex-wrap gap-4">
        <Toggle
          checked={settings.useLocal}
          label="Use Local Model (Nemotron Mini 4B)"
          onChange={checked => update('useLocal', checked)}
        />
        <Toggle
          checked={settings.autoRoute}
          label="Auto-route (simple → local, complex → cloud)"
          onChange={checked => update('autoRoute', checked)}
        />
      </div>

      <Field
        id="force-cloud-for"
        label="Force Cloud For (comma-separated)"
        hint="Keywords that always use cloud model"
      >
        <input
          id="force-cloud-for"
          type="text"
          value={settings.forceCloudFor.join(', ')}
          onChange={event =>
            update(
              'forceCloudFor',
              event.target.value
                .split(',')
                .map(value => value.trim())
                .filter(Boolean)
            )
          }
          className={CONTROL_CLASS}
        />
      </Field>

      {settings.useLocal && !localModelStatus.ready && (
        <LocalModelDownload status={localModelStatus} onDownload={onDownloadModel} />
      )}

      {localModelStatus.ready && (
        <div className="settings-alert settings-alert-success p-3 rounded-lg">
          Local model is ready.
        </div>
      )}
    </SettingsSection>
  );
}

function LocalModelDownload({
  status,
  onDownload,
}: {
  status: { progress: number };
  onDownload: () => void;
}) {
  const isDownloading = status.progress > 0 && status.progress < 1;

  return (
    <div className="settings-alert settings-alert-warning p-3 rounded-lg">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary-600 transition-all duration-300"
              style={{ width: `${status.progress * 100}%` }}
            />
          </div>
          <p className="text-sm text-yellow-800 dark:text-yellow-200 mt-1">
            Local model not downloaded. Click to download (~2.5 GB).
          </p>
        </div>
        <button
          type="button"
          onClick={onDownload}
          disabled={isDownloading}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
        >
          {status.progress > 0
            ? `Downloading... ${Math.round(status.progress * 100)}%`
            : 'Download Model'}
        </button>
      </div>
    </div>
  );
}
