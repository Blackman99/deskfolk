import { afterEach, expect, test } from 'bun:test';
import { emptySnapshot } from './snapshot.ts';
import { aBot, aDirect, fakeRuntime } from './test-fixtures.ts';
import { reactive } from './test-reactive.svelte.ts';
import { buttonByText, click, fill, render } from './test-render.ts';
import { makeLeaf } from './workbench/layout-tree.ts';
import { settle } from './test-async.ts';
import { aTerminal, loadShell, menuRow, storedTabs } from './test-shell-kit.ts';

const Shell = await loadShell();

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

function menuNames(): string[] {
  return [...document.querySelectorAll('.wb-new-menu .wb-menu-name')].map((node) => node.textContent?.trim() ?? '');
}

/** The injected rule for a class. happy-dom lays nothing out, so a size lives in the rule. */
function ruleText(className: string): string {
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule && rule.selectorText.split(',').some((part) => part.trim().startsWith(className))) {
        return rule.cssText;
      }
    }
  }
  return '';
}

for (const entry of ['pane', 'sidebar'] as const) test(`a new terminal from ${entry} starts its own shell and binds its tab`, async () => {
  localStorage.removeItem('real-bot-workbench-layout');
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [aDirect()],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: 'direct-1' }));
  let started = 0;
  runtime.startTerminal = async () => {
    started += 1;
    const row = aTerminal(`term-${started}`, `2026-09-23T0${started}:00:00.000Z`);
    runtime.terminals = [...runtime.terminals, row];
    return row;
  };
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  for (let i = 0; i < 2; i += 1) {
    click(host.querySelector(entry === 'pane' ? '.wb-new-tab' : '.foot .tools-entry'));
    click(buttonByText(document.body, 'New terminal'));
    await settle();
  }
  // Two tabs, two shells: never the same terminal twice.
  expect(storedTabs().filter((tab) => tab.kind === 'terminal').map((tab) => tab.params.terminalId)).toEqual(['term-1', 'term-2']);
  const labels = [...host.querySelectorAll('.wb-tab-button')].map((tab) => tab.textContent?.trim());
  expect(labels).toContain('real-bot');
  expect(labels).toContain('real-bot 2');
  // No strip of sessions inside a tab.
  expect(host.querySelector('.terminal-tabs')).toBeNull();
});

test('a shell no tab shows can be reattached from where you open things', async () => {
  localStorage.removeItem('real-bot-workbench-layout');
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [aDirect()],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: 'direct-1' }));
  runtime.terminals = [aTerminal('term-kept', '2026-09-23T01:00:00.000Z')];
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  click(host.querySelector('.wb-new-tab'));
  click(menuRow('real-bot'));
  await settle();
  expect(storedTabs().filter((tab) => tab.kind === 'terminal').map((tab) => tab.params.terminalId)).toEqual(['term-kept']);
  // Once a tab shows it, it is not offered again.
  click(host.querySelector('.wb-new-tab'));
  expect(menuNames()).not.toContain('real-bot');
  expect(runtime.calls.filter((call) => call.name === 'startTerminal')).toHaveLength(0);
});

test('the new-tab menu stays a list when many shells are still running, and a query narrows them', async () => {
  localStorage.removeItem('real-bot-workbench-layout');
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [aDirect()],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: 'direct-1' }));
  runtime.terminals = Array.from({ length: 12 }, (_, index) => ({
    ...aTerminal(`term-${index}`, `2026-09-23T01:${String(index).padStart(2, '0')}:00.000Z`),
    cwd: index === 3 ? '/fixture/kept' : `/fixture/other-${index}`,
    title: index === 3 ? 'kept' : 'real-bot',
  }));
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  click(host.querySelector('.wb-new-tab'));
  const menu = document.querySelector<HTMLElement>('.wb-new-menu');
  expect(menu?.parentElement).toBe(document.body);
  // A dozen shells used to widen a wrapping row of chips. The width is the menu's own, and the
  // list scrolls; happy-dom does not resolve that width, so it is read off the rule.
  const menuRule = ruleText('.wb-new-menu');
  expect(menuRule).toContain('width: 280px');
  expect(menuRule).toContain('flex-direction: column');
  expect(ruleText('.wb-new-scroll')).toContain('overflow: auto');
  expect(menuNames().filter((name) => name.startsWith('real-bot'))).toHaveLength(11);
  fill(menu!.querySelector('input'), 'kept');
  expect(menuNames()).toContain('kept');
  expect(menuNames().some((name) => name.startsWith('real-bot'))).toBe(false);
  // The three ways to open something stay put while the list is filtered.
  expect(menuNames()).toEqual(expect.arrayContaining(['New terminal', 'Workspace', 'Routines']));
});

test('the sidebar terminal button brings back the terminal tab you have rather than a new shell', async () => {
  localStorage.setItem('real-bot-workbench-layout', JSON.stringify({
    version: 1,
    // The conversation is in front; the terminal tab sits behind it.
    root: {
      ...makeLeaf('a', [
        { id: 't-term', kind: 'terminal', params: { terminalId: 'term-kept' } },
        { id: 't-chat', kind: 'chat', params: { sessionId: 'direct-1' } },
      ]),
      activeTabId: 't-chat',
    },
    floating: [],
    focus: { zone: 'tiled', leafId: 'a' },
  }));
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [aDirect()],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: 'direct-1' }));
  runtime.terminals = [aTerminal('term-kept', '2026-09-23T01:00:00.000Z')];
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  expect(host.querySelector('.wb-tab-button[aria-selected="true"]')?.textContent?.trim()).not.toBe('real-bot');
  runtime.paneOpener?.({ kind: 'terminal', terminalId: null });
  await settle();
  expect(host.querySelector('.wb-tab-button[aria-selected="true"]')?.textContent?.trim()).toBe('real-bot');
  expect(runtime.calls.filter((call) => call.name === 'startTerminal')).toHaveLength(0);
  localStorage.removeItem('real-bot-workbench-layout');
});

test('a terminal tab remembers which directory its shell was opened in', async () => {
  localStorage.removeItem('real-bot-workbench-layout');
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [aDirect()],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: 'direct-1' }));
  runtime.startTerminal = async () => {
    const row = { ...aTerminal('term-1', '2026-09-23T01:00:00.000Z'), cwd: '/fixture/work' };
    runtime.terminals = [...runtime.terminals, row];
    return row;
  };
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  click(host.querySelector('.wb-new-tab'));
  click(buttonByText(document.body, 'New terminal'));
  await settle();
  // The directory travels with the tab, which is where a restart opens the shell again.
  expect(storedTabs().filter((tab) => tab.kind === 'terminal').map((tab) => tab.params)).toEqual([
    { terminalId: 'term-1', cwd: '/fixture/work' },
  ]);
  localStorage.removeItem('real-bot-workbench-layout');
});

test('terminal tabs survive a restart: the list is read on connect, and nothing is dropped before it is', async () => {
  localStorage.setItem('real-bot-workbench-layout', JSON.stringify({
    version: 1,
    root: makeLeaf('a', [{ id: 't-term', kind: 'terminal', params: { terminalId: 'term-kept' } }]),
    floating: [],
    focus: { zone: 'tiled', leafId: 'a' },
  }));
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [aDirect()],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: 'direct-1' }));
  runtime.terminalsLoaded = false;
  const { close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  expect(storedTabs().map((tab) => tab.params.terminalId)).toEqual(['term-kept']);
  expect(runtime.calls.filter((call) => call.name === 'refreshTerminals').length).toBeGreaterThan(0);
  localStorage.removeItem('real-bot-workbench-layout');
});
