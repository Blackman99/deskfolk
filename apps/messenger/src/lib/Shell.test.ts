import { afterEach, expect, mock, test } from 'bun:test';
import { flushSync } from 'svelte';
import type { ClientEvent, SpendDetail, SpendSummary } from '@real-bot/protocol';
import { MessengerRuntime } from './runtime.svelte.ts';
import { overlayFromFlags, sessionUrl, viewFromUrl } from './session-url.ts';
// Monaco's Vite-only stylesheet alias is unrelated to the mounted confirmation surfaces.
mock.module('monaco-editor-css', () => ({}));
mock.module('monaco-editor/esm/vs/platform/hover/browser/hover.css', () => ({}));
mock.module('monaco-editor/esm/vs/base/browser/ui/contextview/contextview.css', () => ({}));
// A terminal tab mounts xterm, which draws to a canvas happy-dom does not have.
mock.module('@xterm/xterm', () => ({
  Terminal: class {
    rows = 24; cols = 80; options = {}; unicode = { activeVersion: '6' };
    _core: { viewport?: { scrollBarWidth: number } } = {};
    parser = { registerCsiHandler: () => ({ dispose() {} }), registerDcsHandler: () => ({ dispose() {} }), registerOscHandler: () => ({ dispose() {} }) };
    loadAddon() {}
    open() { this._core.viewport = { scrollBarWidth: 15 }; }
    onData() {} attachCustomKeyEventHandler() {} reset() {} clear() {} resize() {} focus() {} dispose() {}
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
import { paneMin, WB_FALLBACK_MIN, WB_STRIP_PX } from './workbench/pane-mins.ts';
import { PINNED_STORAGE_KEY } from './sidebar/pinned-sessions.ts';

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
  // The page that is leaving is the conversation, not the desktop's "pick a session" column
  // flashing through it.
  expect(host.textContent).not.toContain("选择一个会话");
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

test('on a phone, a Bot opened from a group is that Bot\'s settings, and Back leaves for the conversation', () => {
  const setViewport = (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM.setViewport.bind(
    (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM,
  );
  setViewport({ width: 390, height: 844 });
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(max-width: 680px)' || query === '(prefers-reduced-motion: reduce)',
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    const t = copyFor('zh');
    const bot = aBot({ id: 'bot-1', name: 'Alpha' });
    const group = aGroup({ id: 'g1', name: 'Alpha group', participants: [
      { member: 'user', joined_at: 'now', left_at: null },
      { member: 'bot-1', joined_at: 'now', left_at: null },
      { member: 'bot-2', joined_at: 'now', left_at: null },
    ] });
    const runtime = reactive(fakeRuntime({
      bots: [bot, aBot({ id: 'bot-2', name: 'Beta' })],
      sessions: [group],
      settings: { ...emptySnapshot().settings, locale: 'zh', wizard_complete: true, workspace_path: '/fixture' },
    }, { selectedId: 'g1', sessionSettingsOpen: true, profileBotId: null }));
    runtime.openProfile = (botId: string) => { runtime.profileBotId = botId; };
    runtime.closeProfile = () => { runtime.profileBotId = null; };
    runtime.closeSessionSettings = () => { runtime.sessionSettingsOpen = false; runtime.profileBotId = null; };
    const { host, app, close } = render(Shell, { runtime }); cleanups.push(close);
    click(host.querySelectorAll('.group-section-btn')[0]);
    click(host.querySelector('.member-name-btn'));
    const sheet = host.querySelector('.profile-backdrop .sheet');
    expect(sheet?.querySelector('h2')).toBeNull();
    expect(sheet?.querySelector('.profile-pane')).not.toBeNull();
    const back = sheet?.querySelector('.sheet-back');
    expect(back).not.toBeNull();
    expect(back?.getAttribute('aria-label')).toBe(t.common.back);
    expect(back?.querySelector('svg')).not.toBeNull();
    const label = back?.querySelector('.sheet-back-label');
    expect(getComputedStyle(label!).display).toBe('none');
    // The group's section is not this page's business: Back is the conversation's history.
    const leave = (app as unknown as { backMobileLayer: () => boolean }).backMobileLayer;
    expect(leave()).toBe(false);
    expect(runtime.sessionSettingsOpen).toBe(true);
    click(back);
    expect(runtime.sessionSettingsOpen).toBe(false);
    expect(host.querySelector('.profile-backdrop')).toBeNull();
  } finally {
    window.matchMedia = previousMatchMedia;
    setViewport({ width: 1024, height: 768 });
  }
});

test('a wider window still labels the way back from a nested Bot', () => {
  const setViewport = (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM.setViewport.bind(
    (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM,
  );
  setViewport({ width: 1180, height: 820 });
  const t = copyFor('en');
  const bot = aBot({ id: 'bot-1', name: 'Alpha' });
  const group = aGroup({ id: 'g1', name: 'Alpha group' });
  const runtime = reactive(fakeRuntime({
    bots: [bot, aBot({ id: 'bot-2', name: 'Beta' })],
    sessions: [group],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: 'g1', sessionSettingsOpen: true, profileBotId: 'bot-1' }));
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  const back = host.querySelector('.profile-backdrop .sheet-back');
  expect(back?.querySelector('.sheet-back-label')?.textContent).toBe(t.detail.backToGroup);
  expect(getComputedStyle(back!.querySelector('.sheet-back-label')!).display).not.toBe('none');
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
    expect(host.querySelector('.global-search-input')).not.toBeNull();
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

/** The workspace in a pane is that tab's: a file picked in its tree is what the tab shows next. */
test('a file picked in a workspace pane opens in that pane and survives a restart', async () => {
  localStorage.setItem('real-bot-workbench-layout', JSON.stringify({
    version: 1,
    root: makeLeaf('a', [{ id: 't-ws', kind: 'workspace', params: {} }]),
    floating: [],
    focus: { zone: 'tiled', leafId: 'a' },
  }));
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [aDirect()],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }));
  const reads: string[] = [];
  runtime.client = {
    kind: 'local',
    workspaceTree: async (path = '') => ({ path, truncated: false, items: [
      { name: 'docs', path: 'docs', kind: 'dir' },
      { name: 'plan.md', path: 'plan.md', kind: 'file' },
    ] }),
    getWorkspaceFileBlob: async (path: string) => {
      reads.push(path);
      return new Blob(['# plan'], { type: 'text/markdown' });
    },
  } as never;
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  await settle();
  const row = [...host.querySelectorAll<HTMLElement>('.artifact-tree-row')]
    .find((el) => el.textContent?.trim() === 'plan.md');
  expect(row).toBeDefined();
  click(row!);
  await settle();
  await settle();
  expect(reads).toContain('plan.md');
  expect(storedTabs().find((tab) => tab.kind === 'workspace')?.params).toEqual({ selected: 'plan.md' });
  localStorage.removeItem('real-bot-workbench-layout');
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

/**
 * The tree keeps the message the preview was opened from while you walk to other files. A file
 * that message never handed over hangs on whichever Bot message did — and on none, when no Bot did.
 */
test('a file walked to in the tree hangs on the message that handed it over, not the one the pane was opened from', async () => {
  const session = aGroup({ id: 'g1', name: 'Team' });
  const byA = aMessage({ id: 'm-a', session_id: session.id, kind: 'bot', author: 'bot-a', task_id: 'task-1', created_at: '2026-09-23T00:00:00.000Z', body: '初稿\n附件：work/draft.txt' });
  const upload = aMessage({ id: 'm-me', session_id: session.id, task_id: 'task-1', created_at: '2026-09-23T00:01:00.000Z', attachments: [anAttachment({ id: 'att-csv', message_id: 'm-me', workspace_relpath: 'work/notes.txt', original_filename: 'notes.txt', mime: 'text/plain' })] });
  const byB = aMessage({ id: 'm-b', session_id: session.id, kind: 'bot', author: 'bot-b', task_id: 'task-1', created_at: '2026-09-23T00:02:00.000Z', attachments: [anAttachment({ id: 'att-review', message_id: 'm-b', workspace_relpath: 'work/review.txt', original_filename: 'review.txt', mime: 'text/plain' })] });
  const runtime = reactive(fakeRuntime({
    bots: [aBot({ id: 'bot-a', name: 'Alpha' }), aBot({ id: 'bot-b', name: 'Beta' })], sessions: [session], messages: [byA, upload, byB],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: session.id, previewRelpath: 'work/review.txt', previewMessageId: 'm-b' }));
  runtime.client = {
    kind: 'local',
    taskArtifacts: async () => ({ id: 'task-1', dir: 'work', title: 'review', closed_at: null, items: [] }),
    getWorkspaceFileBlob: async () => new Blob(['text'], { type: 'text/plain' }),
    getAttachmentBlob: async () => new Blob(['text'], { type: 'text/plain' }),
  } as never;
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  const hint = () => host.querySelector('[data-annotation-hint]')?.getAttribute('data-annotation-hint');
  await settle();
  await settle();
  expect(hint()).toBe('');
  // Your own upload, opened from the same tree: no Bot handed it over.
  runtime.previewRelpath = 'work/notes.txt';
  await settle();
  await settle();
  expect(runtime.previewMessageId).toBe('m-b');
  expect(hint()).toBe('no-target');
  // Alpha's file can be annotated: it goes to Alpha's message.
  runtime.previewRelpath = 'work/draft.txt';
  await settle();
  await settle();
  expect(hint()).toBe('');
});

/**
 * On the workbench the conversation's preview is a pane, and it annotates like the narrow one: what
 * a Bot handed over hangs on that Bot's message, your own upload on nothing, and a card in this
 * conversation asking for an annotation opens the list on it.
 */
test('a preview in a workbench pane annotates the way the narrow one does', async () => {
  localStorage.removeItem('real-bot-workbench-layout');
  const session = aDirect();
  const delivery = aMessage({ id: 'm-bot', session_id: session.id, kind: 'bot', author: 'bot-1', task_id: 'task-1', body: '写好了\n附件：work/draft.txt' });
  const upload = aMessage({ id: 'm-me', session_id: session.id, attachments: [anAttachment({ id: 'att-notes', message_id: 'm-me', workspace_relpath: 'work/notes.txt', original_filename: 'notes.txt', mime: 'text/plain' })] });
  const annotation = {
    id: 'ann-1', status: 'open', relpath: 'work/draft.txt', anchor_kind: 'text_range',
    anchor: { start_line: 1, start_col: 1, end_line: 1, end_col: 5, quote: 'text', prefix: '', suffix: '' },
    content_sha256: '0'.repeat(64), target_message_id: 'm-bot', target_session_id: session.id, target_turn_id: null,
    bot_id: 'bot-1', session_id: session.id, message_id: 'm-batch', body: '换个词', crop_mime: null,
    resolved_by: null, resolved_note: null, resolved_at: null, created_at: 'now', updated_at: 'now', stale: null,
  } as const;
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [session], messages: [delivery, upload], annotations: [annotation as never],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: session.id }));
  runtime.client = {
    kind: 'local',
    taskArtifacts: async () => ({ id: 'task-1', dir: 'work', title: 'draft', closed_at: null, items: [] }),
    getWorkspaceFileBlob: async () => new Blob(['text'], { type: 'text/plain' }),
    getAttachmentBlob: async () => new Blob(['text'], { type: 'text/plain' }),
  } as never;
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  const pane = () => host.querySelector('.artifact-pane');
  const hint = () => pane()?.querySelector('[data-annotation-hint]')?.getAttribute('data-annotation-hint');
  const list = () => pane()?.querySelector('[data-annotation-list]') ?? null;
  runtime.paneOpener?.({ kind: 'preview', sessionId: session.id, relpath: 'work/draft.txt', attachmentId: null, messageId: 'm-bot' });
  await settle();
  await settle();
  // The pane is the preview; the narrow layer stays shut.
  expect(runtime.previewRelpath).toBeNull();
  expect(host.querySelectorAll('.artifact-pane')).toHaveLength(1);
  expect(hint()).toBe('');
  expect(runtime.calls.some((call) => call.name === 'loadAnnotations' && (call.args[0] as { relpath: string }).relpath === 'work/draft.txt')).toBe(true);
  expect(list()).toBeNull();

  // A card in this conversation asks for its annotation: the pane takes the request and opens its list.
  runtime.annotationFocusId = 'ann-1';
  await settle();
  await settle();
  expect(list()?.querySelector('[data-annotation-id="ann-1"]')).not.toBeNull();
  expect(runtime.annotationFocusId).toBeNull();

  runtime.paneOpener?.({ kind: 'preview', sessionId: session.id, relpath: 'work/notes.txt', attachmentId: 'att-notes', messageId: 'm-me' });
  await settle();
  await settle();
  expect(hint()).toBe('no-target');

  // A card for draft.txt while the pane shows notes.txt (an unsaved-changes question may be holding
  // the switch): the request waits for its file instead of focusing a row this file does not have.
  runtime.annotationFocusId = 'ann-1';
  await settle();
  await settle();
  expect(runtime.annotationFocusId).toBe('ann-1');
  expect(list()?.querySelector('[data-annotation-id="ann-1"]') ?? null).toBeNull();
  runtime.paneOpener?.({ kind: 'preview', sessionId: session.id, relpath: 'work/draft.txt', attachmentId: null, messageId: 'm-bot' });
  await settle();
  await settle();
  expect(runtime.annotationFocusId).toBeNull();
  expect(list()?.querySelector('[data-annotation-id="ann-1"]')).not.toBeNull();
  localStorage.removeItem('real-bot-workbench-layout');
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
  // The preview tab is named for the conversation, and picking another file does not retitle it.
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Researcher's artifacts");
  expect(host.querySelectorAll('[role="tab"]').length).toBe(tabs);
  expect(rows().map((row) => row.title)).toContain('work/plan.md');
});

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
  const action = (title: string) =>
    [...pane().querySelectorAll<HTMLButtonElement>('.top-actions .btn-top-action')].find((b) => b.title === title)!;
  const dispatch = (el: Element | null | undefined, type: string) =>
    el?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  expect(tabs()).toBe(1);

  click(action(t.top.botSettings));
  await settle();
  expect(tabs()).toBe(1);
  expect(scrim()?.querySelector('.pane-side .profile-pane')).not.toBeNull();
  expect(action(t.top.botSettings).getAttribute('aria-expanded')).toBe('true');
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
  click(action(t.top.botSettings));
  await settle();
  click(pane().querySelector('.pane-side .sheet-close'));
  await settle();
  expect(scrim()).toBeNull();
  expect(tabs()).toBe(1);
  // Model choices are read on the flow board's cards; the header has no log of its own.
  expect([...pane().querySelectorAll<HTMLButtonElement>('.top-actions .btn-top-action')].map((b) => b.title))
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
  const groupSettings = () => [...host.querySelectorAll<HTMLButtonElement>('.pane-chat .top-actions .btn-top-action')]
    .find((b) => b.title === t.top.groupSettings)!;
  click(groupSettings());
  await settle();
  expect(side()?.querySelector<HTMLInputElement>('.sheet-head #detail-group-name')?.value).toBe('Alpha group');
  click(side()?.querySelector('.member-name-btn'));
  await settle();
  expect(side()?.querySelector('.profile-pane')).not.toBeNull();
  expect(side()?.querySelector('.sheet-head h2')?.textContent).toBe(t.detail.titleBot);
  expect(side()?.querySelector('.sheet-back')).toBeNull();
  expect(side()?.getAttribute('aria-label')).toBe(t.top.botSettings);
  // The group's own settings button is not lit by a member's settings.
  expect(groupSettings().getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelectorAll('.wb-tab-button')).toHaveLength(1);
});

test('a direct conversation\'s Bot, opened from the transcript, is that conversation\'s own settings', async () => {
  localStorage.removeItem('real-bot-workbench-layout');
  const session = aDirect();
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [session],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true },
  }, { selectedId: session.id }));
  const t = copyFor('en');
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  // What clicking the Bot's avatar asks for.
  runtime.paneOpener?.({ kind: 'chat', sessionId: session.id, side: { kind: 'settings', botId: 'bot-1' } });
  await settle();
  const settings = [...host.querySelectorAll<HTMLButtonElement>('.pane-chat .top-actions .btn-top-action')]
    .find((b) => b.title === t.top.botSettings)!;
  expect(host.querySelector('.pane-chat .pane-side .profile-pane')).not.toBeNull();
  expect(settings.getAttribute('aria-expanded')).toBe('true');
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

function aTerminal(id: string, created_at: string) {
  return { id, title: 'real-bot', cwd: '/fixture', rows: 24, cols: 80, created_at, status: 'live' as const, exit_code: null, stream_end: 0 };
}

function storedTabs() {
  const saved = JSON.parse(localStorage.getItem('real-bot-workbench-layout')!);
  const leaves = [saved.root, ...saved.floating.map((pane: { leaf: unknown }) => pane.leaf)];
  return leaves.flatMap((leaf: { tabs?: Array<{ kind: string; params: Record<string, string> }> }) => leaf.tabs ?? []);
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

/** A row of the portaled new-tab menu, by the name it shows. */
function menuRow(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.wb-new-menu .wb-menu-row')].find(
    (row) => row.querySelector('.wb-menu-name')?.textContent?.trim() === name,
  );
  if (!found) throw new Error(`no menu row labelled ${name}`);
  return found;
}

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
  const collapse = () => mounted.host.querySelector('.side .search-wrap .side-collapse') as HTMLButtonElement | null;
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
