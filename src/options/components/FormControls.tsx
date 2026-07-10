import React from 'react';

export const CONTROL_CLASS =
  'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700';

interface FieldProps {
  id: string;
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}

export function Field({ id, label, hint, children }: FieldProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium mb-1">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

interface ToggleProps {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

export function Toggle({ checked, label, onChange }: ToggleProps) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
      />
      <span>{label}</span>
    </label>
  );
}

interface SectionProps {
  title: string;
  description: string;
  children: React.ReactNode;
}

export function SettingsSection({ title, description, children }: SectionProps) {
  return (
    <section className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow">
      <h2 className="text-lg font-semibold mb-1">{title}</h2>
      <p className="section-description">{description}</p>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
