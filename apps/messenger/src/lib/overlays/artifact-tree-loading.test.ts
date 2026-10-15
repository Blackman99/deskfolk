import { expect, mock, test } from 'bun:test';
import { flushSync } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { TaskArtifacts, WorkspaceTreePage } from '@real-bot/protocol';
import { copyFor } from '../copy.ts';
import { click, render } from '../test-render.ts';
import { mockMonacoCss } from '../test-mocks.ts';

mockMonacoCss();
const { default: ArtifactPreview } = await import('./ArtifactPreview.svelte');
const t = copyFor('zh');

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
	return { promise, resolve, reject };
}
async function settle() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	flushSync();
}
function open(workspaceTree: (path: string) => Promise<WorkspaceTreePage>) {
	return render(ArtifactPreview, {
		attachment: null, relpath: '', siblings: [],
		api: { kind: 'remote', workspaceTree } as never,
		workspacePath: '/workspace', t, mode: 'workspace', onClose() {}, onSelect() {},
	});
}
const page = (items: WorkspaceTreePage['items']): WorkspaceTreePage => ({ path: '', items, truncated: false });

test('workspace tree shows pending root loading before an empty result', async () => {
	const pending = deferred<WorkspaceTreePage>();
	const { host, close } = open(() => pending.promise);
	try {
		expect(host.querySelector('.artifact-tree [role="status"]')?.textContent).toContain('正在加载文件列表');
		expect(host.querySelector('.artifact-tree')?.textContent).not.toContain(t.stream.workspaceEmpty);
		pending.resolve(page([]));
		await settle();
		expect(host.querySelector('.artifact-tree')?.textContent).toContain(t.stream.workspaceEmpty);
		expect(host.querySelector('.artifact-tree [aria-busy="true"]')).toBeNull();
	} finally { close(); }
});

test('workspace root failures stay visible and retry only on request', async () => {
	const pending = deferred<WorkspaceTreePage>();
	let calls = 0;
	const { host, close } = open(() => ++calls === 1 ? pending.promise : Promise.resolve(page([])));
	try {
		pending.reject(new Error('offline'));
		await settle();
		expect(calls).toBe(1);
		expect(host.querySelector('.artifact-tree [role="alert"]')).not.toBeNull();
		click(host.querySelector('.artifact-tree-retry'));
		await settle();
		expect(calls).toBe(2);
		expect(host.querySelector('.artifact-tree')?.textContent).toContain(t.stream.workspaceEmpty);
	} finally { close(); }
});

test('expanding a folder shows loading, deduplicates reopen, and supports retry and empty state', async () => {
	const pending = deferred<WorkspaceTreePage>();
	let calls = 0;
	const { host, close } = open((path) => {
		if (!path) return Promise.resolve(page([{ name: 'docs', path: 'docs', kind: 'dir' }]));
		return ++calls === 1 ? pending.promise : Promise.resolve(page([]));
	});
	try {
		await settle();
		const folder = host.querySelector('.artifact-tree-row');
		click(folder);
		expect(host.querySelector('.artifact-tree [role="status"]')?.textContent).toContain('正在加载文件列表');
		click(folder);
		click(folder);
		expect(calls).toBe(1);
		pending.reject(new Error('offline'));
		await settle();
		expect(host.querySelector('.artifact-tree [role="alert"]')).not.toBeNull();
		click(host.querySelector('.artifact-tree-retry'));
		await settle();
		expect(calls).toBe(2);
		expect(host.querySelector('.artifact-tree')?.textContent).toContain(t.stream.workspaceEmpty);
		click(folder);
		click(folder);
		expect(calls).toBe(2);
	} finally { close(); }
});

test('cited preview exposes its picker while task files load and retries failures', async () => {
	const pending = deferred<TaskArtifacts>();
	let calls = 0;
	const { host, close } = render(ArtifactPreview, {
		attachment: null, relpath: '', siblings: [], taskId: 'task-1', forceTree: true,
		api: { kind: 'remote', taskArtifacts: () => { calls++; return pending.promise; } } as never,
		workspacePath: '/workspace', t, onClose() {}, onSelect() {},
	});
	try {
		expect(host.querySelector('.artifact-picker-btn')).not.toBeNull();
		click(host.querySelector('.artifact-picker-btn'));
		expect(host.querySelector('.artifact-tree [role="status"]')?.textContent).toContain('正在加载文件列表');
		pending.reject(new Error('offline'));
		await settle();
		expect(host.querySelector('.artifact-tree [role="alert"]')).not.toBeNull();
		click(host.querySelector('.artifact-tree-retry'));
		await settle();
		expect(calls).toBe(2);
	} finally { close(); }
});

for (const outcome of ['resolve', 'reject'] as const) {
	test(`workspace replacement ignores stale root ${outcome}`, async () => {
		const old = deferred<WorkspaceTreePage>();
		const current = deferred<WorkspaceTreePage>();
		const clients = new SvelteMap([['api', { kind: 'remote', workspaceTree: () => old.promise }]]);
		const { host, close } = render(ArtifactPreview, {
			attachment: null, relpath: '', siblings: [],
			get api() { return clients.get('api') as never; },
			workspacePath: '/workspace', t, mode: 'workspace', onClose() {}, onSelect() {},
		});
		try {
			clients.set('api', { kind: 'remote', workspaceTree: () => current.promise });
			flushSync();
			if (outcome === 'resolve') old.resolve(page([{ name: 'obsolete', path: 'obsolete', kind: 'dir' }]));
			else old.reject(new Error('old connection'));
			await settle();
			expect(host.querySelector('.artifact-tree [aria-busy="true"]')).not.toBeNull();
			expect(host.querySelector('.artifact-tree [role="alert"]')).toBeNull();
			expect(host.querySelector('.artifact-tree')?.textContent).not.toContain('obsolete');
			current.resolve(page([]));
			await settle();
			expect(host.querySelector('.artifact-tree')?.textContent).toContain(t.stream.workspaceEmpty);
		} finally { close(); }
	});
}

