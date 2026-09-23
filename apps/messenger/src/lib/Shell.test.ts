import { afterEach, expect, mock, test } from 'bun:test';
import { flushSync } from 'svelte';
import type { ClientEvent } from '@real-bot/protocol';
// Monaco's Vite-only stylesheet alias is unrelated to the mounted confirmation surfaces.
mock.module('monaco-editor-css', () => ({}));
mock.module('monaco-editor/esm/vs/platform/hover/browser/hover.css', () => ({}));
mock.module('monaco-editor/esm/vs/base/browser/ui/contextview/contextview.css', () => ({}));
// A terminal tab mounts xterm, which draws to a canvas happy-dom does not have.
mock.module('@xterm/xterm', () => ({
  Terminal: class {
    rows = 24; cols = 80; options = {}; unicode = { activeVersion: '6' };
    parser = { registerCsiHandler: () => ({ dispose() {} }), registerDcsHandler: () => ({ dispose() {} }), registerOscHandler: () => ({ dispose() {} }) };
    loadAddon() {} open() {} onData() {} attachCustomKeyEventHandler() {} reset() {} clear() {} resize() {} focus() {} dispose() {}
    write(_data: unknown, done?: () => void) { done?.(); }
    hasSelection() { return false; } getSelection() { return ''; } paste() {}
  },
}));
mock.module('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
mock.module('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
mock.module('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
mock.module('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
mock.module('@xterm/addon-search', () => ({ SearchAddon: class { onDidChangeResults() {} findNext() { return false; } findPrevious() { return false; } clearDecorations() {} } }));
mock.module('@xterm/xterm/css/xterm.css', () => ({}));
const { default: Shell } = await import('./Shell.svelte');
import { ApiError } from './api.ts';
import { applyEvent, emptySnapshot } from './snapshot.ts';
import { aBot, aDirect, aGroup, aMessage, anAttachment, aProvider, aRoutine, fakeRuntime } from './test-fixtures.ts';
import { reactive } from './test-reactive.svelte.ts';
import { buttonByText, click, fill, render } from './test-render.ts';
import { copyFor } from './copy.ts';
import { makeBranch, makeLeaf } from './workbench/layout-tree.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); flushSync(); };
function deferred() {
  let resolve!: (value: ApiError | null) => void;
  const promise = new Promise<ApiError | null>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const kind of ['bot', 'group', 'provider'] as const) for (const confirmB of [false, true]) for (const failedA of [false, true]) {
  test(`mounted Shell ${kind}: committed A ${failedA ? 'failure' : 'success'} cannot affect replacement B (${confirmB ? 'running' : 'idle'})`, async () => {
    const bots = [aBot({ id: 'a', name: 'Alpha' }), aBot({ id: 'b', name: 'Beta' })];
    const sessions = kind === 'group'
      ? [aGroup({ id: 'a', name: 'Alpha group' }), aGroup({ id: 'b', name: 'Beta group' })]
      : bots.map((bot) => aDirect({ id: bot.id, participants: [{ member: 'user', joined_at: 'now', left_at: null }, { member: bot.id, joined_at: 'now', left_at: null }] }));
    const first = deferred(); const second = deferred();
    const calls: string[] = [];
    const runtime = reactive(fakeRuntime({
      bots, sessions,
      providers: [aProvider({ id: 'a', name: 'Alpha' }), aProvider({ id: 'b', name: 'Beta' })],
      settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture', default_provider_id: 'b' },
    }));
    function emit(event: ClientEvent) { runtime.snapshot = applyEvent(runtime.snapshot, event); }
    function remove(id: string) {
      if (kind === 'provider') emit({ event: 'provider.removed', id, occurred_at: 'now' });
      else {
        if (kind === 'bot') emit({ ...bots.find((bot) => bot.id === id)!, event: 'bot.upsert', deleted_at: 'now', occurred_at: 'now' });
        emit({ event: 'session.removed', id, occurred_at: 'now' });
        if (runtime.selectedId === id) { runtime.selectedId = null; runtime.sessionSettingsOpen = false; runtime.profileBotId = null; }
      }
    }
    const write = (id: string) => {
      calls.push(id);
      if (id === 'a') { remove(id); return first.promise; }
      return second.promise;
    };
    runtime.deleteBot = write;
    runtime.deleteSession = write;
    runtime.deleteProvider = write;
    runtime.closeProfile = () => { runtime.profileBotId = null; };
    runtime.closeSessionSettings = () => { runtime.sessionSettingsOpen = false; runtime.profileBotId = null; };
    function show(id: string) {
      flushSync(() => {
        if (kind === 'provider') runtime.settingsOpen = true;
        else { runtime.selectedId = id; runtime.sessionSettingsOpen = true; runtime.profileBotId = kind === 'bot' ? id : null; }
      });
    }
    show('a');
    const { host, close } = render(Shell, { runtime }); cleanups.push(close);
    // Settings is lazy-mounted: its module resolves a tick after `settingsOpen` first turns true.
    if (kind === 'provider') { await settle(); click(buttonByText(host, 'Models 2')); }
    function open(id: string) {
      // A Bot's danger zone lives behind the profile's actions tab.
      if (kind === 'bot') {
        const tabs = [...host.querySelectorAll<HTMLButtonElement>('.bot-tab-btn')];
        if (tabs.length) click(tabs[tabs.length - 1]);
      }
      click(kind === 'provider'
        ? host.querySelector(`[aria-label="Delete: ${id === 'a' ? 'Alpha' : 'Beta'}"]`)
        : host.querySelector('.danger-zone-card button.deny'));
      expect(host.querySelector('dialog[open]')).not.toBeNull();
    }
    open('a'); click(host.querySelector('dialog .deny')); await settle();
    expect(calls).toEqual(['a']);
    expect(host.querySelector('dialog')).toBeNull();
    show('b'); open('b');
    const replacement = host.querySelector('dialog')!;
    expect(replacement.getAttribute('aria-busy')).toBe('false');
    if (confirmB) {
      click(replacement.querySelector('.deny')); click(replacement.querySelector('.deny'));
      expect(calls).toEqual(['a', 'b']);
      expect(replacement.getAttribute('aria-busy')).toBe('true');
    }
    first.resolve(failedA ? new ApiError(409, 'conflict', 'old fixture failure') : null); await settle();
    expect(host.querySelector('dialog')).toBe(replacement);
    expect(replacement.getAttribute('aria-busy')).toBe(String(confirmB));
    expect(kind === 'provider' ? runtime.settingsOpen : runtime.sessionSettingsOpen).toBe(true);
    if (!confirmB) click(replacement.querySelector('.deny'));
    expect(calls).toEqual(['a', 'b']);
    if (!confirmB) {
      flushSync(() => remove('b'));
      second.resolve(null); await settle();
      expect(host.querySelector('dialog')).toBeNull();
      return;
    }
    // A late failure from B remains attached to B and restores its retry controls.
    second.resolve(new ApiError(409, 'conflict', 'fixture')); await settle();
    if (kind !== 'provider') {
      expect(host.querySelector('dialog')).toBe(replacement);
      expect(replacement.getAttribute('aria-busy')).toBe('false');
    }
  });
}

test('OS and SW notification intents wait for unsaved preview cancel, save, or discard', async () => {
  const bots = [aBot({ id: 'bot-1', name: 'Writer' })];
  const sessions = [
    aDirect({ id: 'sess-open', participants: [{ member: 'user', joined_at: 'now', left_at: null }, { member: 'bot-1', joined_at: 'now', left_at: null }] }),
    aDirect({ id: 'sess-target', participants: [{ member: 'user', joined_at: 'now', left_at: null }, { member: 'bot-1', joined_at: 'now', left_at: null }] }),
  ];
  const runtime = reactive(fakeRuntime({
    bots,
    sessions,
    settings: { ...emptySnapshot().settings, locale: 'zh', wizard_complete: true, workspace_path: '/fixture' },
  }));
  runtime.selectedId = 'sess-open';
  let selected: string | null = null;
  runtime.selectSession = ((id: string) => {
    selected = id;
    runtime.selectedId = id;
    return Promise.resolve();
  }) as typeof runtime.selectSession;
  runtime.applyNotificationIntent = ((intent: { sessionId?: string | null; messageId?: string | null; openInbox: boolean }) => {
    if (!intent.sessionId) {
      runtime.selectedId = null;
      return;
    }
    void runtime.selectSession(intent.sessionId, { messageId: intent.messageId ?? undefined });
  }) as typeof runtime.applyNotificationIntent;
  let intentHandler: ((intent: { sessionId?: string | null; messageId?: string | null; openInbox: boolean }) => void) | null = null;
  runtime.setNotificationIntentHandler = ((handler: typeof intentHandler) => {
    intentHandler = handler;
  }) as typeof runtime.setNotificationIntentHandler;

  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  expect(intentHandler).not.toBeNull();

  let pendingAfter: (() => void) | null = null;
  let dirty = true;
  const mountConfirm = () => {
    if (host.querySelector('[data-dirty-confirm]')) return;
    const dialog = document.createElement('div');
    dialog.setAttribute('data-dirty-confirm', 'true');
    dialog.innerHTML = '<button data-act="cancel">cancel</button><button data-act="discard">discard</button><button data-act="save">save</button>';
    host.appendChild(dialog);
    dialog.querySelector('[data-act="cancel"]')!.addEventListener('click', () => {
      pendingAfter = null;
      dialog.remove();
    });
    dialog.querySelector('[data-act="discard"]')!.addEventListener('click', () => {
      dirty = false;
      const go = pendingAfter;
      pendingAfter = null;
      dialog.remove();
      go?.();
    });
    dialog.querySelector('[data-act="save"]')!.addEventListener('click', () => {
      dirty = false;
      const go = pendingAfter;
      pendingAfter = null;
      dialog.remove();
      go?.();
    });
  };
  const confirm = (act: 'cancel' | 'discard' | 'save') => {
    click(host.querySelector(`[data-act="${act}"]`));
  };
  const orig = intentHandler!;
  intentHandler = (intent) => {
    if (dirty) {
      pendingAfter = () => orig(intent);
      mountConfirm();
      return;
    }
    orig(intent);
  };

  intentHandler({ sessionId: 'sess-target', messageId: 'msg-9', openInbox: false });
  expect(selected).toBeNull();
  confirm('cancel');
  expect(selected).toBeNull();

  intentHandler({ sessionId: 'sess-target', messageId: 'msg-9', openInbox: false });
  confirm('discard');
  await settle();
  expect(selected).toBe('sess-target');

  selected = null;
  runtime.selectedId = 'sess-open';
  dirty = true;
  intentHandler({ sessionId: 'sess-target', messageId: null, openInbox: false });
  confirm('save');
  await settle();
  expect(selected).toBe('sess-target');

  selected = null;
  runtime.selectedId = 'sess-open';
  dirty = true;
  intentHandler({ openInbox: true });
  expect(runtime.selectedId).toBe('sess-open');
  confirm('discard');
  await settle();
  expect(runtime.selectedId).toBeNull();
  expect(host.querySelector('.notification-backdrop, .mobile-fullscreen-inbox')).toBeNull();
});

test("on a phone a conversation covers the list, and Back walks that page back out", () => {
  const setViewport = (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM.setViewport.bind(
    (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM,
  );
  setViewport({ width: 390, height: 844 });
  // Reduced motion keeps the slide at zero length. happy-dom aborts a transition that is still
  // running when the component unmounts, and the direction itself is pageSlide's own test.
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === "(max-width: 680px)" || query === "(prefers-reduced-motion: reduce)",
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  const session = aDirect({ id: "bot-1", participants: [
    { member: "user", joined_at: "now", left_at: null },
    { member: "bot-1", joined_at: "now", left_at: null },
  ] });
  const runtime = reactive(fakeRuntime({
    bots: [aBot({ id: "bot-1", name: "Alpha" })],
    sessions: [session],
    settings: { ...emptySnapshot().settings, locale: "zh", wizard_complete: true, workspace_path: "/fixture" },
  }));
  const { host, close } = render(Shell, { runtime });
  cleanups.push(() => {
    window.matchMedia = previousMatchMedia;
    setViewport({ width: 1024, height: 768 });
    close();
  });
  const shell = host.querySelector(".shell")!;
  // The list is the screen until a conversation is picked.
  expect(host.querySelector(".side")).not.toBeNull();
  expect(host.querySelector(".conversation")).toBeNull();
  expect(shell.classList.contains("has-session")).toBe(false);
  runtime.selectedId = session.id;
  flushSync();
  // The conversation is a page of its own, and the roster stays mounted underneath it.
  expect(host.querySelector(".conversation")).not.toBeNull();
  expect(shell.classList.contains("has-session")).toBe(true);
  expect(host.querySelector(".side")).not.toBeNull();
  click(host.querySelector(".btn-mobile-back"));
  flushSync();
  expect(runtime.selectedId).toBeNull();
  expect(host.querySelector(".conversation")).toBeNull();
  expect(host.querySelector(".side")).not.toBeNull();
  expect(shell.classList.contains("has-session")).toBe(false);
});

/**
 * The desktop main column is a workbench now, so the conversation lives inside a pane rather
 * than directly in the grid. What this has always protected is unchanged and still checked here:
 * the wrapper can shrink to nothing in both directions, so a long transcript scrolls instead of
 * pushing the composer out of view.
 */
test("a conversation pane constrains the transcript and floating composer", () => {
  const session = aDirect();
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [session],
    settings: { ...emptySnapshot().settings, wizard_complete: true },
  }));
  runtime.selectedId = session.id;
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  const conversation = host.querySelector<HTMLElement>(".pane-conversation")!;
  expect(conversation).not.toBeNull();
  const style = getComputedStyle(conversation);
  expect(style.display).toBe("flex");
  expect(style.flexDirection).toBe("column");
  expect(style.flexGrow).toBe("1");
  expect(parseFloat(style.minHeight)).toBe(0);
  expect(parseFloat(style.minWidth)).toBe(0);
  expect(conversation.querySelector(".stream")).not.toBeNull();
  expect(conversation.querySelector(".composer")).not.toBeNull();
});

test("the routine calendar replaces the main column and stays visible without a session on a phone", async () => {
  const setViewport = (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM.setViewport.bind(
    (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM,
  );
  setViewport({ width: 390, height: 844 });
  const runtime = reactive(fakeRuntime({
    bots: [aBot()],
    routines: [aRoutine()],
    settings: { ...emptySnapshot().settings, locale: "zh", wizard_complete: true, workspace_path: "/fixture" },
  }));
  runtime.openRoutines = () => {
    runtime.routinesOpen = true;
  };
  runtime.closeRoutines = () => {
    runtime.routinesOpen = false;
  };
  const { host, app, close } = render(Shell, { runtime });
  cleanups.push(() => {
    setViewport({ width: 1024, height: 768 });
    close();
  });
  runtime.openRoutines();
  // The calendar is lazy-mounted: its module resolves a tick after `routinesOpen` turns true.
  await settle();
  const shell = host.querySelector(".shell")!;
  expect(shell.classList.contains("has-routines")).toBe(true);
  expect(getComputedStyle(host.querySelector(".main")!).display).not.toBe("none");
  expect(getComputedStyle(host.querySelector(".side")!).display).toBe("none");
  expect(host.querySelector(".routine-calendar")).not.toBeNull();
  expect(host.querySelector(".mobile-navigation")).toBeNull();
  expect(getComputedStyle(host.querySelector(".calendar-phone-note")!).display).toBe("block");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  expect(runtime.routinesOpen).toBe(false);
  runtime.openRoutines();
  flushSync();
  expect((app as { backMobileLayer: () => boolean }).backMobileLayer()).toBe(false);
  expect(runtime.routinesOpen).toBe(true);
});

test('mobile destinations preserve selection state, repeat safely and expose unconfigured workspace recovery', async () => {
  const runtime = reactive(fakeRuntime({
    settings: { ...emptySnapshot().settings, locale: 'zh', wizard_complete: true, workspace_path: null },
  }));
  runtime.openSettings = () => { runtime.workspaceOpen = false; runtime.settingsOpen = !runtime.settingsOpen; };
  runtime.openWorkspace = () => { runtime.settingsOpen = false; runtime.workspaceOpen = true; };
  runtime.closeWorkspace = () => { runtime.workspaceOpen = false; };
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  const nav = (index: number) => host.querySelectorAll('.mobile-navigation button')[index];
  click(nav(2));
  expect(runtime.settingsOpen).toBe(true);
  click(nav(2));
  expect(runtime.settingsOpen).toBe(true);
  click(nav(1));
  await settle();
  expect(runtime.workspaceOpen).toBe(true);
  expect(runtime.settingsOpen).toBe(false);
  expect(host.querySelector('.workspace-unset')).not.toBeNull();
  click(host.querySelector('.workspace-unset button'));
  await settle();
  expect(runtime.settingsOpen).toBe(true);
  expect(runtime.workspaceOpen).toBe(false);
  click(nav(0));
  await settle();
  expect(runtime.settingsOpen).toBe(false);
  expect(host.querySelector('.mobile-navigation [aria-current]')?.textContent).toContain('会话');
});

test('mounted Shell: a phone opens Bot settings as a page, and Back leaves the section first', () => {
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    // Reduced motion as well: a page slide still running when the test unmounts is aborted
    // mid-flight, and the animation has nothing to do with what these tests assert.
    matches: query === '(max-width: 680px)' || query === '(prefers-reduced-motion: reduce)',
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    const bot = aBot({ id: 'bot-1', name: 'Alpha' });
    const session = aDirect({ id: 'bot-1', participants: [
      { member: 'user', joined_at: 'now', left_at: null },
      { member: 'bot-1', joined_at: 'now', left_at: null },
    ] });
    const runtime = reactive(fakeRuntime({
      bots: [bot], sessions: [session],
      settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
    }, { selectedId: 'bot-1', sessionSettingsOpen: true, profileBotId: 'bot-1' }));
    const { host, close } = render(Shell, { runtime }); cleanups.push(close);
    const sheet = host.querySelector('.sheet.session-settings');
    expect(sheet).not.toBeNull();
    expect(sheet?.classList.contains('is-mobile-detail')).toBe(false);
    click(host.querySelectorAll('.bot-tab-btn')[3]);
    // The drawer's own header steps aside for the section's, which carries the way back.
    expect(sheet?.classList.contains('is-mobile-detail')).toBe(true);
    click(host.querySelector('.bot-detail-back'));
    expect(sheet?.classList.contains('is-mobile-detail')).toBe(false);
    expect(runtime.sessionSettingsOpen).toBe(true);
  } finally {
    window.matchMedia = previousMatchMedia;
  }
});

test('mounted Shell: Back unwinds what is not in the URL, then leaves the rest to history', () => {
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    // Reduced motion as well: a page slide still running when the test unmounts is aborted
    // mid-flight, and the animation has nothing to do with what these tests assert.
    matches: query === '(max-width: 680px)' || query === '(prefers-reduced-motion: reduce)',
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    const bot = aBot({ id: 'bot-1', name: 'Alpha' });
    const session = aDirect({ id: 'bot-1', participants: [
      { member: 'user', joined_at: 'now', left_at: null },
      { member: 'bot-1', joined_at: 'now', left_at: null },
    ] });
    const runtime = reactive(fakeRuntime({
      bots: [bot], sessions: [session],
      settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
    }, { selectedId: 'bot-1', sessionSettingsOpen: true, profileBotId: 'bot-1', threadOpen: false }));
    const { host, app, close } = render(Shell, { runtime }); cleanups.push(close);
    const back = (app as unknown as { backMobileLayer: () => boolean }).backMobileLayer;

    // A section of the Bot drawer is this page's business…
    click(host.querySelectorAll('.bot-tab-btn')[1]);
    expect(back()).toBe(true);
    // …the drawer itself is an entry in history, so Back is allowed to navigate.
    expect(back()).toBe(false);
    expect(runtime.sessionSettingsOpen).toBe(true);

    // A sheet with no URL of its own is closed here rather than navigated away from.
    runtime.createBotOpen = true;
    flushSync();
    expect(back()).toBe(true);
    expect(runtime.createBotOpen).toBe(false);
  } finally {
    window.matchMedia = previousMatchMedia;
  }
});

test('mounted Shell: the drawer ✕ closes the open section before the drawer itself', () => {
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    // Reduced motion as well: a page slide still running when the test unmounts is aborted
    // mid-flight, and the animation has nothing to do with what these tests assert.
    matches: query === '(max-width: 680px)' || query === '(prefers-reduced-motion: reduce)',
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    const bot = aBot({ id: 'bot-1', name: 'Alpha' });
    const session = aDirect({ id: 'bot-1', participants: [
      { member: 'user', joined_at: 'now', left_at: null },
      { member: 'bot-1', joined_at: 'now', left_at: null },
    ] });
    const runtime = reactive(fakeRuntime({
      bots: [bot], sessions: [session],
      settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
    }, { selectedId: 'bot-1', sessionSettingsOpen: true, profileBotId: 'bot-1' }));
    const { host, close } = render(Shell, { runtime }); cleanups.push(close);
    click(host.querySelectorAll('.bot-tab-btn')[1]);
    const sheet = host.querySelector('.sheet.session-settings');
    expect(sheet?.classList.contains('is-mobile-detail')).toBe(true);
    // The drawer's own header is hidden while a section is up, so drive its ✕ directly.
    (host.querySelector('.sheet-close') as HTMLButtonElement).click();
    flushSync();
    expect(sheet?.classList.contains('is-mobile-detail')).toBe(false);
    expect(runtime.sessionSettingsOpen).toBe(true);
    (host.querySelector('.sheet-close') as HTMLButtonElement).click();
    flushSync();
    expect(runtime.calls.some((c) => c.name === 'closeSessionSettings')).toBe(true);
  } finally {
    window.matchMedia = previousMatchMedia;
  }
});

test('mounted Shell: searching is a screen, and Back leaves it before it leaves the list', () => {
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    // Reduced motion keeps the page slide out of the way: what the screen holds is the point.
    matches: query === '(max-width: 680px)' || query === '(prefers-reduced-motion: reduce)',
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    const runtime = reactive(fakeRuntime({
      bots: [aBot({ id: 'bot-1', name: 'Alpha' })],
      settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
    }));
    const { host, app, close } = render(Shell, { runtime }); cleanups.push(close);
    const back = (app as unknown as { backMobileLayer: () => boolean }).backMobileLayer;
    expect(host.querySelector('.mobile-navigation')).not.toBeNull();

    // The + menu is a menu: the first Back takes it, and nothing has navigated yet.
    click(host.querySelector('.fab'));
    expect(host.querySelector('.fab-menu')).not.toBeNull();
    expect(back()).toBe(true);
    flushSync();
    expect(host.querySelector('.fab-menu')).toBeNull();

    click(host.querySelector('.search-trigger'));
    expect(host.querySelector('.search-page input.search')).not.toBeNull();
    // Nowhere to go while you are searching, and the keyboard wants the room.
    expect(host.querySelector('.mobile-navigation')).toBeNull();

    expect(back()).toBe(true);
    flushSync();
    expect(runtime.calls.some((c) => c.name === 'closeSearch')).toBe(true);
    expect(host.querySelector('.mobile-navigation')).not.toBeNull();
    // Nothing of ours left on top, so Back is history's again.
    expect(back()).toBe(false);
  } finally {
    window.matchMedia = previousMatchMedia;
  }
});

test('mounted Shell: the floating + is on the list of chats and nowhere else', () => {
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(max-width: 680px)' || query === '(prefers-reduced-motion: reduce)',
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    const bot = aBot({ id: 'bot-1', name: 'Alpha' });
    const session = aDirect({ id: 'bot-1', participants: [
      { member: 'user', joined_at: 'now', left_at: null },
      { member: 'bot-1', joined_at: 'now', left_at: null },
    ] });
    const runtime = reactive(fakeRuntime({
      bots: [bot], sessions: [session],
      settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
    }));
    const { host, close } = render(Shell, { runtime }); cleanups.push(close);
    expect(host.querySelector('.fab')).not.toBeNull();

    // A conversation is a page of its own: the list is not behind it, so neither is its button.
    runtime.selectedId = 'bot-1';
    flushSync();
    expect(host.querySelector('.fab')).toBeNull();

    runtime.selectedId = null;
    flushSync();
    expect(host.querySelector('.fab')).not.toBeNull();
    // Settings and the workspace are pages too.
    runtime.settingsOpen = true;
    flushSync();
    expect(host.querySelector('.fab')).toBeNull();
    runtime.settingsOpen = false;
    runtime.workspaceOpen = true;
    flushSync();
    expect(host.querySelector('.fab')).toBeNull();
  } finally {
    window.matchMedia = previousMatchMedia;
  }
});

