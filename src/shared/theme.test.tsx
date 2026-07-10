import React from 'react';
import { act, render } from '@testing-library/react';
import { useTheme } from './theme';

function Harness({ theme }: { theme: 'light' | 'dark' | 'system' }) {
  useTheme(theme);
  return null;
}

describe('theme', () => {
  it('applies explicit light and dark themes', () => {
    const view = render(<Harness theme="light" />);
    expect(document.documentElement.dataset.theme).toBe('light');
    view.rerender(<Harness theme="dark" />);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('tracks system theme changes', () => {
    let listener: (() => void) | undefined;
    let dark = false;
    (window.matchMedia as jest.Mock).mockImplementation(() => ({
      get matches() {
        return dark;
      },
      addEventListener: (_: string, next: () => void) => {
        listener = next;
      },
      removeEventListener: jest.fn(),
    }));
    render(<Harness theme="system" />);
    expect(document.documentElement.dataset.theme).toBe('light');
    dark = true;
    act(() => listener?.());
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
