import { afterEach, expect, test } from 'bun:test';
import { flushSync } from 'svelte';
import type { ClientEvent } from '@real-bot/protocol';
import { ApiError } from './api.ts';
import { applyEvent, emptySnapshot } from './snapshot.ts';
import { aBot, aDirect, aGroup, aMessage, aProvider, anAttachment, fakeRuntime } from './test-fixtures.ts';
import { reactive } from './test-reactive.svelte.ts';
import { buttonByText, click, render } from './test-render.ts';
import { copyFor } from './copy.ts';
import { settle } from './test-async.ts';
import { loadShell } from './test-shell-kit.ts';

const Shell = await loadShell();

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
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

test('clearing a group history erases what you said there only when you tick the box in the confirm', async () => {
  const bots = [aBot({ id: 'a', name: 'Alpha' }), aBot({ id: 'b', name: 'Beta' })];
  const runtime = reactive(fakeRuntime({
    bots,
    sessions: [aGroup({ id: 'g1', name: 'Crew' })],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }));
  runtime.closeSessionSettings = () => { runtime.sessionSettingsOpen = false; };
  flushSync(() => { runtime.selectedId = 'g1'; runtime.sessionSettingsOpen = true; });
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  const t = copyFor('en');
  for (const tick of [false, true]) {
    click(host.querySelector('.danger-zone-card .btn-history-clear'));
    const dialog = host.querySelector('dialog[open]')!;
    expect(dialog.textContent).toContain(t.detail.eraseQuotes);
    const box = dialog.querySelector<HTMLInputElement>('.confirm-option input')!;
    expect(box.checked).toBe(false);
    if (tick) { click(box); flushSync(); expect(box.checked).toBe(true); }
    click(dialog.querySelector('.deny')); await settle();
    expect(host.querySelector('dialog')).toBeNull();
  }
  expect(runtime.calls.filter((call) => call.name === 'clearSessionHistory').map((call) => call.args)).toEqual([
    ['g1', { eraseQuotes: false }],
    ['g1', { eraseQuotes: true }],
  ]);
});

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

/**
 * A file a card's chip opens lies over the whole app, as an enlarged picture does: Escape puts it
 * away, except when it was typed into the file's own editor.
 */
test("Escape closes a file opened over the app from a card, but not from inside its editor", async () => {
  localStorage.removeItem('real-bot-workbench-layout');
  const session = aGroup({ id: 'g-card', name: 'Team' });
  const card = aMessage({
    id: 'card', session_id: session.id, kind: 'system', author: 'user',
    body: 'job 的任务 01「稿子」交上来了（draft.md）。\n看过之后，放行或者退回。',
    attachments: [anAttachment({ id: 'att-draft', message_id: 'card', workspace_relpath: 'work/job/draft.md', original_filename: 'draft.md', mime: 'text/markdown' })],
    control: { kind: 'review_item', submission_id: 'sub-1', task_id: 'plan-1', ticket_id: 'ticket-1', requirement_ids: [], check_ids: [], offer: ['approve', 'reject'] } as never,
  });
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [session], messages: [card],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: session.id }));
  runtime.client = {
    kind: 'local',
    getAttachmentBlob: async () => new Blob(['# draft'], { type: 'text/markdown' }),
    getWorkspaceFileBlob: async () => new Blob(['# draft'], { type: 'text/markdown' }),
  } as never;
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  const escape = (target: EventTarget) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const overlay = () => host.querySelector('.msg-file-overlay');

  click(host.querySelector('[data-message-id="card"] .attachment-file-btn'));
  await settle();
  expect(overlay()).not.toBeNull();
  const editor = document.createElement('div');
  editor.className = 'monaco-editor';
  overlay()!.querySelector('.msg-file-body')!.append(editor);
  escape(editor);
  await settle();
  expect(overlay()).not.toBeNull();
  escape(document.body);
  await settle();
  expect(overlay()).toBeNull();
  // Nothing else went with it: the conversation is still on screen and no pane opened.
  expect(host.querySelector('[data-message-id="card"]')).not.toBeNull();
  expect(runtime.previewRelpath).toBeNull();
});
