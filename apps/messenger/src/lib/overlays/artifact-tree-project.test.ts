import { expect, test } from 'bun:test';
import { flushSync } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { SessionSummary, WorkspaceTreePage } from '@real-bot/protocol';
import { copyFor } from '../copy.ts';
import { click, render } from '../test-render.ts';
import { mockMonacoCss } from '../test-mocks.ts';
import { projectDirOf } from './artifact-lookup.ts';

mockMonacoCss();
const { default: ArtifactPreview } = await import('./ArtifactPreview.svelte');
const t = copyFor('zh');

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	flushSync();
}

type Entry = WorkspaceTreePage['items'][number];
const dir = (name: string): Entry => ({ name, path: `/private/elsewhere/${name}`, kind: 'dir' });
const file = (name: string): Entry => ({ name, path: `/private/elsewhere/${name}`, kind: 'file' });

/** The Mac's folders, answered one at a time so the test sees which were asked before which came. */
function mac(listings: Record<string, Entry[]>) {
	const asked: string[] = [];
	const waiting: Array<() => void> = [];
	const workspaceTree = (path: string) => {
		asked.push(path);
		return new Promise<WorkspaceTreePage>((resolve, reject) => {
			waiting.push(() => {
				const items = listings[path];
				if (items) resolve({ path, items, truncated: false });
				else reject(new Error(`not listed: ${path}`));
			});
		});
	};
	return {
		asked,
		workspaceTree,
		/** Answers everything asked so far. */
		async answer() {
			while (waiting.length) waiting.shift()!();
			await settle();
		},
	};
}

function open(relpath: string, workspaceTree: (path: string) => Promise<WorkspaceTreePage>, extra: Record<string, unknown> = {}) {
	const selected: string[] = [];
	const shown = new SvelteMap([['relpath', relpath]]);
	const view = render(ArtifactPreview, {
		attachment: null,
		get relpath() {
			return shown.get('relpath') ?? '';
		},
		siblings: [],
		api: { kind: 'remote', workspaceTree, getWorkspaceFileBlob: async () => new Blob(['x'], { type: 'text/plain' }) } as never,
		workspacePath: '/workspace',
		projectDir: '/proj/',
		t,
		onClose() {},
		onSelect(att: { workspace_relpath: string }) {
			selected.push(att.workspace_relpath);
		},
		...extra,
	});
	return {
		...view,
		selected,
		/** The host shows another file, as a click in the tree or the chat makes it. */
		show(path: string) {
			shown.set('relpath', path);
			flushSync();
		},
	};
}

const row = (host: HTMLElement, path: string) => host.querySelector<HTMLElement>(`.artifact-tree-row[data-path="${path}"]`);

test("a project session's file opens in the project's tree, the folders down to it listed in turn and open", async () => {
	const disk = mac({
		'/proj': [dir('src'), file('README.md')],
		'/proj/src': [dir('lib'), file('main.ts')],
		'/proj/src/lib': [file('api.ts'), file('db.ts')],
	});
	const { host, close } = open('/proj/src/lib/api.ts', disk.workspaceTree);
	try {
		await settle();
		// A folder's entries are asked for only once the folder above it is in the tree.
		expect(disk.asked).toEqual(['/proj']);
		await disk.answer();
		expect(disk.asked).toEqual(['/proj', '/proj/src']);
		await disk.answer();
		expect(disk.asked).toEqual(['/proj', '/proj/src', '/proj/src/lib']);
		await disk.answer();

		// Spelled the way the agent's paths are, whatever spelling the Mac answers with.
		expect(row(host, '/proj/README.md')).not.toBeNull();
		expect(row(host, '/proj/src')?.getAttribute('aria-expanded')).toBe('true');
		expect(row(host, '/proj/src/lib')?.getAttribute('aria-expanded')).toBe('true');
		expect(row(host, '/proj/src/lib/db.ts')).not.toBeNull();
		expect(row(host, '/proj/src/lib/api.ts')?.classList.contains('is-selected')).toBe(true);
		expect(host.querySelector('.artifact-tree')?.getAttribute('aria-label')).toBe('proj');
	} finally {
		close();
	}
});