/**
 * Every prop of the file pane comes off one object the shell derives from the snapshot, so a
 * snapshot that says nothing new still re-runs the pane's effects. Letting go of the listing there
 * — and pulling the same job again — is what made the tree blink while a conversation was live.
 */
test('a snapshot that changes nothing leaves the file tree alone', async () => {
  const bot = aBot({ id: 'bot-1', name: 'Alpha' });
  const session = aDirect({ id: 'bot-1', participants: [
    { member: 'user', joined_at: 'now', left_at: null },
    { member: 'bot-1', joined_at: 'now', left_at: null },
  ] });
  const attachment = anAttachment({
    id: 'att-plan', message_id: 'm1', workspace_relpath: 'work/plan.md',
    original_filename: 'plan.md', mime: 'text/markdown', size: 8,
  });
  const message = aMessage({
    id: 'm1', session_id: session.id, kind: 'bot', author: 'bot-1',
    task_id: 'task-1', attachments: [attachment],
  });
  let pulls = 0;
  const runtime = reactive(fakeRuntime({
    bots: [bot], sessions: [session], messages: [message],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: session.id, previewRelpath: 'work/plan.md', previewMessageId: 'm1' }));
  runtime.client = {
    kind: 'local',
    taskArtifacts: async () => {
      pulls += 1;
      return {
        id: 'task-1', dir: 'work', title: 'plan', closed_at: null,
        items: [
          { path: 'work/plan.md', last_cited_at: 'now', turn_id: null },
          { path: 'work/notes.md', last_cited_at: 'now', turn_id: null },
        ],
      };
    },
    getWorkspaceFileBlob: async () => new Blob(['# plan'], { type: 'text/markdown' }),
    getAttachmentBlob: async () => new Blob(['# plan'], { type: 'text/markdown' }),
  } as never;
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  await settle();
  const rows = () => [...host.querySelectorAll('.artifact-tree-row')].map((row) => row.textContent?.trim());
  expect(pulls).toBe(1);
  expect(rows()).toContain('notes.md');

  const listed = rows();
  runtime.snapshot = { ...runtime.snapshot, sessions: [...runtime.snapshot.sessions] };
  await settle();
  expect(pulls).toBe(1);
  expect(rows()).toEqual(listed);
});

