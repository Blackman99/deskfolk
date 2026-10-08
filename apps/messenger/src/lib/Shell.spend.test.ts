import { afterEach, expect, test } from 'bun:test';
import { flushSync } from 'svelte';
import { USER_MEMBER, type SpendDetail, type SpendSummary, type TaskTrace } from '@real-bot/protocol';
import { MessengerRuntime } from './runtime.svelte.ts';
import { overlayFromFlags, sessionUrl, viewFromUrl } from './session-url.ts';
import { emptySnapshot } from './snapshot.ts';
import { aBot, aDirect, aMessage, anAttachment, fakeRuntime } from './test-fixtures.ts';
import { reactive } from './test-reactive.svelte.ts';
import { buttonByText, click, render } from './test-render.ts';
import { makeLeaf } from './workbench/layout-tree.ts';
import { WB_FALLBACK_MIN, WB_STRIP_PX, paneMin } from './workbench/pane-mins.ts';
import { settle } from './test-async.ts';
import { loadShell, storedTabs } from './test-shell-kit.ts';

const Shell = await loadShell();

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

function spendRuntime(): MessengerRuntime {
  const runtime = new MessengerRuntime();
  runtime.snapshot = {
    ...emptySnapshot(), bots: [aBot()], sessions: [aDirect()],
    messages: [aMessage({ id: 'spend-trigger', session_id: 'direct-1', body: 'Ledger trigger' })],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  };
  runtime.connection = 'connected';
  runtime.selectedId = 'direct-1';
  cleanups.push(() => runtime.destroy());
  return runtime;
}

function restoreSpendLayout(): void {
  localStorage.setItem('real-bot-workbench-layout', JSON.stringify({
    version: 1,
    root: { ...makeLeaf('spend-leaf', [
      { id: 'chat-tab', kind: 'chat', params: { sessionId: 'direct-1' } },
      { id: 'spend-tab', kind: 'spend', params: {} },
    ]), activeTabId: 'spend-tab' },
    floating: [], focus: { zone: 'tiled', leafId: 'spend-leaf' },
  }));
  cleanups.push(() => localStorage.removeItem('real-bot-workbench-layout'));
}

function navigationUrl(runtime: MessengerRuntime): string | null {
  return sessionUrl(new URL('http://localhost/'), {
    selectedId: runtime.selectedId, previewRelpath: runtime.previewRelpath,
    previewAttachmentId: runtime.previewAttachmentId, overlay: overlayFromFlags(runtime),
  });
}

test('sidebar tools reopen the existing calendar and spend tabs', async () => {
  localStorage.removeItem('real-bot-workbench-layout');
  const runtime = spendRuntime();
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  await settle();
  for (const title of ['Routines', 'Spend', 'Routines', 'Spend']) {
    click(host.querySelector('.foot .tools-entry'));
    click(buttonByText(host.querySelector('.tools-menu') as HTMLElement, title));
    await settle();
    expect(host.querySelector('.wb-tab-button[aria-selected="true"]')?.textContent?.trim()).toBe(title);
    expect(host.querySelector('.tools-menu')).toBeNull();
    expect(host.querySelector('.foot .tools-entry')?.getAttribute('aria-expanded')).toBe('false');
  }
  expect(storedTabs().filter((tab) => tab.kind === 'routines')).toHaveLength(1);
  expect(storedTabs().filter((tab) => tab.kind === 'spend')).toHaveLength(1);
});

test('mounted Shell restores Spend in front of its selected conversation and mirrors its URL', async () => {
  restoreSpendLayout();
  const runtime = spendRuntime();
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  await settle();
  expect(host.querySelector('.wb-tab-button[aria-selected="true"]')?.textContent?.trim()).toBe('Spend');
  expect(host.querySelector('[data-spend-view]')).not.toBeNull();
  expect(runtime.selectedId).toBe('direct-1');
  expect(navigationUrl(runtime)).toBe('/?s=direct-1&o=spend');
  expect(JSON.parse(localStorage.getItem('real-bot-workbench-layout')!).root.activeTabId).toBe('spend-tab');
});

