import React from 'react';
import type { ResearchSettings } from '../settings-model';
import { CONTROL_CLASS, Field, SettingsSection, Toggle } from './FormControls';
import {
  CLOUD_MODEL_LABELS,
  SUPPORTED_CLOUD_MODELS,
  type SupportedCloudModel,
} from '@/shared/cloud-models';

interface Props {
  settings: ResearchSettings;
  localOnly: boolean;
  onChange: (settings: ResearchSettings) => void;
}

export function ResearchSettingsSection({ settings, localOnly, onChange }: Props) {
  const orchestrationDisabled = localOnly || !settings.orchestrationEnabled;
  const toggleWorkerModel = (model: SupportedCloudModel, checked: boolean) => {
    const workerModels = checked
      ? [...settings.workerModels, model]
      : settings.workerModels.filter(candidate => candidate !== model);
    if (workerModels.length > 0) onChange({ ...settings, workerModels });
  };

  return (
    <SettingsSection
      title="Deep Research"
      description="Control how many independent source workers can research at the same time."
    >
      <Toggle
        checked={settings.orchestrationEnabled}
        disabled={localOnly}
        label="Use multiple NVIDIA models for Deep Research"
        onChange={orchestrationEnabled => onChange({ ...settings, orchestrationEnabled })}
      />
      {localOnly && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Cloud orchestration is unavailable while local-only mode is enabled.
        </p>
      )}
      <fieldset disabled={orchestrationDisabled} className="space-y-2 disabled:opacity-50">
        <legend className="block text-sm font-medium mb-1">Worker models</legend>
        {SUPPORTED_CLOUD_MODELS.map(model => (
          <label key={model} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.workerModels.includes(model)}
              disabled={
                orchestrationDisabled ||
                (settings.workerModels.length === 1 && settings.workerModels[0] === model)
              }
              onChange={event => toggleWorkerModel(model, event.target.checked)}
            />
            <span>{CLOUD_MODEL_LABELS[model]}</span>
          </label>
        ))}
      </fieldset>
      <Field id="research-lead-model" label="Lead synthesis model">
        <select
          id="research-lead-model"
          value={settings.leadModel}
          disabled={orchestrationDisabled}
          onChange={event =>
            onChange({ ...settings, leadModel: event.target.value as SupportedCloudModel })
          }
          className={CONTROL_CLASS}
        >
          {SUPPORTED_CLOUD_MODELS.map(model => (
            <option key={model} value={model}>
              {CLOUD_MODEL_LABELS[model]}
            </option>
          ))}
        </select>
      </Field>
      <Field id="research-worker-concurrency" label="Concurrent research workers">
        <input
          id="research-worker-concurrency"
          type="number"
          min={1}
          max={5}
          value={settings.workerConcurrency}
          onChange={event =>
            onChange({
              ...settings,
              workerConcurrency: Math.min(5, Math.max(1, Number(event.target.value) || 1)),
            })
          }
          className={CONTROL_CLASS}
        />
      </Field>
      <Field id="research-related-source-limit" label="Related sources per subject">
        <input
          id="research-related-source-limit"
          type="number"
          min={0}
          max={20}
          value={settings.maxRelatedSourcesPerTask}
          onChange={event =>
            onChange({
              ...settings,
              maxRelatedSourcesPerTask: Math.min(20, Math.max(0, Number(event.target.value) || 0)),
            })
          }
          className={CONTROL_CLASS}
        />
      </Field>
      <Field id="research-subject-batch-size" label="Subjects per research batch">
        <input
          id="research-subject-batch-size"
          type="number"
          min={1}
          max={100}
          value={settings.subjectBatchSize}
          onChange={event =>
            onChange({
              ...settings,
              subjectBatchSize: Math.min(100, Math.max(1, Number(event.target.value) || 25)),
            })
          }
          className={CONTROL_CLASS}
        />
      </Field>
      <Field id="research-source-budget" label="Unique sources per research job">
        <input
          id="research-source-budget"
          type="number"
          min={1}
          max={10000}
          value={settings.maxUniqueSourcesPerJob}
          onChange={event =>
            onChange({
              ...settings,
              maxUniqueSourcesPerJob: Math.min(
                10000,
                Math.max(1, Number(event.target.value) || 1000)
              ),
            })
          }
          className={CONTROL_CLASS}
        />
      </Field>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Three workers is the recommended balance for authenticated and public sources.
      </p>
    </SettingsSection>
  );
}
