import { afterEach, expect, test } from 'bun:test';
import { flushSync } from 'svelte';
import { emptySnapshot } from './snapshot.ts';
import { aBot, aDirect, aGroup, aRoutine, fakeRuntime } from './test-fixtures.ts';
import { reactive } from './test-reactive.svelte.ts';
import { click, render } from './test-render.ts';
import { makeLeaf } from './workbench/layout-tree.ts';
import { settle } from './test-async.ts';
import { loadShell, storedTabs } from './test-shell-kit.ts';

const Shell = await loadShell();

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

test('the session list folds to a rail of avatars from its own button or ⌘B, and is remembered', async () => {
  localStorage.setItem('real-bot-sidebar-width', '320');
  localStorage.setItem('real-bot-workbench-layout', JSON.stringify({
    version: 1,
    root: makeLeaf('only', [{ id: 'chat-tab', kind: 'chat', params: { sessionId: 'direct-1' } }]),
    floating: [], focus: { zone: 'tiled', leafId: 'only' },
  }));
  cleanups.push(() => {
    for (const key of ['real-bot-sidebar-width', 'real-bot-sidebar-collapsed', 'real-bot-workbench-layout']) localStorage.removeItem(key);
  });
  const runtime = reactive(fakeRuntime({
    bots: [aBot()],
    sessions: [aDirect(), aGroup({ id: 'sess-2', name: 'Crew', unread_count: 3 })],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: 'direct-1' }));
  let mounted = render(Shell, { runtime });
  cleanups.push(() => mounted.close());
  await settle();
  const shell = () => mounted.host.querySelector('.shell') as HTMLElement;
  const collapse = () => mounted.host.querySelector('.side .brand-row .side-collapse') as HTMLButtonElement | null;
  const expand = () => mounted.host.querySelector('.rail .rail-expand') as HTMLButtonElement | null;

  expect(collapse()?.getAttribute('aria-label')).toBe('Hide the session list');
  expect(mounted.host.querySelector('.rail')).toBeNull();

  collapse()!.focus();
  click(collapse());
  await settle();
  expect(shell().classList.contains('is-sidebar-collapsed')).toBe(true);
  expect(mounted.host.querySelector('.side')).toBeNull();
  expect(shell().style.getPropertyValue('--sidebar-width')).toBe('64px');
  expect(shell().style.getPropertyValue('--sidebar-split')).toBe('0px');
  expect(document.activeElement).toBe(expand());
  expect([...mounted.host.querySelectorAll<HTMLElement>('.rail-item')].map((el) => el.dataset.session)).toEqual(['sess-2', 'direct-1']);
  expect(mounted.host.querySelector('.rail-item[data-session="sess-2"] .rail-badge')?.textContent).toBe('3');
  expect(localStorage.getItem('real-bot-sidebar-collapsed')).toBe('1');

  // The list's footer follows it down as icons, in the same order.
  const railFoot = () => [...mounted.host.querySelectorAll<HTMLButtonElement>('.rail-foot button')];
  expect(railFoot().map((button) => button.getAttribute('aria-label'))).toEqual(['Workspace', 'Tools', 'Settings']);
  expect(railFoot()[0].disabled).toBe(false);
  click(railFoot()[1]);
  await settle();
  expect(mounted.host.querySelector('.tools-menu')).not.toBeNull();
  // Escape is the shell's: it closes the menu first and leaves the list folded.
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  flushSync();
  expect(mounted.host.querySelector('.tools-menu')).toBeNull();
  expect(shell().classList.contains('is-sidebar-collapsed')).toBe(true);
  // Archived sessions are a view of the full list: asking for them from the rail opens the list on it.
  click(railFoot()[1]);
  await settle();
  click(mounted.host.querySelector('.tools-menu-archived'));
  await settle();
  expect(mounted.host.querySelector('.rail')).toBeNull();
  expect(mounted.host.querySelector('.side .archived-empty-hint')).not.toBeNull();
  click(mounted.host.querySelector('.btn-back-sessions'));
  click(collapse());
  await settle();
  expect(mounted.host.querySelector('.rail')).not.toBeNull();

  // The rail still switches conversations.
  click(mounted.host.querySelector('.rail-item[data-session="sess-2"]'));
  expect(runtime.calls.filter((call) => call.name === 'selectSession').map((call) => call.args[0])).toContain('sess-2');

  click(expand());
  await settle();
  expect(shell().classList.contains('is-sidebar-collapsed')).toBe(false);
  expect(mounted.host.querySelector('.rail')).toBeNull();
  expect(shell().style.getPropertyValue('--sidebar-width')).toBe('320px');
  expect(document.activeElement).toBe(collapse());

  // Folded once more; a restart comes back folded.
  click(collapse());
  mounted.close();
  mounted = render(Shell, { runtime });
  await settle();
  expect(mounted.host.querySelector('.rail')).not.toBeNull();

  // ⌘B works while typing in the composer, and swallows the composer's own bold.
  const composer = mounted.host.querySelector('.composer-input') as HTMLElement;
  const press = new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true });
  composer.dispatchEvent(press);
  flushSync();
  expect(press.defaultPrevented).toBe(true);
  expect(shell().classList.contains('is-sidebar-collapsed')).toBe(false);
  expect(mounted.host.querySelector('.side')).not.toBeNull();
  expect(shell().style.getPropertyValue('--sidebar-split')).toBe('');
  expect(localStorage.getItem('real-bot-sidebar-collapsed')).toBeNull();
  expect(localStorage.getItem('real-bot-sidebar-width')).toBe('320');
});

