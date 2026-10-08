import { afterEach, expect, test } from 'bun:test';
import { flushSync } from 'svelte';
import { USER_MEMBER, type TaskTrace } from '@real-bot/protocol';
import { emptySnapshot } from './snapshot.ts';
import { aBot, aDirect, aGroup, aMessage, fakeRuntime } from './test-fixtures.ts';
import { reactive } from './test-reactive.svelte.ts';
import { click, render } from './test-render.ts';
import { copyFor } from './copy.ts';
import { makeBranch, makeLeaf } from './workbench/layout-tree.ts';
import { PINNED_STORAGE_KEY } from './sidebar/pinned-sessions.ts';
import { forgetKeptBoards } from './overlays/task-trace.ts';
import { settle } from './test-async.ts';
import { aTerminal, loadShell, menuRow, storedTabs } from './test-shell-kit.ts';

const Shell = await loadShell();

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

test('on the workbench, Bot settings slide over the conversation with a scrim, not as a tab, and the model log has no entry', async () => {
  localStorage.removeItem('real-bot-workbench-layout');
  const session = aDirect();
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [session],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true },
  }, { selectedId: session.id }));
  const t = copyFor('en');
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  // The workbench's own tabs; the Bot's profile has a tab row of its own.
  const tabs = () => host.querySelectorAll('.wb-tab-button').length;
  const pane = () => host.querySelector('.pane-chat')!;
  const scrim = () => pane().querySelector<HTMLElement>('.pane-side-scrim');
  const dispatch = (el: Element | null | undefined, type: string) =>
    el?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  // The tab is the header: the conversation itself has none.
  expect(pane().querySelector('.top')).toBeNull();
  expect(tabs()).toBe(1);

  click(host.querySelector('.wb-tab-more'));
  click(document.querySelector('[data-action="settings"]'));
  await settle();
  expect(tabs()).toBe(1);
  expect(scrim()?.querySelector('.pane-side .profile-pane')).not.toBeNull();
  click(host.querySelector('.wb-tab-more'));
  expect(document.querySelector('[data-action="settings"]')?.classList.contains('is-active')).toBe(true);
  click(document.body);
  // Not the narrow drawer over the window: the flags it runs on stay down.
  expect(host.querySelector('.profile-backdrop')).toBeNull();
  expect(runtime.sessionSettingsOpen).toBe(false);

  // A text selection dragged out of the sidebar onto the scrim is not a click on the scrim.
  dispatch(pane().querySelector('.pane-side .profile-pane'), 'mousedown');
  dispatch(scrim(), 'click');
  await settle();
  expect(scrim()).not.toBeNull();
  // A real click on the scrim closes it.
  dispatch(scrim(), 'mousedown');
  dispatch(scrim(), 'click');
  await settle();
  expect(scrim()).toBeNull();
  expect(tabs()).toBe(1);

  // The sidebar's own ✕ closes it too.
  click(host.querySelector('.wb-tab-more'));
  click(document.querySelector('[data-action="settings"]'));
  await settle();
  click(pane().querySelector('.pane-side .sheet-close'));
  await settle();
  expect(scrim()).toBeNull();
  expect(tabs()).toBe(1);
  // Model choices are read on the flow board's cards; the tab's ⋯ has no log of its own.
  click(host.querySelector('.wb-tab-more'));
  expect([...document.querySelectorAll('[data-action]')].map((row) => row.textContent))
    .not.toContain('Model choice log');
});

test('group settings beside one pane keep their own draft when the keyboard moves to another', async () => {
  const group = aGroup({ id: 'g1', name: 'Alpha group' });
  const direct = aDirect({ id: 'd1' });
  localStorage.setItem('real-bot-workbench-layout', JSON.stringify({
    version: 1,
    root: makeBranch('r', 'row', [
      makeLeaf('a', [{ id: 't-a', kind: 'chat', params: { sessionId: 'g1', side: 'settings' } }]),
      makeLeaf('b', [{ id: 't-b', kind: 'chat', params: { sessionId: 'd1' } }]),
    ]),
    floating: [],
    focus: { zone: 'tiled', leafId: 'b' },
  }));
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [group, direct],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true },
  }, { selectedId: 'd1' }));
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  const name = host.querySelector<HTMLInputElement>('[data-leaf="a"] .pane-side #detail-group-name');
  expect(name?.value).toBe('Alpha group');
  expect(host.querySelector('[data-leaf="b"] .pane-side')).toBeNull();
  localStorage.removeItem('real-bot-workbench-layout');
});

