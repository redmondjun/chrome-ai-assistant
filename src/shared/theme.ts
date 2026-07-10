import { useEffect } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

export function applyTheme(preference: ThemePreference) {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

export function useTheme(preference: ThemePreference) {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(preference);
    update();
    if (preference === 'system') media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [preference]);
}
