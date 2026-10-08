import { afterEach, expect, test } from 'bun:test';
import { flushSync } from 'svelte';
import { emptySnapshot } from './snapshot.ts';
import { aBot, aBotDirect, aDirect, aGroup, aMessage, aRoutine, anAttachment, fakeRuntime } from './test-fixtures.ts';
import { reactive } from './test-reactive.svelte.ts';
import { buttonByText, click, render } from './test-render.ts';
import { copyFor } from './copy.ts';
import { settle } from './test-async.ts';
import { loadShell } from './test-shell-kit.ts';

const Shell = await loadShell();

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

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

test('on a phone the settings page is headed with the Bot or the Bots it belongs to', () => {
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
    const direct = aDirect({ id: 'd1' });
    const botBot = aBotDirect({ id: 'bb1' });
    const runtime = reactive(fakeRuntime({
      bots: [aBot({ id: 'bot-1', name: 'Alpha' }), aBot({ id: 'bot-2', name: 'Beta' })],
      sessions: [direct, botBot],
      settings: { ...emptySnapshot().settings, locale: 'zh', wizard_complete: true, workspace_path: '/fixture' },
    }, { selectedId: 'd1', sessionSettingsOpen: true, profileBotId: null }));
    const { host, close } = render(Shell, { runtime }); cleanups.push(close);
    const head = () => host.querySelector('.profile-backdrop .sheet-head');
    expect(head()?.querySelector('h2')?.textContent?.trim()).toBe('Alpha');
    expect(head()?.querySelector('.settings-subject-caption')?.textContent?.trim()).toBe(t.detail.titleBot);
    flushSync(() => { runtime.selectedId = 'bb1'; });
    expect(head()?.querySelector('h2')?.textContent?.trim()).toBe('Alpha ↔ Beta');
  } finally {
    window.matchMedia = previousMatchMedia;
    setViewport({ width: 1024, height: 768 });
  }
});

test('a wider window keeps the plain Bot settings title', () => {
  const runtime = reactive(fakeRuntime({
    bots: [aBot({ id: 'bot-1', name: 'Alpha' })],
    sessions: [aDirect({ id: 'd1' })],
    settings: { ...emptySnapshot().settings, locale: 'zh', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: 'd1', sessionSettingsOpen: true, profileBotId: null }));
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  expect(host.querySelector('.sheet-head h2')?.textContent?.trim()).toBe(copyFor('zh').detail.titleBot);
  expect(host.querySelector('.sheet-head .settings-subject')).toBeNull();
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
    // No way back to the group's settings, so the head names the Bot instead of the group.
    expect(sheet?.querySelector('.sheet-head h2')?.textContent?.trim()).toBe('Alpha');
    expect(sheet?.querySelector('.sheet-head .settings-subject-caption')?.textContent?.trim()).toBe(t.detail.titleBot);
    expect(sheet?.querySelector('.profile-pane')).not.toBeNull();
    const back = sheet?.querySelector('.sheet-back');
    expect(back).not.toBeNull();
    expect(back?.getAttribute('aria-label')).toBe(t.common.back);
    expect(back?.querySelector('svg')).not.toBeNull();
    const label = back?.querySelector('.sheet-back-label');
    expect(getComputedStyle(label!).display).toBe('none');
    const leave = (app as unknown as { backMobileLayer: () => boolean }).backMobileLayer;
    // Inside the Bot's page, Back steps out one screen at a time: the skill sheet, then the section.
    click(sheet?.querySelectorAll('.bot-tab-btn')[1]);
    expect(sheet?.classList.contains('is-mobile-detail')).toBe(true);
    click(sheet?.querySelector('.skill-empty-add-btn'));
    expect(host.querySelector('.skill-modal-backdrop')).not.toBeNull();
    expect(leave()).toBe(true);
    flushSync();
    expect(host.querySelector('.skill-modal-backdrop')).toBeNull();
    expect(sheet?.classList.contains('is-mobile-detail')).toBe(true);
    expect(leave()).toBe(true);
    flushSync();
    expect(sheet?.classList.contains('is-mobile-detail')).toBe(false);
    // The group's section is not this page's business: Back is the conversation's history.
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

test('mounted Shell: Back puts an enlarged picture away and leaves the conversation where it is', () => {
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    // Reduced motion: the picture goes straight back instead of shrinking into its thumbnail.
    matches: query === '(max-width: 680px)' || query === '(prefers-reduced-motion: reduce)',
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    const session = aDirect({ id: 'bot-1', participants: [
      { member: 'user', joined_at: 'now', left_at: null },
      { member: 'bot-1', joined_at: 'now', left_at: null },
    ] });
    const picture = anAttachment({
      id: 'pic', message_id: 'msg-pic', original_filename: 'image.png',
      workspace_relpath: 'inbox/image.png', mime: 'image/png',
    });
    const runtime = reactive(fakeRuntime({
      bots: [aBot({ id: 'bot-1', name: 'Alpha' })], sessions: [session],
      messages: [aMessage({ id: 'msg-pic', session_id: session.id, kind: 'user', body: 'look', attachments: [picture] })],
      settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
    }, {
      selectedId: session.id,
      client: { getAttachmentBlob: async () => new Blob([new Uint8Array([1])], { type: 'image/png' }) },
    }));
    const { host, app, close } = render(Shell, { runtime }); cleanups.push(close);
    const back = (app as unknown as { backMobileLayer: () => boolean }).backMobileLayer;

    click(host.querySelector('.attachment-file-btn'));
    expect(host.querySelector('.msg-image-lightbox')).not.toBeNull();
    // The picture is not a page: Back closes it here and history stays put.
    expect(back()).toBe(true);
    flushSync();
    expect(host.querySelector('.msg-image-lightbox')).toBeNull();
    expect(runtime.selectedId).toBe(session.id);
    // With it gone, the next Back is the conversation's, and that one is history's.
    expect(back()).toBe(false);
  } finally {
    window.matchMedia = previousMatchMedia;
  }
});

test('mounted Shell: Back closes a message opened to select from and stays in the conversation', () => {
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(max-width: 680px)' || query === '(pointer: coarse)' || query === '(prefers-reduced-motion: reduce)',
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    const session = aDirect({ id: 'bot-1', participants: [
      { member: 'user', joined_at: 'now', left_at: null },
      { member: 'bot-1', joined_at: 'now', left_at: null },
    ] });
    const runtime = reactive(fakeRuntime({
      bots: [aBot({ id: 'bot-1', name: 'Alpha' })], sessions: [session],
      messages: [aMessage({ id: 'msg-text', session_id: session.id, kind: 'bot', author: 'bot-1', body: 'One line to take out of a long reply.' })],
      settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
    }, { selectedId: session.id }));
    const { host, app, close } = render(Shell, { runtime }); cleanups.push(close);
    const back = (app as unknown as { backMobileLayer: () => boolean }).backMobileLayer;
    const t = copyFor('en');

    // A long-press: the menu, then its Select text.
    const segment = host.querySelector('[data-message-id="msg-text"]')!;
    segment.dispatchEvent(new Event('touchstart', { bubbles: true }));
    segment.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSync();
    click(buttonByText(host, t.chat.selectText));
    expect(host.querySelector('.message-text')).not.toBeNull();
    // The page is in no URL: Back closes it here, and the conversation is still open under it.
    expect(back()).toBe(true);
    flushSync();
    expect(host.querySelector('.message-text')).toBeNull();
    expect(runtime.selectedId).toBe(session.id);
    expect(back()).toBe(false);
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