test('mounted Shell translates a desktop Spend URL, reuses its singleton and follows browser Back', async () => {
  localStorage.removeItem('real-bot-workbench-layout');
  const runtime = spendRuntime();
  const wanted = viewFromUrl(new URL('http://localhost/?s=direct-1&o=spend'));
  runtime.applyOverlay(wanted.overlay);
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  await settle();
  expect(host.querySelector('[data-spend-view]')).not.toBeNull();
  runtime.openSpend(); runtime.openSpend(); flushSync();
  expect(storedTabs().filter((tab) => tab.kind === 'spend')).toHaveLength(1);
  expect(navigationUrl(runtime)).toBe('/?s=direct-1&o=spend');
  runtime.applyOverlay({ kind: 'none' }); flushSync();
  expect(host.querySelector('.pane-conversation')).not.toBeNull();
  expect(navigationUrl(runtime)).toBe('/?s=direct-1');
  runtime.applyOverlay(wanted.overlay); await settle();
  expect(host.querySelector('[data-spend-view]')).not.toBeNull();
  expect(storedTabs().filter((tab) => tab.kind === 'spend')).toHaveLength(1);
  click([...host.querySelectorAll('.wb-tab-button')].find((tab) => tab.textContent?.trim() === 'Researcher'));
  expect(navigationUrl(runtime)).toBe('/?s=direct-1');
});

test('mounted Shell Spend detail opens the already selected chat and retains its trigger highlight', async () => {
  restoreSpendLayout();
  const runtime = spendRuntime();
  const totals: SpendSummary['totals'] = {
    calls: 1, input_tokens: 10, cached_tokens: null, output_tokens: 5, reasoning_tokens: null,
    total_tokens: 15, reported_usd_ticks: null, estimated_usd_ticks: null,
    reported_calls: 0, estimated_calls: 0, missing_calls: 1, missing_usage_calls: 0,
  };
  const detail: SpendDetail = {
    id: 'spend-row', session_id: 'direct-1', session_name: 'Researcher', session_deleted: false,
    bot_id: 'bot-1', bot_name: 'Researcher', bot_deleted: false,
    turn_id: null, judgement_id: null, kind: 'turn', chain_id: null,
    provider_id: null, provider_name: null, model: null, thinking_level: null,
    input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_tokens: null, reasoning_tokens: null,
    cost_usd_ticks: null, estimated_cost_usd_ticks: null, missing_reason: null,
    created_at: '2026-09-24T01:00:00.000Z', trigger_message_id: 'spend-trigger',
  };
  Object.defineProperty(runtime, 'client', { value: {
    kind: 'local', spendSummary: async () => ({ totals, groups: [], categories: [] }),
    spendPage: async () => ({ items: [detail], next: null }),
  } });
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  for (let i = 0; i < 100 && !host.querySelector('[data-spend-view]'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10)); flushSync();
  }
  expect(host.querySelector('[data-spend-view]')).not.toBeNull();
  click([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.trim() === 'Call details'));
  for (let i = 0; i < 100 && !host.querySelector('time[datetime]'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10)); flushSync();
  }
  const stamp = host.querySelector(`time[datetime="${detail.created_at}"]`);
  expect(stamp).not.toBeNull();
  expect(host.textContent).not.toContain(detail.created_at);
  click(stamp?.closest('tr')?.querySelector('button'));
  await settle();
  expect(host.querySelector('.pane-conversation')).not.toBeNull();
  expect(host.querySelector('[data-spend-view]')).toBeNull();
  expect(runtime.selectedId).toBe('direct-1');
  expect(runtime.highlightedMessageId).toBe('spend-trigger');
  expect(navigationUrl(runtime)).toBe('/?s=direct-1');
  expect(storedTabs().filter((tab) => tab.kind === 'chat')).toHaveLength(1);
});

test('a Spend pane keeps its own floor instead of the unknown-kind fallback', () => {
  const spend = paneMin({ id: 'spend-tab', kind: 'spend', params: {} });
  expect(spend).toEqual({ width: 280, height: 220 + WB_STRIP_PX });
  expect(spend.width).toBeGreaterThan(WB_FALLBACK_MIN.width);
  expect(spend.height).toBeGreaterThan(WB_FALLBACK_MIN.height);
  expect(paneMin(null)).toEqual(WB_FALLBACK_MIN);
  expect(paneMin({ id: 'unknown-tab', kind: 'unknown', params: {} })).toEqual({
    width: WB_FALLBACK_MIN.width,
    height: WB_FALLBACK_MIN.height + WB_STRIP_PX,
  });
});

