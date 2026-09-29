import { expect, mock, test } from 'bun:test';
import { flushSync } from 'svelte';
import type { WorkspaceTreePage } from '@real-bot/protocol';
import { copyFor } from '../copy.ts';
import { render } from '../test-render.ts';
import { workspaceDrag, workspaceDropTarget, type WorkspaceDragItem } from '../workspace-drag.svelte.ts';
import ArtifactTree from './ArtifactTree.svelte';

mock.module('monaco-editor-css', () => ({}));
mock.module('monaco-editor/esm/vs/platform/hover/browser/hover.css', () => ({}));
mock.module('monaco-editor/esm/vs/base/browser/ui/contextview/contextview.css', () => ({}));
const { default: ArtifactPreview } = await import('./ArtifactPreview.svelte');
const t = copyFor('zh');

async function settle() {
	for (let i = 0; i < 6; i++) await Promise.resolve();
	flushSync();
}

const ROOT: WorkspaceTreePage['items'] = [
	{ name: 'docs', path: 'docs', kind: 'dir' },
	{ name: 'a.md', path: 'a.md', kind: 'file' },
	{ name: 'b.md', path: 'b.md', kind: 'file' },
];

function openExplorer() {
	const selects: string[] = [];
	const view = render(ArtifactPreview, {
		attachment: null, relpath: 'a.md', siblings: [],
		api: {
			kind: 'remote',
			workspaceTree: async (path: string) => ({ path, truncated: false, items: path ? [] : ROOT }),
			getWorkspaceFileBlob: async () => new Blob(['# a\n'], { type: 'text/markdown' }),
		} as never,
		workspacePath: '/Users/you/work', t, mode: 'workspace', onClose() {}, onSelect() {},
		onSelectWorkspacePath: (path: string) => selects.push(path),
	});
	return { ...view, selects };
}

function row(host: HTMLElement, path: string): HTMLButtonElement {
	const found = host.querySelector<HTMLButtonElement>(`.artifact-tree-row[data-path="${path}"]`);
	if (!found) throw new Error(`no row ${path}`);
	return found;
}

function pointer(type: string, x: number, y: number): PointerEvent {
	return new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: 'mouse' });
}

/** Press on a row and move well past the threshold; the drag is then under way. */
function dragFrom(el: Element): void {
	el.dispatchEvent(pointer('pointerdown', 10, 10));
	window.dispatchEvent(pointer('pointermove', 60, 80));
	flushSync();
}

/** Release, and the click a browser fires on the pressed row after it. */
function releaseOn(el: Element): void {
	window.dispatchEvent(pointer('pointerup', 60, 80));
	el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	flushSync();
}

test('a row of the workspace explorer drags out by its path; picked rows go together', async () => {
	const { host, close, selects } = openExplorer();
	const composer = document.createElement('div');
	document.body.append(composer);
	const dropped: WorkspaceDragItem[][] = [];
	const target = workspaceDropTarget(composer, { accepts: () => true, drop: (items) => dropped.push(items) });
	const elementFromPoint = document.elementFromPoint;
	document.elementFromPoint = () => composer;
	try {
		await settle();
		dragFrom(row(host, 'b.md'));
		expect(workspaceDrag.current?.items).toEqual([{ path: 'b.md', isDir: false }]);
		expect(workspaceDrag.current?.label).toBe('b.md');
		releaseOn(row(host, 'b.md'));
		expect(dropped).toEqual([[{ path: 'b.md', isDir: false }]]);
		// Dragged onto the composer, the row did not also open.
		expect(selects).toEqual([]);

		// ⌘-click adds to the file on screen; dragging one of them takes both, and a folder says it is one.
		row(host, 'docs').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
		flushSync();
		dragFrom(row(host, 'a.md'));
		expect(workspaceDrag.current?.label).toBe(t.stream.dragItems(2));
		releaseOn(row(host, 'a.md'));
		expect(dropped[1]).toEqual([{ path: 'docs', isDir: true }, { path: 'a.md', isDir: false }]);

		// A row outside what is picked goes alone.
		dragFrom(row(host, 'b.md'));
		releaseOn(row(host, 'b.md'));
		expect(dropped[2]).toEqual([{ path: 'b.md', isDir: false }]);
		expect(selects).toEqual([]);
	} finally {
		document.elementFromPoint = elementFromPoint;
		target.destroy();
		composer.remove();
		close();
	}
});

test('a tree given no drag label keeps its rows where they are', () => {
	const view = render(ArtifactTree, {
		nodes: [{ name: 'a.md', path: 'a.md', kind: 'file' }],
		selected: '', label: 'files', onSelect() {},
		loadingLabel: '', failedLabel: '', emptyLabel: '', retryLabel: '',
	});
	try {
		dragFrom(row(view.host, 'a.md'));
		expect(workspaceDrag.current).toBeNull();
		window.dispatchEvent(pointer('pointerup', 60, 80));
	} finally {
		view.close();
	}
});