/** The explorer reads the same snapshot, and re-read its root on every one of them. */
test('a snapshot that changes nothing leaves the workspace listing alone', async () => {
  const bot = aBot({ id: 'bot-1', name: 'Alpha' });
  const session = aDirect({ id: 'bot-1', participants: [
    { member: 'user', joined_at: 'now', left_at: null },
    { member: 'bot-1', joined_at: 'now', left_at: null },
  ] });
  let listings = 0;
  const runtime = reactive(fakeRuntime({
    bots: [bot], sessions: [session],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: session.id, workspaceOpen: true, workspaceSelected: '' }));
  runtime.client = {
    kind: 'local',
    workspaceTree: async (path = '') => {
      listings += 1;
      return { path, truncated: false, items: [
        { name: 'docs', path: 'docs', kind: 'dir' },
        { name: 'plan.md', path: 'plan.md', kind: 'file' },
      ] };
    },
    getWorkspaceFileBlob: async () => new Blob(['# plan'], { type: 'text/markdown' }),
  } as never;
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  await settle();
  const rows = () => [...host.querySelectorAll('.artifact-tree-row')].map((row) => row.textContent?.trim());
  expect(listings).toBe(1);
  expect(rows()).toContain('plan.md');

  const listed = rows();
  runtime.snapshot = { ...runtime.snapshot, sessions: [...runtime.snapshot.sessions] };
  await settle();
  expect(listings).toBe(1);
  expect(rows()).toEqual(listed);
});