test('a list that is a screen of its own does not fold, however it was left', async () => {
  const happyDOM = (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM;
  happyDOM.setViewport({ width: 390, height: 844 });
  // The breakpoint decides this, and the media query is the breakpoint, so it is what the test moves.
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(max-width: 680px)' || query === '(prefers-reduced-motion: reduce)',
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  // Folded on a tablet, where the list is a column: the same origin remembers it here.
  localStorage.setItem('real-bot-sidebar-collapsed', '1');
  cleanups.push(() => {
    window.matchMedia = previousMatchMedia;
    happyDOM.setViewport({ width: 1024, height: 768 });
    localStorage.removeItem('real-bot-sidebar-collapsed');
  });
  const runtime = reactive(fakeRuntime({
    bots: [aBot()],
    sessions: [aDirect()],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }));
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  expect(host.querySelector('.side')).not.toBeNull();
  expect(host.querySelector('.rail')).toBeNull();
  // ⌘B has nothing to fold here either.
  host.querySelector('.composer-input')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true })
  );
  flushSync();
  expect(host.querySelector('.rail')).toBeNull();
  expect(host.querySelector('.side')).not.toBeNull();
  // And what the tablet left behind stays for the tablet.
  expect(localStorage.getItem('real-bot-sidebar-collapsed')).toBe('1');
});

for (const collapsed of [false, true]) test(`global search is reachable from the ${collapsed ? 'rail' : 'list'} and keyboard without changing the layout`, async () => {
  if (collapsed) localStorage.setItem('real-bot-sidebar-collapsed', '1');
  else localStorage.removeItem('real-bot-sidebar-collapsed');
  cleanups.push(() => localStorage.removeItem('real-bot-sidebar-collapsed'));
  const runtime = reactive(fakeRuntime({ bots: [aBot()], sessions: [aDirect()], settings: { ...emptySnapshot().settings, wizard_complete: true, workspace_path: '/fixture', locale: 'en' } }));
  runtime.closeSearch = () => { runtime.searchQuery = ''; runtime.searchHits = []; };
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  await settle();
  const trigger = host.querySelector<HTMLButtonElement>(collapsed ? '.rail-search' : '.search-trigger')!;
  trigger.focus(); click(trigger);
  expect(host.querySelector('dialog[open] .global-search-input')).not.toBeNull();
  const before = localStorage.getItem('real-bot-workbench-layout');
  host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: '\\', metaKey: true }));
  flushSync();
  expect(localStorage.getItem('real-bot-workbench-layout')).toBe(before);
  host.querySelector('.global-search-input')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
  flushSync();
  expect(host.querySelector('dialog[open]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true })); flushSync();
  const input = host.querySelector<HTMLInputElement>('.global-search-input')!;
  expect(input).not.toBeNull();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true })); flushSync();
  expect(Boolean(host.querySelector('.rail'))).toBe(collapsed);
  click(host.querySelector('.search-cancel'));
  const editor = document.createElement('div'); editor.className = 'monaco-editor'; const field = document.createElement('textarea'); editor.append(field); host.append(editor);
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })); flushSync();
  expect(host.querySelector('dialog[open]')).toBeNull();
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', metaKey: true, shiftKey: true, bubbles: true, cancelable: true })); flushSync();
  expect(host.querySelector('dialog[open]')).not.toBeNull();
  click(host.querySelector('.search-cancel'));
  const editorModal = document.createElement('div'); editorModal.className = 'skill-modal-backdrop'; host.append(editorModal);
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', metaKey: true, shiftKey: true, bubbles: true, cancelable: true })); flushSync();
  expect(host.querySelector('dialog[open]')).toBeNull();
});

