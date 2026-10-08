<script lang="ts">
	import type { Copy } from '../copy.ts';
	import { computeContextMenuPosition } from '../sidebar/session-context-menu.ts';
	import { dismissOnOutside } from '../dismissable-menu.ts';
	import { roveArrows } from '../menu-roving.ts';

	type Props = {
		/** Viewport coordinates of the right-click. */
		x: number;
		y: number;
		t: Copy;
		onOpen: () => void;
		onReveal: () => void;
		/** Starts a terminal in the row's folder, or the folder a file sits in; absent where no terminal can open. */
		onOpenTerminal?: () => void;
		/** Copies the row's workspace-relative path; a folder's as much as a file's. */
		onCopyPath?: () => void;
		/** Copies the row's path on the machine; absent while the workspace root is unknown. */
		onCopyAbsPath?: () => void;
		/**
		 * How many rows the menu acts on. Above one, only what applies to all of them is offered:
		 * the copies (one path a line) and the Trash; opening, Finder and a terminal take one row.
		 */
		count?: number;
		/** Asks to move the rows to the Mac's Trash; absent where nothing can reach the Mac. */
		onTrash?: () => void;
		onClose: () => void;
	};

	let { x, y, t, onOpen, onReveal, onOpenTerminal, onCopyPath, onCopyAbsPath, count = 1, onTrash, onClose }: Props = $props();
	const single = $derived(count <= 1);

	let menuEl = $state<HTMLDivElement>();
	let placed = $state<{ x: number; y: number } | null>(null);
	const pos = $derived(placed ?? { x, y });

	/**
	 * Moved to `document.body`: a floating pane's transform would make `fixed` resolve against
	 * the pane, and a pane clips overflow.
	 */
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return { destroy: () => node.remove() };
	}

	$effect(() => {
		const menu = menuEl;
		if (!menu) return;
		const box = menu.getBoundingClientRect();
		placed = computeContextMenuPosition(x, y, box.width, box.height, window.innerWidth, window.innerHeight, 8);
	});

	const returnTo = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);

	$effect(() => {
		const menu = menuEl;
		if (!menu) return;
		return dismissOnOutside(menu, () => onClose());
	});

	function items(): HTMLElement[] {
		return [...(menuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
	}

	function onKey(event: KeyboardEvent): void {
		const list = items();
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onClose();
			if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			roveArrows(event, list);
		}
	}

	function pick(action: () => void): void {
		action();
		onClose();
	}
</script>

<div
	bind:this={menuEl}
	class="artifact-tree-menu"
	style:left={`${pos.x}px`}
	style:top={`${pos.y}px`}
	role="menu"
	tabindex="-1"
	aria-label={t.stream.artifactTree}
	data-testid="artifact-tree-menu"
	use:portal
	onkeydown={onKey}
	oncontextmenu={(event) => {
		event.preventDefault();
		event.stopPropagation();
	}}
>
	{#if single}
		<button type="button" class="artifact-tree-menu-item" role="menuitem" data-open onclick={() => pick(onOpen)}>
			{t.stream.artifactOpenSystem}
		</button>
		<button type="button" class="artifact-tree-menu-item" role="menuitem" data-reveal onclick={() => pick(onReveal)}>
			{t.stream.artifactReveal}
		</button>
		{#if onOpenTerminal}
			<button type="button" class="artifact-tree-menu-item" role="menuitem" data-open-terminal onclick={() => pick(onOpenTerminal)}>
				{t.stream.artifactOpenTerminal}
			</button>
		{/if}
		{#if onCopyPath || onCopyAbsPath}
			<div class="artifact-tree-menu-divider" role="separator"></div>
		{/if}
	{/if}
	{#if onCopyPath}
		<button type="button" class="artifact-tree-menu-item" role="menuitem" data-copy-path onclick={() => pick(onCopyPath)}>
			{t.stream.artifactCopyPath}
		</button>
	{/if}
	{#if onCopyAbsPath}
		<button type="button" class="artifact-tree-menu-item" role="menuitem" data-copy-abs-path onclick={() => pick(onCopyAbsPath)}>
			{t.stream.artifactCopyAbsPath}
		</button>
	{/if}
	{#if onTrash}
		{#if onCopyPath || onCopyAbsPath || single}
			<div class="artifact-tree-menu-divider" role="separator"></div>
		{/if}
		<button type="button" class="artifact-tree-menu-item is-danger" role="menuitem" data-trash onclick={() => pick(onTrash)}>
			{single ? t.stream.artifactTrash : t.stream.artifactTrashCount(count)}
		</button>
	{/if}
</div>

<style>
	.artifact-tree-menu {
		position: fixed;
		z-index: 1000;
		min-width: 196px;
		padding: 5px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-menu);
		user-select: none;
		outline: none;
	}

	.artifact-tree-menu-item {
		display: flex;
		align-items: center;
		width: 100%;
		padding: 6px 10px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink);
		font-size: 13px;
		font-weight: 500;
		text-align: left;
		cursor: pointer;
	}

	.artifact-tree-menu-divider {
		height: 1px;
		margin: 3px 8px;
		background: var(--line-subtle);
	}

	.artifact-tree-menu-item:hover,
	.artifact-tree-menu-item:focus-visible {
		background: var(--line-subtle);
		color: var(--accent);
		outline: none;
	}

	.artifact-tree-menu-item.is-danger:hover,
	.artifact-tree-menu-item.is-danger:focus-visible {
		background: var(--danger-bg);
		color: var(--danger);
	}

	@media (max-width: 680px) {
		.artifact-tree-menu-item {
			min-height: 44px;
		}
	}
</style>