test('a Bot picked in a group opens straight to its settings, with no way back to the group\'s', async () => {
  localStorage.removeItem('real-bot-workbench-layout');
  const group = aGroup({ id: 'g1', name: 'Alpha group' });
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [group],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true },
  }, { selectedId: 'g1' }));
  const t = copyFor('en');
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  const side = () => host.querySelector('.pane-chat .pane-side');
  const openGroupSettings = () => {
    click(host.querySelector('.wb-tab-more'));
    click(document.querySelector('[data-action="settings"]'));
  };
  openGroupSettings();
  await settle();
  expect(side()?.querySelector<HTMLInputElement>('.sheet-head #detail-group-name')?.value).toBe('Alpha group');
  click(side()?.querySelector('.member-name-btn'));
  await settle();
  expect(side()?.querySelector('.profile-pane')).not.toBeNull();
  expect(side()?.querySelector('.sheet-head h2')?.textContent).toBe(t.detail.titleBot);
  expect(side()?.querySelector('.sheet-back')).toBeNull();
  expect(side()?.getAttribute('aria-label')).toBe(t.top.botSettings);
  // A member's settings are not the group's own, so the tab's ⋯ does not mark them open.
  click(host.querySelector('.wb-tab-more'));
  expect(document.querySelector('[data-action="settings"]')?.classList.contains('is-active')).toBe(false);
  expect(host.querySelectorAll('.wb-tab-button')).toHaveLength(1);
});

test('a direct conversation\'s Bot, opened from the transcript, is that conversation\'s own settings', async () => {
  localStorage.removeItem('real-bot-workbench-layout');
  const session = aDirect();
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [session],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true },
  }, { selectedId: session.id }));
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  // What clicking the Bot's avatar asks for.
  runtime.paneOpener?.({ kind: 'chat', sessionId: session.id, side: { kind: 'settings', botId: 'bot-1' } });
  await settle();
  expect(host.querySelector('.pane-chat .pane-side .profile-pane')).not.toBeNull();
  click(host.querySelector('.wb-tab-more'));
  expect(document.querySelector('[data-action="settings"]')?.classList.contains('is-active')).toBe(true);
  expect(JSON.parse(localStorage.getItem('real-bot-workbench-layout')!).root.tabs[0].params)
    .toEqual({ sessionId: session.id, side: 'settings' });
});

