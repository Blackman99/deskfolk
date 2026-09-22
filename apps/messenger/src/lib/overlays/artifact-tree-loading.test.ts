import { expect, mock, test } from 'bun:test';
import { flushSync } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { TaskArtifacts, WorkspaceTreePage } from '@real-bot/protocol';
import { copyFor } from '../copy.ts';
import { click, render } from '../test-render.ts';

mock.module('monaco-editor-css', () => ({}));
mock.module('monaco-editor/esm/vs/platform/hover/browser/hover.css', () => ({}));
mock.module('monaco-editor/esm/vs/base/browser/ui/contextview/contextview.css', () => ({}));
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
