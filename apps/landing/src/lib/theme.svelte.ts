/**
 * Site appearance: follows the system by default; an explicit choice is stored in
 * localStorage under the same key the inline script in app.html reads before paint.
 */
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

const STORAGE_KEY = 'real-bot-theme';

let current = $state<Theme>('system');

export function getTheme(): Theme {
  return current;
}

export function setTheme(next: Theme): void {
  current = next;
  if (typeof document === 'undefined') return;
  if (next === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', next);
  }
  document.documentElement.setAttribute('data-theme-preference', next);
  try {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage unavailable: the choice lives for this page only */
  }
}

/** Read the stored choice once on the client so the toggle reflects it. */
export function initTheme(): void {
  if (typeof document === 'undefined') return;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  current = stored === 'light' || stored === 'dark' ? stored : 'system';
}