test('a conversation tab offers its header\'s actions, each on that tab\'s own conversation', async () => {
  localStorage.removeItem(PINNED_STORAGE_KEY);
  const group = aGroup({ id: 'g1', name: 'Alpha group' });
  const direct = aDirect({ id: 'd1' });
  localStorage.setItem('real-bot-workbench-layout', JSON.stringify({
    version: 1,
    root: { ...makeLeaf('a', [
      { id: 't-g', kind: 'chat', params: { sessionId: 'g1' } },
      { id: 't-d', kind: 'chat', params: { sessionId: 'd1' } },
      { id: 't-term', kind: 'terminal', params: {} },
    ]), activeTabId: 't-d' },
    floating: [],
    focus: { zone: 'tiled', leafId: 'a' },
  }));
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [group, direct],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true },
  }, { selectedId: 'd1' }));
  const t = copyFor('en');
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  const menu = () => document.querySelector<HTMLElement>('[data-testid="wb-context-menu"]');
  const actions = () => [...(menu()?.querySelectorAll<HTMLElement>('[data-action]') ?? [])]
    .map((row) => row.querySelector('.wb-context-label')?.textContent);
  const rightClick = (el: Element | null) => {
    el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 12 }));
    flushSync();
  };

  // A terminal tab has nothing of a conversation's to offer: no ⋯, and a plain right-click.
  expect(host.querySelector('[data-tab="t-term"] .wb-tab-more')).toBeNull();
  rightClick(host.querySelector('[data-tab="t-term"] [role="tab"]'));
  expect(actions()).toEqual([]);
  click(document.body);
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  flushSync();

  // The group's tab is not the one in front; its settings bring it forward and open over it.
  click(host.querySelector('[data-tab="t-g"] .wb-tab-more'));
  expect(actions()).toEqual([t.top.pin, t.trace.topAction, t.top.groupSettings]);
  click(menu()!.querySelector('[data-action="settings"]'));
  await settle();
  expect(host.querySelector('[data-tab="t-g"] [role="tab"]')?.getAttribute('aria-selected')).toBe('true');
  expect(host.querySelector<HTMLInputElement>('.pane-side #detail-group-name')?.value).toBe('Alpha group');
  click(host.querySelector('[data-tab="t-g"] .wb-tab-more'));
  expect(menu()!.querySelector('[data-action="settings"]')?.classList.contains('is-active')).toBe(true);
  click(menu()!.querySelector('[data-action="settings"]'));
  await settle();
  expect(host.querySelector('.pane-side')).toBeNull();

  // Pinning from a right-click on the direct tab pins that conversation, and the menu then says so.
  rightClick(host.querySelector('[data-tab="t-d"] [role="tab"]'));
  expect(actions()).toEqual([t.top.pin, t.trace.topAction, t.top.botSettings]);
  expect(menu()!.querySelector('[data-split]')).not.toBeNull();
  click(menu()!.querySelector('[data-action="pin"]'));
  expect(JSON.parse(localStorage.getItem(PINNED_STORAGE_KEY) ?? '[]')).toEqual(['d1']);
  rightClick(host.querySelector('[data-tab="t-d"] [role="tab"]'));
  expect(actions()[0]).toBe(t.top.unpin);
  expect(menu()!.querySelector('[data-action="pin"]')?.classList.contains('is-active')).toBe(true);

  // The flow board is the tab's conversation's, whichever one the keyboard was in.
  click(menu()!.querySelector('[data-action="trace"]'));
  await settle();
  const labels = [...host.querySelectorAll('.wb-tab-button')].map((tab) => tab.textContent?.trim());
  expect(labels).toContain(t.pane.flowOf('Researcher'));
  localStorage.removeItem('real-bot-workbench-layout');
  localStorage.removeItem(PINNED_STORAGE_KEY);
});

test('a conversation’s flow board and artifact preview are named after the conversation', async () => {
  const group = aGroup({ id: 'g1', name: '视频组' });
  localStorage.setItem('real-bot-workbench-layout', JSON.stringify({
    version: 1,
    root: makeLeaf('a', [
      { id: 't-chat', kind: 'chat', params: { sessionId: 'direct-1' } },
      { id: 't-trace', kind: 'trace', params: { sessionId: 'direct-1', taskId: 'task-7' } },
      { id: 't-preview', kind: 'preview', params: { sessionId: 'direct-1', relpath: 'work/notes.md' } },
      { id: 't-group', kind: 'trace', params: { sessionId: 'g1', taskId: 'task-9' } },
    ]),
    floating: [],
    focus: { zone: 'tiled', leafId: 'a' },
  }));
  const runtime = reactive(fakeRuntime({
    bots: [aBot({ name: 'Researcher' })], sessions: [aDirect(), group],
    settings: { ...emptySnapshot().settings, locale: 'zh', wizard_complete: true },
  }, { selectedId: 'direct-1' }));
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  const labels = [...host.querySelectorAll('.wb-tab-button')].map((tab) => tab.textContent?.trim());
  const t = copyFor('zh');
  expect(labels).toEqual([
    'Researcher',
    t.pane.flowOf('Researcher'),
    t.pane.artifactsOf('Researcher'),
    t.pane.flowOf('视频组'),
  ]);
  // Switching the file the preview shows does not rename its tab.
  const titles = () => [...host.querySelectorAll('.wb-tab-button')].map((tab) => tab.textContent?.trim());
  const before = titles();
  runtime.paneOpener?.({
    kind: 'preview',
    sessionId: 'direct-1',
    relpath: 'work/other.pdf',
    attachmentId: null,
  });
  await settle();
  expect(titles()).toEqual(before);
  localStorage.removeItem('real-bot-workbench-layout');
});

