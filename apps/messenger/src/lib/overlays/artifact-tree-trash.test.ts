import { expect, mock, test } from 'bun:test';
import { flushSync } from 'svelte';
import type { WorkspaceTrashResult, WorkspaceTreePage } from '@real-bot/protocol';
import { copyFor } from '../copy.ts';
import { click, press, render } from '../test-render.ts';

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
	{ name: 'c.md', path: 'c.md', kind: 'file' },
];

/** The workspace explorer on `a.md`, with a Mac whose Trash answers `trash`. */
function open(trash?: (paths: string[]) => Promise<WorkspaceTrashResult>) {
	const asked: string[][] = [];
	const selects: string[] = [];
	const view = render(ArtifactPreview, {
		attachment: null, relpath: 'a.md', siblings: [],
		api: {
			kind: 'remote',
			workspaceTree: async (path: string) => ({ path, truncated: false, items: path ? [] : ROOT }),
			getWorkspaceFileBlob: async () => new Blob(['# a\n'], { type: 'text/markdown' }),
			...(trash ? { trashWorkspacePaths: (paths: string[]) => { asked.push(paths); return trash(paths); } } : {}),
		} as never,
		workspacePath: '/Users/you/work', t, mode: 'workspace', onClose() {}, onSelect() {},
		onSelectWorkspacePath: (path: string) => selects.push(path),
	});
	return { ...view, asked, selects };
}

function row(host: HTMLElement, path: string): HTMLButtonElement {
	const found = host.querySelector<HTMLButtonElement>(`.artifact-tree-row[data-path="${path}"]`);
	if (!found) throw new Error(`no row ${path}`);
	return found;
}

function clickRow(host: HTMLElement, path: string, init: MouseEventInit = {}): void {
	row(host, path).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
	flushSync();
}

function picked(host: HTMLElement): string[] {
	return [...host.querySelectorAll<HTMLElement>('.artifact-tree-row.is-selected')].map((el) => el.dataset.path ?? '');
}

function menuOn(host: HTMLElement, path: string): HTMLElement {
	row(host, path).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
	flushSync();
	return document.querySelector<HTMLElement>("[data-testid='artifact-tree-menu']")!;
}

const dialog = () => document.querySelector<HTMLDialogElement>('dialog.confirm-backdrop');
const confirmButton = () => dialog()?.querySelector<HTMLButtonElement>('.modal-foot .deny');

test('⌘-click adds rows to the file on screen, Shift-click picks a range, a plain click goes back to one', async () => {
	const { host, close, selects } = open();
	try {
		await settle();
		expect(picked(host)).toEqual(['a.md']);
		clickRow(host, 'c.md', { metaKey: true });
		expect(picked(host)).toEqual(['a.md', 'c.md']);
		expect(selects).toEqual([]);
		clickRow(host, 'a.md', { ctrlKey: true });
		expect(picked(host)).toEqual(['c.md']);
		// The range runs from the last row clicked, and a second Shift-click keeps that end.
		clickRow(host, 'c.md', { shiftKey: true });
		expect(picked(host)).toEqual(['a.md', 'b.md', 'c.md']);
		clickRow(host, 'docs', { shiftKey: true });
		expect(picked(host)).toEqual(['docs', 'a.md']);
		press(row(host, 'b.md'), 'Escape');
		expect(picked(host)).toEqual(['a.md']);
		clickRow(host, 'b.md', { metaKey: true });
		clickRow(host, 'c.md');
		expect(selects).toEqual(['c.md']);
		expect(picked(host)).toEqual(['a.md']);
	} finally { close(); }
});

test('the menu of a picked row acts on every picked row; one outside the pick takes it over', async () => {
	const copied: string[] = [];
	const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
	Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
	const { host, close } = open(async (paths) => ({ trashed: paths, failed: [] }));
	try {
		await settle();
		clickRow(host, 'b.md', { metaKey: true });
		let menu = menuOn(host, 'b.md');
		expect(menu.querySelector('[data-open]')).toBeNull();
		expect(menu.querySelector('[data-reveal]')).toBeNull();
		expect(menu.querySelector('[data-trash]')?.textContent?.trim()).toBe(t.stream.artifactTrashCount(2));
		click(menu.querySelector('[data-copy-abs-path]'));
		await settle();
		expect(copied).toEqual(['/Users/you/work/a.md\n/Users/you/work/b.md']);
		// A right-click outside what is picked is about that row alone, and the highlight says so.
		menu = menuOn(host, 'c.md');
		expect(picked(host)).toEqual(['c.md']);
		expect(menu.querySelector('[data-open]')).not.toBeNull();
		expect(menu.querySelector('[data-trash]')?.textContent?.trim()).toBe(t.stream.artifactTrash);
		press(menu, 'Escape');
	} finally {
		close();
		if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
		else delete (navigator as { clipboard?: unknown }).clipboard;
	}
});