test('mounted Shell mobile terminal page is a history entry, and Back and Escape leave the chat underneath', async () => {
  const setViewport = (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM.setViewport.bind(
    (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM,
  );
  setViewport({ width: 390, height: 844 });
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(max-width: 680px)' || query === '(prefers-reduced-motion: reduce)',
    media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  cleanups.push(() => {
    setViewport({ width: 1024, height: 768 });
    window.matchMedia = previousMatchMedia;
  });
  const runtime = spendRuntime();
  runtime.openTerminal();
  const { host, app, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  expect(host.querySelector('.terminal-page')).not.toBeNull();
  expect(host.querySelector('.mobile-navigation')).toBeNull();
  expect(getComputedStyle(host.querySelector('.side')!).display).toBe('none');
  expect(navigationUrl(runtime)).toBe('/?s=direct-1&o=terminal');
  // Back is the browser's. The page's own button is what closes it.
  expect((app as { backMobileLayer: () => boolean }).backMobileLayer()).toBe(false);
  expect(runtime.terminalOpen).toBe(true);
  click(host.querySelector('.terminal-back'));
  expect(runtime.terminalOpen).toBe(false);
  expect(runtime.selectedId).toBe('direct-1');
  runtime.openTerminal();
  await settle();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();
  expect(runtime.terminalOpen).toBe(false);
  expect(navigationUrl(runtime)).toBe('/?s=direct-1');
});

test('mounted Shell mobile Spend Back and Escape leave the underlying chat and history intact', async () => {
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(max-width: 680px)' || query === '(prefers-reduced-motion: reduce)',
    media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  cleanups.push(() => { window.matchMedia = previousMatchMedia; });
  const runtime = spendRuntime(); runtime.openSpend();
  const { host, app, close } = render(Shell, { runtime }); cleanups.push(close);
  await settle();
  expect(host.querySelector('.spend-page [data-spend-view]')).not.toBeNull();
  expect((app as { backMobileLayer: () => boolean }).backMobileLayer()).toBe(false);
  expect(runtime.spendOpen).toBe(true);
  click(host.querySelector('.spend-page button[aria-label="Back"]'));
  expect(runtime.spendOpen).toBe(false);
  expect(runtime.selectedId).toBe('direct-1');
  runtime.openSpend(); await settle();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); flushSync();
  expect(runtime.spendOpen).toBe(false);
  expect(navigationUrl(runtime)).toBe('/?s=direct-1');
  runtime.openRoutines(); flushSync();
  expect(runtime.spendOpen).toBe(false);
  expect(runtime.routinesOpen).toBe(true);
  runtime.openSpend(); runtime.openWorkspace(); flushSync();
  expect(runtime.spendOpen).toBe(false);
  expect(runtime.workspaceOpen).toBe(true);
});

test('mounted Shell phone flow page: a file opened on it goes at the first Back, and a card leaves the page for its message', async () => {
  const setViewport = (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM.setViewport.bind(
    (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM,
  );
  setViewport({ width: 390, height: 844 });
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(max-width: 680px)' || query === '(prefers-reduced-motion: reduce)',
    media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  cleanups.push(() => {
    setViewport({ width: 1024, height: 768 });
    window.matchMedia = previousMatchMedia;
  });
  const runtime = spendRuntime();
  const job = {
    id: 'task-1', dir: 'work/a', title: 'Storyboard', session_id: 'direct-1', closed_at: null,
    last_activity_at: '2026-09-22T00:00:00.000Z', goal: null, kind: null, status: 'active',
    ticket_counts: { todo: 0, doing: 0, review: 0, done: 0, parked: 0 },
  };
  const trace: TaskTrace = {
    id: 'task-1', dir: 'work/a', title: 'Storyboard', session_id: 'direct-1', closed_at: null,
    nodes: [{
      turn_id: 'user:spend-trigger', session_id: 'direct-1', actor: USER_MEMBER, status: 'completed',
      woken_by_turn_id: null, woken_elsewhere: null, ticket_id: null,
      trigger_message_id: 'spend-trigger', focus_message_id: 'spend-trigger', summary: 'Ledger trigger',
      created_at: '2026-09-22T00:00:00.000Z',
      artifacts: [{ path: 'work/a/board.md', message_id: 'spend-trigger', attachment_id: 'att-board' }],
      ask: null, approval: null, passed: 0,
    }],
  };
  // The board reads its job; whatever else is asked of the daemon here never answers.
  const known: Record<string, unknown> = {
    kind: 'local',
    sessionTasks: async () => [job],
    taskTrace: async () => trace,
    taskDetail: async () => { throw Object.assign(new Error('not found'), { status: 404 }); },
  };
  (runtime as unknown as { api: unknown }).api = new Proxy(known, {
    get: (target, key) => (typeof key !== 'string' || key === 'then' ? undefined : key in target ? target[key] : () => new Promise(() => {})),
  });
  const { host, app, close } = render(Shell, { runtime }); cleanups.push(close);
  const back = (app as { backMobileLayer: () => boolean }).backMobileLayer;
  const until = async (selector: string) => {
    for (let i = 0; i < 40; i += 1) {
      await settle();
      const found = host.querySelector(selector);
      if (found) return found;
    }
    throw new Error(`never saw ${selector}`);
  };

  runtime.openTrace();
  // The job it settles on is written into the page's own entry (mobile-route.ts rewrites it).
  click(await until('.trace-page .trace-file'));
  await settle();
  expect(navigationUrl(runtime)).toBe('/?s=direct-1&p=work%2Fa%2Fboard.md&o=trace&k=task-1');
  await until('.artifact-pane');
  // The file lies over the page with no entry of its own, so Back puts it away and stays on the flow.
  expect(back()).toBe(true);
  flushSync();
  expect(runtime.previewRelpath).toBeNull();
  expect(runtime.traceOpen).toBe(true);
  expect(navigationUrl(runtime)).toBe('/?s=direct-1&o=trace&k=task-1');
  // The next Back is history's: it leaves the flow for the conversation.
  expect(back()).toBe(false);
  // Escape walks the same way. A real key lands on an element, which the preview's branch reads.
  click(host.querySelector('.trace-page .trace-file'));
  await until('.artifact-pane');
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); flushSync();
  expect(runtime.previewRelpath).toBeNull();
  expect(runtime.traceOpen).toBe(true);

  // The page covers the conversation, so a card shows its message by closing the page.
  click(host.querySelector('.trace-page .trace-card-main'));
  flushSync();
  expect(runtime.traceOpen).toBe(false);
  expect(runtime.selectedId).toBe('direct-1');
  expect(runtime.highlightedMessageId).toBe('spend-trigger');
  expect(navigationUrl(runtime)).toBe('/?s=direct-1');
});

/**
 * A hosted tablet: the window is wider than a phone, but the app is still the phone flow — the
 * same shape a paired phone has, just on more glass. The artifact pane there is a screen of its
 * own, like the phone's, not a column beside the chat: there is no workbench tab to close a
 * column, and for a while there was no other way out at all.
 */
test('the phone flow on a wide window opens the artifact pane as its own screen and closes from its bar', async () => {
  const setViewport = (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM.setViewport.bind(
    (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM,
  );
  setViewport({ width: 1024, height: 768 });
  // The JS reads "narrow" (the hosted gate, mocked here through the same query the shell watches)
  // while the stylesheet's own media queries see the real 1024px, which is exactly the split a
  // hosted tablet lives in.
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(max-width: 680px)' || query === '(prefers-reduced-motion: reduce)',
    media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  cleanups.push(() => {
    setViewport({ width: 1024, height: 768 });
    window.matchMedia = previousMatchMedia;
  });
  const session = aDirect();
  const attachments = ['plan.md', 'notes.md'].map((name, i) => anAttachment({
    id: `wide-att-${i}`, message_id: 'wide-message', workspace_relpath: `work/${name}`,
    original_filename: name, mime: 'text/markdown',
  }));
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [session],
    messages: [aMessage({ id: 'wide-message', session_id: session.id, kind: 'bot', author: 'bot-1', attachments })],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: session.id }));
  runtime.client = {
    kind: 'local',
    getWorkspaceFileBlob: async () => new Blob(['# file'], { type: 'text/markdown' }),
    getAttachmentBlob: async () => new Blob(['# file'], { type: 'text/markdown' }),
  } as never;
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  click(host.querySelector('.attachment-bundle-btn'));
  await settle();
  await settle();
  expect(runtime.previewRelpath).toBe('work/plan.md');
  // A screen of its own: over everything, with no column carved out of the conversation beside it.
  const pane = host.querySelector<HTMLElement>('.artifact-pane')!;
  expect(getComputedStyle(pane).position).toBe('fixed');
  expect(host.querySelector('.preview-split')).toBeNull();
  // The phone's bar: the way back is in the pane, where the wide workbench has it on a tab.
  const head = host.querySelector<HTMLElement>('.artifact-pane-head')!;
  expect(getComputedStyle(head).display).toBe('flex');
  click(host.querySelector('.artifact-back'));
  await settle();
  expect(runtime.previewRelpath).toBeNull();
  expect(host.querySelector('.artifact-pane')).toBeNull();
});