test('a floating pane left low in the window stays where it was put', async () => {
  // The clean-up that runs on every snapshot bounded floating panes by a guessed 800px height,
  // so in a taller window a pane dragged near the bottom was pulled up by the next message.
  const frame = { x: 300, y: 900, width: 420, height: 320 };
  localStorage.setItem('real-bot-workbench-layout', JSON.stringify({
    version: 1,
    root: makeLeaf('a', [{ id: 't-a', kind: 'spend', params: {} }]),
    floating: [{ leaf: makeLeaf('f', [{ id: 't-f', kind: 'routines', params: {} }]), frame }],
    focus: { zone: 'tiled', leafId: 'a' },
  }));
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [aDirect()],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true },
  }, { selectedId: 'direct-1' }));
  const { close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  const saved = JSON.parse(localStorage.getItem('real-bot-workbench-layout')!);
  expect(saved.floating.map((pane: { frame: unknown }) => pane.frame)).toEqual([frame]);
  localStorage.removeItem('real-bot-workbench-layout');
});

test('a flow board in a pane keeps itself current by watching its job', async () => {
  localStorage.setItem('real-bot-workbench-layout', JSON.stringify({
    version: 1,
    root: makeLeaf('a', [{ id: 't-a', kind: 'trace', params: { sessionId: 'direct-1', taskId: 'task-7' } }]),
    floating: [],
    focus: { zone: 'tiled', leafId: 'a' },
  }));
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [aDirect()],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true },
  }, { selectedId: 'direct-1' }));
  const { close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  expect(runtime.calls.filter((call) => call.name === 'watchTrace').map((call) => call.args)).toEqual([['task-7']]);
  localStorage.removeItem('real-bot-workbench-layout');
});

test('each conversation’s flow board tab comes back where it was left when brought forward again', async () => {
  // Two boards in one pane: the tab strip swapped one conversation's board for the other's in the
  // same component, and coming back opened it afresh instead of where you had been reading.
  localStorage.setItem('real-bot-workbench-layout', JSON.stringify({
    version: 1,
    root: makeLeaf('a', [
      { id: 't-one', kind: 'trace', params: { sessionId: 'direct-1', taskId: 'task-1' } },
      { id: 't-two', kind: 'trace', params: { sessionId: 'g1', taskId: 'task-9' } },
    ]),
    floating: [],
    focus: { zone: 'tiled', leafId: 'a' },
  }));
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains('trace-viewport')) {
      return { x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON() { return {}; } } as DOMRect;
    }
    return rect.call(this);
  };
  cleanups.push(() => {
    HTMLElement.prototype.getBoundingClientRect = rect;
    forgetKeptBoards();
    localStorage.removeItem('real-bot-workbench-layout');
  });
  const job = (id: string, session_id: string) => ({
    id, dir: `work/${id}`, title: id, session_id, closed_at: null,
    last_activity_at: '2026-09-22T00:00:00.000Z', goal: null, kind: null, status: 'active' as const,
    ticket_counts: { todo: 0, doing: 0, review: 0, done: 0, parked: 0 },
  });
  const trace = (id: string, session_id: string): TaskTrace => ({
    ...job(id, session_id),
    nodes: [0, 1, 2].flatMap((round) => [
      {
        turn_id: `user:${id}-${round}`, session_id, actor: USER_MEMBER, status: 'completed' as const,
        woken_by_turn_id: null, woken_elsewhere: null, ticket_id: null,
        trigger_message_id: `${id}-${round}`, focus_message_id: `${id}-${round}`, summary: `round ${round}`,
        created_at: `2026-09-22T00:0${round}:00.000Z`, artifacts: [], ask: null, approval: null, passed: 0,
      },
      {
        turn_id: `${id}-bot-${round}`, session_id, actor: 'bot-1', status: 'completed' as const,
        woken_by_turn_id: `user:${id}-${round}`, woken_elsewhere: null, ticket_id: null,
        trigger_message_id: `${id}-${round}`, focus_message_id: `${id}-reply-${round}`, summary: `reply ${round}`,
        created_at: `2026-09-22T00:0${round}:30.000Z`, artifacts: [], ask: null, approval: null, passed: 0,
      },
    ]),
  });
  const known: Record<string, unknown> = {
    // The group's tab shows an older job than its latest: bringing it forward must not swap it.
    sessionTasks: async (sessionId: string) =>
      sessionId === 'g1' ? [job('task-10', 'g1'), job('task-9', 'g1')] : [job('task-1', 'direct-1')],
    taskTrace: async (id: string) => trace(id, id === 'task-1' ? 'direct-1' : 'g1'),
    taskDetail: async () => { throw Object.assign(new Error('not found'), { status: 404 }); },
  };
  const client = new Proxy(known, {
    get: (target, key) => (typeof key !== 'string' || key === 'then' ? undefined : key in target ? target[key] : () => new Promise(() => {})),
  });
  const runtime = reactive(fakeRuntime({
    bots: [aBot({ id: 'bot-1' })], sessions: [aDirect(), aGroup({ id: 'g1', name: '视频组' })],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true },
  }, { selectedId: 'direct-1', client }));
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  const until = async (selector: string) => {
    for (let i = 0; i < 40; i += 1) {
      await settle();
      const found = host.querySelector(selector);
      if (found) return found;
    }
    throw new Error(`never saw ${selector}`);
  };
  const camera = () => host.querySelector<HTMLElement>('.trace-flow')?.style.transform ?? '';
  const heading = () => host.querySelector('.trace-titles h2')?.textContent ?? '';
  const titled = async (title: string) => {
    for (let i = 0; i < 40 && !heading().endsWith(title); i += 1) await settle();
    await until('.trace-slot');
    expect(heading()).toEndWith(title);
  };
  const tab = (index: number) => host.querySelectorAll<HTMLElement>('.wb-tab-button')[index]!;

  await titled('task-1');
  const opened = camera();
  const viewport = host.querySelector('.trace-viewport')!;
  viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 45, deltaY: 170 }));
  flushSync();
  const left = camera();
  expect(left).not.toBe(opened);

  click(tab(1));
  await titled('task-9');
  click(tab(0));
  await titled('task-1');
  expect(camera()).toBe(left);
});