test('Move to Trash asks first, then takes the rows out of the tree and the file off the screen', async () => {
	const { host, close, asked } = open(async (paths) => ({ trashed: paths, failed: [] }));
	try {
		await settle();
		clickRow(host, 'docs', { metaKey: true });
		click(menuOn(host, 'docs').querySelector('[data-trash]'));
		expect(document.querySelector("[data-testid='artifact-tree-menu']")).toBeNull();
		expect(dialog()?.querySelector('h2')?.textContent).toBe(t.stream.artifactTrashTitle('docs', 2));
		const body = dialog()?.querySelector('.confirm-copy')?.textContent ?? '';
		expect(body).toBe(t.stream.artifactTrashBody(['docs', 'a.md'], 2, true, false));
		expect(asked).toEqual([]);
		click(confirmButton());
		await settle();
		expect(asked).toEqual([['docs', 'a.md']]);
		expect(dialog()).toBeNull();
		expect(host.querySelector('.artifact-tree-row[data-path="docs"]')).toBeNull();
		expect(host.querySelector('.artifact-tree-row[data-path="a.md"]')).toBeNull();
		expect(host.querySelector('.artifact-tree-row[data-path="b.md"]')).not.toBeNull();
		expect(host.textContent).toContain(t.stream.artifactMissing);
	} finally { close(); }
});

test('rows the Mac kept stay in the confirm with its reason, and a retry asks for them alone', async () => {
	let calls = 0;
	const { host, close, asked } = open(async (paths) => (++calls === 1
		? { trashed: ['b.md'], failed: [{ path: 'c.md', message: '权限不够' }] }
		: { trashed: paths, failed: [] }));
	try {
		await settle();
		clickRow(host, 'b.md');
		clickRow(host, 'c.md', { shiftKey: true });
		click(menuOn(host, 'c.md').querySelector('[data-trash]'));
		click(confirmButton());
		await settle();
		expect(host.querySelector('.artifact-tree-row[data-path="b.md"]')).toBeNull();
		expect(host.querySelector('.artifact-tree-row[data-path="c.md"]')).not.toBeNull();
		expect(dialog()?.querySelector('.confirm-copy')?.textContent).toBe(t.stream.artifactTrashFailed(1, '权限不够'));
		expect(confirmButton()?.textContent?.trim()).toBe(t.stream.artifactTrashRetry);
		click(confirmButton());
		await settle();
		expect(asked).toEqual([['b.md', 'c.md'], ['c.md']]);
		expect(dialog()).toBeNull();
		expect(host.querySelector('.artifact-tree-row[data-path="c.md"]')).toBeNull();
		// The file on screen was never in it.
		expect(host.textContent).not.toContain(t.stream.artifactMissing);
	} finally { close(); }
});

test('⌘⌫ on a focused row asks to trash it, or everything picked with it', async () => {
	const { host, close } = open(async (paths) => ({ trashed: paths, failed: [] }));
	try {
		await settle();
		press(row(host, 'b.md'), 'Backspace', { metaKey: true });
		expect(dialog()?.querySelector('h2')?.textContent).toBe(t.stream.artifactTrashTitle('b.md', 1));
		press(dialog(), 'Escape');
		expect(dialog()).toBeNull();
		clickRow(host, 'c.md', { metaKey: true });
		press(row(host, 'c.md'), 'Backspace', { metaKey: true });
		expect(dialog()?.querySelector('h2')?.textContent).toBe(t.stream.artifactTrashTitle('a.md', 2));
		press(dialog(), 'Escape');
		// A plain Backspace is not a delete.
		press(row(host, 'c.md'), 'Backspace');
		expect(dialog()).toBeNull();
	} finally { close(); }
});

/** A client that cannot reach the Mac's Trash never offers it. */
test('no Move to Trash without a client that can ask for it', async () => {
	const { host, close } = open();
	try {
		await settle();
		const menu = menuOn(host, 'b.md');
		expect(menu.querySelector('[data-trash]')).toBeNull();
		press(row(host, 'b.md'), 'Backspace', { metaKey: true });
		press(menu, 'Escape');
		expect(dialog()).toBeNull();
	} finally { close(); }
});
