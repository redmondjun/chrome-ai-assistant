import React from 'react';
import type { ResearchSettings } from '../settings-model';
import { CONTROL_CLASS, Field, SettingsSection } from './FormControls';

interface Props {
  settings: ResearchSettings;
  onChange: (settings: ResearchSettings) => void;
}

export function ResearchSettingsSection({ settings, onChange }: Props) {
  return (
    <SettingsSection
      title="Deep Research"
      description="Control how many independent source workers can research at the same time."
    >
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
