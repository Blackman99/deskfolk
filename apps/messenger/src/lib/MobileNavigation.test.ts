import { expect, test } from 'bun:test';
import { copyFor } from './copy.ts';
import { click, render } from './test-render.ts';
import MobileNavigation from './MobileNavigation.svelte';

for (const locale of ['zh', 'en'] as const) {
  test(`mobile navigation labels, current destination and actions (${locale})`, () => {
    const t = copyFor(locale);
    const destinations: string[] = [];
    const { host, close } = render(MobileNavigation, {
      active: 'workspace', t, updateAvailable: true,
      onNavigate: (destination: string) => destinations.push(destination),
    });
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.map(b => b.textContent?.trim())).toEqual([t.sidebar.sessions, t.sidebar.workspace, t.settings.title]);
    expect(buttons[1].getAttribute('aria-current')).toBe('page');
    expect(host.querySelectorAll('[aria-current]')).toHaveLength(1);
    for (const button of buttons) click(button);
    expect(destinations).toEqual(['sessions', 'workspace', 'settings']);
    expect(host.querySelector('.navigation-update')?.getAttribute('aria-label')).toBe(t.sidebar.updateAvailable);
    close();
  });
}