test('two conversations side by side each keep their own draft, reply and send', async () => {
  const group = aGroup({ id: 'g1', name: 'Alpha group' });
  const direct = aDirect({ id: 'd1' });
  localStorage.setItem('real-bot-workbench-layout', JSON.stringify({
    version: 1,
    root: makeBranch('r', 'row', [
      makeLeaf('a', [{ id: 't-a', kind: 'chat', params: { sessionId: 'g1' } }]),
      makeLeaf('b', [{ id: 't-b', kind: 'chat', params: { sessionId: 'd1' } }]),
    ]),
    floating: [],
    focus: { zone: 'tiled', leafId: 'b' },
  }));
  const reply = aMessage({ id: 'g-msg', session_id: 'g1', kind: 'bot', author: 'bot-1', body: 'hello from the group' });
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [group, direct], messages: [reply],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true },
  }, { selectedId: 'd1' }));
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  const editorIn = (leaf: string) => host.querySelector<HTMLElement>(`[data-leaf="${leaf}"] .composer-input`)!;
  const type = (leaf: string, text: string) => {
    const editor = editorIn(leaf);
    editor.textContent = text;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
  };

  // Typing in the pane that does not have the keyboard lands in its own conversation only.
  type('a', 'for the group');
  expect(runtime.sessionView('g1').draft).toBe('for the group');
  expect(runtime.sessionView('d1').draft).toBe('');
  expect(editorIn('b').textContent).toBe('');
  type('b', 'for the direct');
  expect(editorIn('a').textContent).toBe('for the group');
  expect(runtime.sessionView('g1').draft).toBe('for the group');

  // A reply aimed in one conversation is that conversation's, and survives the keyboard moving.
  runtime.sessionView('g1').replyingToId = 'g-msg';
  await settle();
  expect(host.querySelector('[data-leaf="a"] .composer-quote-bar')).not.toBeNull();
  expect(host.querySelector('[data-leaf="b"] .composer-quote-bar')).toBeNull();

  // Sending from a pane sends that pane's conversation, whichever one is selected.
  editorIn('a').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  const sends = runtime.calls.filter((call) => call.name === 'send');
  expect(sends).toHaveLength(1);
  expect((sends[0]!.args[0] as { sessionId?: string }).sessionId).toBe('g1');
  localStorage.removeItem('real-bot-workbench-layout');
});

