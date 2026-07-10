import React from 'react';
import { SettingsSection } from './FormControls';

interface Props {
  onExport: () => void;
  onImport: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onReset: () => void;
}

export function BackupRestoreSection({ onExport, onImport, onReset }: Props) {
  return (
    <SettingsSection
      title="Backup and restore"
      description="Move your configuration between browser profiles or start over."
    >
      <div className="flex flex-wrap gap-4">
        <button
          type="button"
          onClick={onExport}
          className="px-4 py-2 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
        >
          Export Settings
        </button>
        <label className="flex items-center cursor-pointer px-4 py-2 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">
          Import Settings
          <input type="file" accept=".json" onChange={onImport} className="hidden" />
        </label>
        <button
          type="button"
          onClick={onReset}
          className="px-4 py-2 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-lg hover:bg-red-200 dark:hover:bg-red-900/50"
        >
          Reset to Defaults
        </button>
      </div>
    </SettingsSection>
  );
}
