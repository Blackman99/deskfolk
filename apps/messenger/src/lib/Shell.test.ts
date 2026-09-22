import { afterEach, expect, mock, test } from 'bun:test';
import { flushSync } from 'svelte';
import type { ClientEvent } from '@real-bot/protocol';
// Monaco's Vite-only stylesheet alias is unrelated to the mounted confirmation surfaces.
mock.module('monaco-editor-css', () => ({}));
mock.module('monaco-editor/esm/vs/platform/hover/browser/hover.css', () => ({}));
mock.module('monaco-editor/esm/vs/base/browser/ui/contextview/contextview.css', () => ({}));
const { default: Shell } = await import('./Shell.svelte');
import { ApiError } from './api.ts';
import { applyEvent, emptySnapshot } from './snapshot.ts';
import { aBot, aDirect, aGroup, aProvider, fakeRuntime } from './test-fixtures.ts';
import { reactive } from './test-reactive.svelte.ts';
import { buttonByText, click, render } from './test-render.ts';

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
    if (kind === 'provider') click(buttonByText(host, 'Models 2'));
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
  expect(runtime.workspaceOpen).toBe(true);
  expect(runtime.settingsOpen).toBe(false);
  expect(host.querySelector('.workspace-unset')).not.toBeNull();
  click(host.querySelector('.workspace-unset button'));
  expect(runtime.settingsOpen).toBe(true);
  expect(runtime.workspaceOpen).toBe(false);
  click(nav(0));
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