test('closing a pane from its context menu persists the layout and keeps its terminal available to reattach', async () => {
  localStorage.setItem('real-bot-workbench-layout', JSON.stringify({
    version: 1,
    root: makeBranch('root', 'row', [
      makeLeaf('kept', [{ id: 'chat-tab', kind: 'chat', params: { sessionId: 'direct-1' } }]),
      makeLeaf('closed', [
        { id: 'terminal-tab', kind: 'terminal', params: { terminalId: 'term-kept', cwd: '/fixture' } },
        { id: 'workspace-tab', kind: 'workspace', params: {} },
      ]),
    ]),
    floating: [], focus: { zone: 'tiled', leafId: 'kept' },
  }));
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [aDirect()],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: 'direct-1' }));
  runtime.terminals = [aTerminal('term-kept', '2026-09-23T01:00:00.000Z')];
  const { host, close } = render(Shell, { runtime });
  cleanups.push(() => { close(); localStorage.removeItem('real-bot-workbench-layout'); });
  await settle();
  host.querySelector('[data-leaf="closed"] .wb-strip')!.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: 50, clientY: 50,
  }));
  flushSync();
  click(document.querySelector('[data-close-pane]'));
  await settle();
  expect(host.querySelectorAll('.wb-leaf')).toHaveLength(1);
  expect(host.querySelector('[data-leaf="kept"]')).not.toBeNull();
  expect(storedTabs().map((tab) => tab.kind)).toEqual(['chat']);
  expect(runtime.terminals.map((row) => row.id)).toEqual(['term-kept']);
  click(host.querySelector('.wb-new-tab'));
  click(menuRow('real-bot'));
  await settle();
  expect(storedTabs().filter((tab) => tab.kind === 'terminal').map((tab) => tab.params.terminalId)).toEqual(['term-kept']);
  expect(runtime.calls.filter((call) => call.name === 'startTerminal')).toHaveLength(0);
});

test('a tab\'s right-click closes the tabs to its right, then the others, and the layout is saved', async () => {
  localStorage.setItem('real-bot-workbench-layout', JSON.stringify({
    version: 1,
    root: makeLeaf('only', [
      { id: 'workspace-tab', kind: 'workspace', params: {} },
      { id: 'chat-tab', kind: 'chat', params: { sessionId: 'direct-1' } },
      { id: 'terminal-tab', kind: 'terminal', params: { terminalId: 'term-kept', cwd: '/fixture' } },
    ]),
    floating: [], focus: { zone: 'tiled', leafId: 'only' },
  }));
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [aDirect()],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: 'direct-1' }));
  runtime.terminals = [aTerminal('term-kept', '2026-09-23T01:00:00.000Z')];
  const { host, close } = render(Shell, { runtime });
  cleanups.push(() => { close(); localStorage.removeItem('real-bot-workbench-layout'); });
  await settle();
  const rightClickTab = (id: string) => {
    host.querySelector(`[data-tab="${id}"] [role="tab"]`)!.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2, clientX: 50, clientY: 20,
    }));
    flushSync();
  };
  rightClickTab('chat-tab');
  click(document.querySelector('[data-close-tabs="right"]'));
  await settle();
  expect(storedTabs().map((tab) => tab.kind)).toEqual(['workspace', 'chat']);
  // Its shell is still there to reattach, as when the tab is closed on its own.
  expect(runtime.terminals.map((row) => row.id)).toEqual(['term-kept']);
  rightClickTab('chat-tab');
  click(document.querySelector('[data-close-tabs="others"]'));
  await settle();
  expect(storedTabs().map((tab) => tab.kind)).toEqual(['chat']);
  expect(host.querySelectorAll('.wb-leaf')).toHaveLength(1);
});