test('task replacement ignores stale results and preserves the empty picker', async () => {
	const old = deferred<TaskArtifacts>();
	const current = deferred<TaskArtifacts>();
	const selection = new SvelteMap([['task', 'old']]);
	const { host, close } = render(ArtifactPreview, {
		attachment: null, relpath: '', siblings: [],
		get taskId() { return selection.get('task'); },
		api: { kind: 'remote', taskArtifacts: (id: string) => id === 'old' ? old.promise : current.promise } as never,
		workspacePath: '/workspace', t, onClose() {}, onSelect() {},
	});
	try {
		selection.set('task', 'new');
		flushSync();
		old.resolve({ id: 'old', dir: 'obsolete', title: '', closed_at: null, items: [] });
		await settle();
		expect(host.querySelector('.artifact-tree [aria-busy="true"]')).not.toBeNull();
		expect(host.querySelector('.artifact-tree')?.textContent).not.toContain('obsolete');
		current.resolve({ id: 'new', dir: '', title: '', closed_at: null, items: [] });
		await settle();
		expect(host.querySelector('.artifact-picker-btn')).not.toBeNull();
		expect(host.querySelector('.artifact-tree')?.textContent).toContain(t.stream.artifactTreeEmpty);
	} finally { close(); }
});

test('a folder a message cites lists what is in it, in the tree and on its page', async () => {
	const asked: string[] = [];
	const dir = 'work/mv/voice_samples/ja';
	const { host, close } = render(ArtifactPreview, {
		attachment: null, relpath: dir,
		siblings: [{ id: `virtual-m-${dir}/`, message_id: 'm', workspace_relpath: `${dir}/`, original_filename: 'ja', created_at: '' }],
		api: {
			kind: 'remote',
			workspaceTree: (path: string) => {
				asked.push(path);
				return path === dir
					? Promise.resolve({ path, truncated: false, items: [
						{ name: 'a.wav', path: `${dir}/a.wav`, kind: 'file' },
						{ name: 'b.wav', path: `${dir}/b.wav`, kind: 'file' },
					] })
					: Promise.reject(new Error('path is not a directory'));
			},
		} as never,
		workspacePath: '/workspace', t, mode: 'cited', onClose() {}, onSelect() {},
	});
	try {
		await settle();
		expect(asked).toEqual([dir]);
		const rows = [...host.querySelectorAll('.artifact-tree-row')].map((row) => row.textContent?.trim());
		expect(rows).toContain('a.wav');
		expect(rows).toContain('b.wav');
		const entries = [...host.querySelectorAll('.artifact-dir-entry')].map((row) => row.textContent?.trim());
		expect(entries).toEqual(['a.wav', 'b.wav']);
		expect(host.textContent).not.toContain(t.stream.artifactUnsupported);
	} finally { close(); }
});

test('a cited file whose name says what it is is never asked about', async () => {
	let calls = 0;
	const { host, close } = render(ArtifactPreview, {
		attachment: null, relpath: 'work/Makefile',
		siblings: [{ id: 'x', message_id: 'm', workspace_relpath: 'work/Makefile', original_filename: 'Makefile', created_at: '' }],
		api: { kind: 'remote', workspaceTree: () => { calls += 1; return Promise.reject(new Error('path is not a directory')); } } as never,
		workspacePath: '/workspace', t, mode: 'cited', onClose() {}, onSelect() {},
	});
	try {
		await settle();
		await settle();
		expect(calls).toBe(0);
		expect(host.querySelector('.artifact-dir-list')).toBeNull();
	} finally { close(); }
});

test('a folder elsewhere on the Mac, cited from ~, lists what is in it and opens its entries by that spelling', async () => {
	const asked: string[] = [];
	const picked: string[] = [];
	const dir = '~/my-projects/curio';
	const { host, close } = render(ArtifactPreview, {
		attachment: null, relpath: dir,
		siblings: [{ id: 'att-1', message_id: 'm', workspace_relpath: 'work/shots/hall.png', original_filename: 'hall.png', created_at: '' }],
		api: {
			kind: 'remote',
			workspaceTree: (path: string) => {
				asked.push(path);
				// The Mac answers from where the folder really is.
				if (path === '~') return Promise.resolve({ path: '/Users/me', truncated: false, items: [] });
				return path === dir
					? Promise.resolve({ path: '/Users/me/my-projects/curio', truncated: false, items: [
						{ name: 'lumen-landing', path: '/Users/me/my-projects/curio/lumen-landing', kind: 'dir' },
						{ name: 'demos.json', path: '/Users/me/my-projects/curio/demos.json', kind: 'file' },
					] })
					: Promise.reject(new Error('path is not a directory'));
			},
		} as never,
		workspacePath: '/workspace', t, mode: 'cited', onClose() {},
		onSelect(row: { workspace_relpath: string }) { picked.push(row.workspace_relpath); },
	});
	try {
		await settle();
		expect(asked.sort()).toEqual(['~', dir]);
		const entries = [...host.querySelectorAll('.artifact-dir-entry')];
		// Each entry leads with its kind's glyph (a JSON file's is `{}`); the name ends the row.
		expect(entries.map((row) => row.textContent?.trim().split(/\s+/).pop())).toEqual(['lumen-landing', 'demos.json']);
		click(entries[1]!);
		expect(picked).toEqual([`${dir}/demos.json`]);
	} finally { close(); }
});