test('in the project tree a folder opens in place and a file opens in the preview', async () => {
	const disk = mac({
		'/proj': [dir('docs'), file('a.ts')],
		'/proj/docs': [file('guide.md')],
	});
	const { host, close, selected } = open('/proj/a.ts', disk.workspaceTree);
	try {
		await settle();
		await disk.answer();
		click(row(host, '/proj/docs'));
		expect(disk.asked).toEqual(['/proj', '/proj/docs']);
		await disk.answer();
		expect(row(host, '/proj/docs')?.getAttribute('aria-expanded')).toBe('true');
		expect(selected).toEqual([]);
		click(row(host, '/proj/docs/guide.md'));
		expect(selected).toEqual(['/proj/docs/guide.md']);
	} finally {
		close();
	}
});

test('walking to another file in the project keeps the listing and opens its folders', async () => {
	const disk = mac({
		'/proj': [dir('a'), dir('b')],
		'/proj/a': [file('one.ts')],
		'/proj/b': [file('two.ts')],
	});
	const view = open('/proj/a/one.ts', disk.workspaceTree);
	try {
		await settle();
		await disk.answer();
		await disk.answer();
		view.show('/proj/b/two.ts');
		await settle();
		expect(disk.asked).toEqual(['/proj', '/proj/a', '/proj/b']);
		await disk.answer();
		expect(row(view.host, '/proj/a')?.getAttribute('aria-expanded')).toBe('true');
		expect(row(view.host, '/proj/b')?.getAttribute('aria-expanded')).toBe('true');
		expect(row(view.host, '/proj/b/two.ts')?.classList.contains('is-selected')).toBe(true);
	} finally {
		view.close();
	}
});

test("a project's root that fails to list says so and lists again on request", async () => {
	let calls = 0;
	const { host, close } = open('/proj/a.ts', (path) => {
		calls++;
		return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ path, items: [file('a.ts')], truncated: false });
	});
	try {
		await settle();
		expect(host.querySelector('.artifact-tree [role="alert"]')).not.toBeNull();
		click(host.querySelector('.artifact-tree-retry'));
		await settle();
		expect(calls).toBe(2);
		expect(row(host, '/proj/a.ts')?.classList.contains('is-selected')).toBe(true);
	} finally {
		close();
	}
});

test('a file outside the project keeps the tree of what the message cited', async () => {
	const disk = mac({});
	const { host, close } = open('uploads/shot.png', disk.workspaceTree, {
		siblings: [
			{ id: 'a1', message_id: 'm1', workspace_relpath: 'uploads/shot.png', original_filename: 'shot.png', created_at: '' },
			{ id: 'a2', message_id: 'm1', workspace_relpath: 'uploads/log.txt', original_filename: 'log.txt', created_at: '' },
		],
	});
	try {
		await settle();
		expect(disk.asked).toEqual([]);
		expect(host.querySelector('.artifact-tree')?.getAttribute('aria-label')).toBe(t.stream.artifactTree);
		expect(row(host, 'uploads/log.txt')).not.toBeNull();
	} finally {
		close();
	}
});

test('projectDirOf names the directory of a project session only', () => {
	const sessions = [
		{ id: 'p1', kind: 'project', project_dir: '/Users/a/proj' },
		{ id: 'd1', kind: 'direct', project_dir: null },
	] as SessionSummary[];
	expect(projectDirOf(sessions, 'p1')).toBe('/Users/a/proj');
	expect(projectDirOf(sessions, 'd1')).toBeNull();
	expect(projectDirOf(sessions, 'missing')).toBeNull();
	expect(projectDirOf(sessions, null)).toBeNull();
});