test('search result selection clears its modal and routes messages, files and routines through the shell', async () => {
  const runtime = reactive(fakeRuntime({ bots: [aBot()], sessions: [aDirect()], routines: [aRoutine()], settings: { ...emptySnapshot().settings, wizard_complete: true, workspace_path: '/fixture', locale: 'en' } }));
  runtime.closeSearch = () => { runtime.searchQuery = ''; runtime.searchHits = []; };
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  for (const hit of [
    { kind: 'message' as const, id: 'old-msg', session_id: 'direct-1', snippet: 'older message' },
    { kind: 'routine' as const, id: 'routine-1', snippet: 'routine' },
    { kind: 'file' as const, path: 'report.md', snippet: 'file' },
  ]) {
    click(host.querySelector('.search-trigger'));
    flushSync(() => { runtime.searchQuery = 'find'; runtime.searchHits = [hit]; });
    click(host.querySelector('.search-result'));
    await settle();
    expect(host.querySelector('dialog[open]')).toBeNull();
  }
  expect(runtime.calls.find((call) => call.name === 'selectSession')?.args).toEqual(['direct-1', { messageId: 'old-msg' }]);
  expect(runtime.calls.find((call) => call.name === 'openRoutine')?.args).toEqual(['bot-1', 'routine-1']);
  expect(storedTabs().some((tab) => tab.kind === 'preview' && tab.params.relpath === 'report.md')).toBe(true);
  localStorage.removeItem('real-bot-workbench-layout');
});

for (const action of ['Back', 'Escape'] as const) {
  test(`mounted Shell: ${action} leaves Office full screen before closing the file preview`, async () => {
    const previousMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(max-width: 680px)' || query === '(prefers-reduced-motion: reduce)',
      media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const excel = (await import('exceljs')).default;
      const book = new excel.Workbook();
      book.addWorksheet('First').getCell('A1').value = 'first-value';
      book.addWorksheet('Second').getCell('A1').value = 'kept-value';
      const blob = new Blob([new Uint8Array(await book.xlsx.writeBuffer())]);
      const session = aDirect({ id: 'office-session' });
      const runtime = reactive(fakeRuntime({
        bots: [aBot()], sessions: [session],
        settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
      }, {
        selectedId: session.id, previewRelpath: 'report.xlsx',
        client: { getWorkspaceFileBlob: async () => blob, workspaceTree: async () => ({ items: [], truncated: false }) },
      }));
      const { host, app, close } = render(Shell, { runtime }); cleanups.push(close);
      for (let i = 0; i < 100 && !host.textContent?.includes('first-value'); i++) await settle();
      const root = host.querySelector<HTMLElement>('.office-viewer');
      expect(root).not.toBeNull();
      root!.showPopover = () => {};
      root!.hidePopover = () => {};
      click([...host.querySelectorAll('button')].find(button => button.textContent === 'Second'));
      click(root!.querySelector('.office-full'));
      expect(root!.classList.contains('is-enlarged')).toBe(true);
      const back = (app as { backMobileLayer: () => boolean }).backMobileLayer;
      if (action === 'Back') expect(back()).toBe(true);
      else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      flushSync();
      expect(host.querySelector('.office-viewer')).toBe(root);
      expect(root!.classList.contains('is-enlarged')).toBe(false);
      expect(root!.textContent).toContain('kept-value');
      expect(runtime.previewRelpath).toBe('report.xlsx');
      expect(runtime.selectedId).toBe(session.id);
      expect(back()).toBe(false);
    } finally {
      window.matchMedia = previousMatchMedia;
    }
  });
}