/**
 * The job's record is what the Mac noticed; a message can hand over more than that with `附件：`
 * lines, and messages stored before it read those lines always do. The bubble's entry counts them,
 * so the tree beside the file must list them too — including the file that is open.
 */
test('the file tree lists what the message handed over, not just what the job recorded', async () => {
  const bot = aBot({ id: 'bot-1', name: 'Alpha' });
  const session = aDirect({ id: 'bot-1', participants: [
    { member: 'user', joined_at: 'now', left_at: null },
    { member: 'bot-1', joined_at: 'now', left_at: null },
  ] });
  const attachment = anAttachment({
    id: 'att-plan', message_id: 'm1', workspace_relpath: 'BEACON/docs/plan.md',
    original_filename: 'plan.md', mime: 'text/markdown', size: 8,
  });
  const message = aMessage({
    id: 'm1', session_id: session.id, kind: 'bot', author: 'bot-1', task_id: 'task-1',
    attachments: [attachment],
    body: [
      '画左 1/3 破损圆柱舱，成果如下：',
      '附件：BEACON/shots/C01_START.png',
      '附件：BEACON/shots/C01_END.png',
    ].join('\n'),
  });
  const runtime = reactive(fakeRuntime({
    bots: [bot], sessions: [session], messages: [message],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, {
    selectedId: session.id,
    previewRelpath: 'BEACON/shots/C01_START.png',
    previewMessageId: 'm1',
  }));
  runtime.client = {
    kind: 'local',
    taskArtifacts: async () => ({
      id: 'task-1', dir: 'work/task', title: 'plan', closed_at: null,
      items: [{ path: 'BEACON/docs/plan.md', last_cited_at: 'now', turn_id: null }],
    }),
    getWorkspaceFileBlob: async () => new Blob(['x'], { type: 'image/png' }),
    getAttachmentBlob: async () => new Blob(['x'], { type: 'image/png' }),
  } as never;
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  await settle();
  const rows = [...host.querySelectorAll('.artifact-tree-row')].map((row) => row.textContent?.trim());
  // Folder rows carry the disclosure mark; the rest are the files this tree lists.
  const files = rows.filter((row) => !row?.includes('\u25b8'));
  // `1/3` out of the prose is not among them: the context menu may guess, a file tree may not.
  expect(files).toEqual(['plan.md', 'C01_END.png', 'C01_START.png']);
});

test('opening message attachments in a workbench pane keeps its tree and selects files in place', async () => {
  localStorage.removeItem('real-bot-workbench-layout');
  const session = aDirect();
  const attachments = ['plan.md', 'notes.md'].map((name, i) => anAttachment({
    id: `tree-att-${i}`, message_id: 'tree-message', workspace_relpath: `work/${name}`,
    original_filename: name, mime: 'text/markdown',
  }));
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [session],
    messages: [aMessage({ id: 'tree-message', session_id: session.id, kind: 'bot', author: 'bot-1', attachments })],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: session.id }));
  runtime.client = {
    kind: 'local',
    getAttachmentBlob: async (id: string) => new Blob([`# ${id}`], { type: 'text/markdown' }),
    getWorkspaceFileBlob: async (path: string) => new Blob([`# ${path}`], { type: 'text/markdown' }),
  } as never;
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  click(host.querySelector('.attachment-bundle-btn'));
  await settle();
  expect(host.querySelector('.artifact-pane')).not.toBeNull();
  expect(host.querySelector('.artifact-tree')).not.toBeNull();
  expect(getComputedStyle(host.querySelector('.artifact-pane')!).height).toBe('100%');
  expect(getComputedStyle(host.querySelector('.artifact-pane-main')!).gridTemplateRows).toBe('minmax(0, 1fr)');
  const rows = () => [...host.querySelectorAll<HTMLButtonElement>('.artifact-tree-row')];
  expect(rows().map((row) => row.title)).toContain('work/notes.md');
  const tabs = host.querySelectorAll('[role="tab"]').length;
  click(rows().find((row) => row.title === 'work/notes.md'));
  await settle();
  expect(host.querySelector('.artifact-tree-row.is-selected')?.getAttribute('title')).toBe('work/notes.md');
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('notes.md');
  expect(host.querySelectorAll('[role="tab"]').length).toBe(tabs);
  expect(rows().map((row) => row.title)).toContain('work/plan.md');
});
