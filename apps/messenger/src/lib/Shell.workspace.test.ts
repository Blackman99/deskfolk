import { afterEach, expect, test } from 'bun:test';
import { flushSync } from 'svelte';
import { emptySnapshot } from './snapshot.ts';
import { aBot, aDirect, aGroup, aMessage, anAttachment, fakeRuntime } from './test-fixtures.ts';
import { reactive } from './test-reactive.svelte.ts';
import { click, render } from './test-render.ts';
import { makeLeaf } from './workbench/layout-tree.ts';
import { settle } from './test-async.ts';
import { loadShell, storedTabs } from './test-shell-kit.ts';

const Shell = await loadShell();

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

/**
 * Every prop of the file pane comes off one object the shell derives from the snapshot, so a
 * snapshot that says nothing new still re-runs the pane's effects. Letting go of the listing there
 * — and pulling the same job again — is what made the tree blink while a conversation was live.
 * Opened from the flow chart, which names the job, so the tree is the job's.
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
  }, { selectedId: session.id, previewRelpath: 'work/plan.md', previewMessageId: 'm1', previewTaskId: 'task-1' }));
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

/** A terminal asked for from the tree takes the screen, so the explorer drawn over it goes first. */
test('a terminal opened from the workspace explorer closes the explorer and starts in that folder', async () => {
  const order: string[] = [];
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [aDirect()],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, {
    workspaceOpen: true,
    workspaceSelected: '',
    closeWorkspace: () => order.push('closeWorkspace'),
    openTerminalAt: async (dir: string) => void order.push(`openTerminalAt ${dir}`),
  }));
  runtime.client = {
    kind: 'local',
    workspaceTree: async (path = '') => ({ path, truncated: false, items: [
      { name: 'docs', path: 'docs', kind: 'dir' },
      { name: 'plan.md', path: 'plan.md', kind: 'file' },
    ] }),
    getWorkspaceFileBlob: async () => new Blob(['# plan'], { type: 'text/markdown' }),
  } as never;
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  await settle();
  const row = [...host.querySelectorAll<HTMLElement>('.artifact-tree-row')].find((el) => el.textContent?.trim().endsWith('docs'))!;
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
  flushSync();
  click(document.querySelector('[data-testid="artifact-tree-menu"] [data-open-terminal]'));
  await settle();
  expect(order).toEqual(['closeWorkspace', 'openTerminalAt /fixture/docs']);
});

/** In a pane the tree stays where it is; the terminal gets a tab of its own elsewhere. */
test('a terminal opened from a workspace pane starts in the folder that holds the file and leaves the pane alone', async () => {
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
  runtime.client = {
    kind: 'local',
    workspaceTree: async (path = '') => ({ path, truncated: false, items: [
      { name: 'docs', path: 'docs', kind: 'dir' },
      { name: 'plan.md', path: 'plan.md', kind: 'file' },
    ] }),
    getWorkspaceFileBlob: async () => new Blob(['# plan'], { type: 'text/markdown' }),
  } as never;
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  await settle();
  await settle();
  const row = [...host.querySelectorAll<HTMLElement>('.artifact-tree-row')].find((el) => el.textContent?.trim() === 'plan.md')!;
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
  flushSync();
  click(document.querySelector('[data-testid="artifact-tree-menu"] [data-open-terminal]'));
  await settle();
  expect(runtime.calls.filter((call) => call.name === 'openTerminalAt').map((call) => call.args)).toEqual([['/fixture']]);
  expect(runtime.calls.some((call) => call.name === 'closeWorkspace')).toBe(false);
  expect(storedTabs().some((tab) => tab.kind === 'workspace')).toBe(true);
  localStorage.removeItem('real-bot-workbench-layout');
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
 * A message's entry opens the files that message names: its attachments and its `附件：` lines,
 * which the bubble's entry counts too — including the file that is open. What else the job cited
 * stays out, and the job is not even asked.
 */
test('the file tree lists what the message handed over, not the rest of the job', async () => {
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
  let pulls = 0;
  runtime.client = {
    kind: 'local',
    taskArtifacts: async () => {
      pulls += 1;
      return {
        id: 'task-1', dir: 'work/task', title: 'plan', closed_at: null,
        items: [
          { path: 'BEACON/docs/plan.md', last_cited_at: 'now', turn_id: null },
          { path: 'BEACON/docs/outline.md', last_cited_at: 'now', turn_id: null },
        ],
      };
    },
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
  // outline.md is the job's, cited by some other message.
  expect(pulls).toBe(0);
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
  // The preview tab is named for the conversation, and picking another file does not retitle it. It
  // opened in a pane beside the conversation, which stays in front where it was.
  const inFront = () => [...host.querySelectorAll('[role="tab"][aria-selected="true"]')].map((tab) => tab.textContent?.trim());
  expect(inFront()).toEqual(['Researcher', "Researcher's artifacts"]);
  expect(host.querySelectorAll('[role="tab"]').length).toBe(tabs);
  expect(rows().map((row) => row.title)).toContain('work/plan.md');
});

test('the pane a message adds on the workbench lists only the files that message names', async () => {
  localStorage.removeItem('real-bot-workbench-layout');
  const session = aDirect();
  const attachments = ['plan.md', 'notes.md'].map((name, i) => anAttachment({
    id: `own-att-${i}`, message_id: 'own-message', workspace_relpath: `work/${name}`,
    original_filename: name, mime: 'text/markdown',
  }));
  const runtime = reactive(fakeRuntime({
    bots: [aBot()], sessions: [session],
    messages: [aMessage({ id: 'own-message', session_id: session.id, kind: 'bot', author: 'bot-1', task_id: 'task-1', attachments })],
    settings: { ...emptySnapshot().settings, locale: 'en', wizard_complete: true, workspace_path: '/fixture' },
  }, { selectedId: session.id }));
  let pulls = 0;
  runtime.client = {
    kind: 'local',
    taskArtifacts: async () => {
      pulls += 1;
      return {
        id: 'task-1', dir: 'work', title: 'plan', closed_at: null,
        items: ['plan.md', 'notes.md', 'earlier.md'].map((name) => ({ path: `work/${name}`, last_cited_at: 'now', turn_id: null })),
      };
    },
    getAttachmentBlob: async (id: string) => new Blob([`# ${id}`], { type: 'text/markdown' }),
    getWorkspaceFileBlob: async (path: string) => new Blob([`# ${path}`], { type: 'text/markdown' }),
  } as never;
  const { host, close } = render(Shell, { runtime });
  cleanups.push(close);
  click(host.querySelector('.attachment-bundle-btn'));
  await settle();
  await settle();
  const files = [...host.querySelectorAll<HTMLButtonElement>('.artifact-tree-row')]
    .map((row) => row.title)
    .filter((title) => title.includes('.'));
  // earlier.md is a file the job cited in another message.
  expect(files.sort()).toEqual(['work/notes.md', 'work/plan.md']);
  expect(pulls).toBe(0);
  localStorage.removeItem('real-bot-workbench-layout');
});
