<script lang="ts">
	import type { Axis, TabAction } from './layout-types.ts';
	import type { Direction } from './layout-geometry.ts';
	import type { Copy } from '../copy.ts';
	import { computeContextMenuPosition } from '../sidebar/session-context-menu.ts';
	import { SPLIT_TOWARDS } from './workbench-commands.ts';

	type Props = {
		/** Viewport coordinates of the right-click, the way the other context menus take them. */
		x: number;
		y: number;
		t: Copy;
		/** What the menu is called. The pane's name unless it only holds a tab's actions. */
		label?: string;
		/** What the tab under the pointer offers, above everything else. */
		actions?: TabAction[];
		/** Whether the window has room for one more pane across (`row`) and down (`column`). */
		fits?: Record<Axis, boolean>;
		/** A floating pane is not split in place: it is docked first, which this menu offers. */
		floating?: boolean;
		/**
		 * Copy and Paste, when what was right-clicked keeps its own selection and takes its own
		 * paste — a terminal. `canCopy` is read once, at the right-click.
		 */
		edit?: { canCopy: boolean; onCopy: () => void; onPaste: () => void } | null;
		/** Left out, the menu offers no splits: a tab's ⋯ holds only what the tab offers. */
		onSplit?: (dir: Direction) => void;
		onDock?: () => void;
		onClosePane?: () => void;
		/**
		 * The button that opened the menu. A press on it is left to the button, which closes the
		 * menu itself; closing on the press as well would have the click open it straight again.
		 * Escape hands the keyboard back to it.
		 */
		anchor?: Element | null;
		onClose: () => void;
	};

	let {
		x,
		y,
		t,
		label,
		actions = [],
		fits = { row: false, column: false },
		floating = false,
		edit = null,
		onSplit,
		onDock,
		onClosePane,
		anchor = null,
		onClose
	}: Props = $props();

	/* Reading order of the request: up, down, left, right. The two with a key say which. */
	const items = $derived<{ dir: Direction; label: string; keys?: string }[]>([
		{ dir: 'up', label: t.pane.splitUp },
		{ dir: 'down', label: t.pane.splitDown, keys: '⇧⌘\\' },
		{ dir: 'left', label: t.pane.splitLeft },
		{ dir: 'right', label: t.pane.splitRight, keys: '⌘\\' }
	]);

	let menuEl = $state<HTMLDivElement>();
	let placed = $state<{ x: number; y: number } | null>(null);
	const pos = $derived(placed ?? { x, y });

	function disabledReason(dir: Direction): string | null {
		if (floating) return t.pane.dockToSplit;
		return fits[SPLIT_TOWARDS[dir].axis] ? null : t.pane.tooSmall;
	}

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

	/** Where the keyboard was before the menu took it, so Escape can hand it back. */
	const returnTo = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);

	$effect(() => {
		const menu = menuEl;
		if (!menu) return;
		queueMicrotask(() => enabledItems()[0]?.focus({ preventScroll: true }));
		const onDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!menu.contains(target) && !anchor?.contains(target)) onClose();
		};
		const onScroll = (event: Event) => {
			if (!menu.contains(event.target as Node)) onClose();
		};
		const dismiss = () => onClose();
		window.addEventListener('pointerdown', onDown, true);
		window.addEventListener('scroll', onScroll, true);
		window.addEventListener('resize', dismiss);
		window.addEventListener('blur', dismiss);
		return () => {
			window.removeEventListener('pointerdown', onDown, true);
			window.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', dismiss);
			window.removeEventListener('blur', dismiss);
		};
	});

	function enabledItems(): HTMLElement[] {
		return [...(menuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
	}

	/*
	 * Kept inside the menu: the shell unwinds Escape from the window, and the same keystroke must
	 * not also close the preview or the settings behind it.
	 */
	function onKey(event: KeyboardEvent): void {
		const list = enabledItems();
		const index = list.indexOf(document.activeElement as HTMLElement);
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			// Back to the button it hangs from, when it has one: clicking a button does not focus
			// it in WebKit, so what had focus at the click is often nothing at all. Read before
			// closing, which drops the host's record of that button.
			const back = anchor instanceof HTMLElement ? anchor : returnTo;
			onClose();
			if (back?.isConnected) back.focus({ preventScroll: true });
		} else if (event.key === 'Tab') {
			onClose();
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			event.stopPropagation();
			if (list.length === 0) return;
			const step = event.key === 'ArrowDown' ? 1 : -1;
			const next = index < 0 ? (step > 0 ? 0 : list.length - 1) : (index + step + list.length) % list.length;
			list[next]!.focus();
		} else if (event.key === 'Home' || event.key === 'End') {
			event.preventDefault();
			list[event.key === 'Home' ? 0 : list.length - 1]?.focus();
		}
	}

	/** Act first: closing drops the host's record of which pane was right-clicked. */
	function pick(action: () => void): void {
		action();
		onClose();
	}
</script>

<div
	bind:this={menuEl}
	class="wb-context-menu"
	style:left={`${pos.x}px`}
	style:top={`${pos.y}px`}
	role="menu"
	tabindex="-1"
	aria-label={label ?? t.pane.title}
	data-testid="wb-context-menu"
	use:portal
	onkeydown={onKey}
	oncontextmenu={(event) => {
		event.preventDefault();
		event.stopPropagation();
	}}
>
	{#each actions as action (action.id)}
		<button
			type="button"
			class="wb-context-item"
			class:is-active={action.active}
			role="menuitem"
			data-action={action.id}
			onclick={() => pick(action.run)}
		>
			<span class="wb-context-icon" aria-hidden="true">{#if action.icon}{@render action.icon()}{/if}</span>
			<span class="wb-context-label">{action.label}</span>
		</button>
	{/each}
	{#if actions.length > 0 && (edit || onSplit)}
		<div class="wb-context-divider" role="separator"></div>
	{/if}
	{#if edit}
		{@const editing = edit}
		<button
			type="button"
			class="wb-context-item"
			role="menuitem"
			data-edit="copy"
			disabled={!editing.canCopy}
			onclick={() => pick(editing.onCopy)}
		>
			<svg class="wb-context-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<rect x="8.5" y="8.5" width="11" height="11" rx="2"></rect>
				<path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"></path>
			</svg>
			<span class="wb-context-label">{t.pane.copy}</span>
			<span class="wb-context-keys" aria-hidden="true">⌘C</span>
		</button>
		<button type="button" class="wb-context-item" role="menuitem" data-edit="paste" onclick={() => pick(editing.onPaste)}>
			<svg class="wb-context-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<rect x="5.5" y="5.5" width="13" height="15" rx="2"></rect>
				<path d="M9.5 5.5V4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1"></path>
			</svg>
			<span class="wb-context-label">{t.pane.paste}</span>
			<span class="wb-context-keys" aria-hidden="true">⌘V</span>
		</button>
		{#if onSplit}
			<div class="wb-context-divider" role="separator"></div>
		{/if}
	{/if}
	{#if onSplit}
		{@const split = onSplit}
		{#each items as item (item.dir)}
			{@const reason = disabledReason(item.dir)}
			<button
				type="button"
				class="wb-context-item"
				role="menuitem"
				data-split={item.dir}
				disabled={reason !== null}
				title={reason ?? undefined}
				onclick={() => pick(() => split(item.dir))}
			>
				<svg class="wb-context-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
					<rect x="3.5" y="4.5" width="17" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"></rect>
					{#if item.dir === 'up'}
						<path d="M5 6h14v5.5H5z" fill="currentColor" opacity="0.45"></path>
					{:else if item.dir === 'down'}
						<path d="M5 12.5h14V18H5z" fill="currentColor" opacity="0.45"></path>
					{:else if item.dir === 'left'}
						<path d="M5 6h6.25v12H5z" fill="currentColor" opacity="0.45"></path>
					{:else}
						<path d="M12.75 6H19v12h-6.25z" fill="currentColor" opacity="0.45"></path>
					{/if}
				</svg>
				<span class="wb-context-label">{item.label}</span>
				{#if item.keys}
					<span class="wb-context-keys" aria-hidden="true">{item.keys}</span>
				{/if}
			</button>
		{/each}
	{/if}
	{#if floating && onDock}
		{@const dock = onDock}
		<div class="wb-context-divider" role="separator"></div>
		<button type="button" class="wb-context-item" role="menuitem" data-dock onclick={() => pick(dock)}>
			<svg class="wb-context-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<rect x="3.5" y="4.5" width="17" height="15" rx="2"></rect>
				<path d="M12 8v6m-3-3 3 3 3-3"></path>
			</svg>
			<span class="wb-context-label">{t.pane.dock}</span>
		</button>
	{/if}
	{#if onClosePane}
		{@const closePane = onClosePane}
		{#if actions.length > 0 || edit || onSplit || (floating && onDock)}
			<div class="wb-context-divider" role="separator"></div>
		{/if}
		<button type="button" class="wb-context-item" role="menuitem" data-close-pane onclick={() => pick(closePane)}>
			<svg class="wb-context-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
				<path d="m6 6 12 12M6 18 18 6"></path>
			</svg>
			<span class="wb-context-label">{t.pane.close}</span>
		</button>
	{/if}
</div>

<style>
	/* The same card as the conversation and message menus, so a right-click looks like one thing. */
	.wb-context-menu {
		position: fixed;
		z-index: 1000;
		min-width: 176px;
		padding: 5px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow:
			0 12px 30px -4px rgba(15, 23, 42, 0.16),
			0 4px 12px -2px rgba(15, 23, 42, 0.08);
		user-select: none;
		outline: none;
		animation: wb-context-in 0.12s cubic-bezier(0.16, 1, 0.3, 1);
	}
	.wb-context-item {
		display: flex;
		align-items: center;
		gap: 8px;
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
		transition:
			background 0.12s ease,
			color 0.12s ease;
	}
	.wb-context-icon {
		flex-shrink: 0;
		opacity: 0.75;
	}
	/* A tab's action brings its own picture; the box keeps the labels in line with the splits'. */
	span.wb-context-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
	}
	.wb-context-item.is-active {
		color: var(--accent);
	}
	.wb-context-label {
		flex: 1;
		white-space: nowrap;
	}
	.wb-context-keys {
		margin-left: 12px;
		font-size: 11.5px;
		font-weight: 400;
		color: var(--muted);
		letter-spacing: 0.02em;
	}
	.wb-context-item:hover:not(:disabled),
	.wb-context-item:focus-visible {
		background: var(--line-subtle);
		color: var(--accent);
		outline: none;
		box-shadow: none;
	}
	.wb-context-item:hover:not(:disabled) .wb-context-icon,
	.wb-context-item:focus-visible .wb-context-icon {
		opacity: 1;
	}
	.wb-context-item:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.wb-context-divider {
		height: 1px;
		margin: 3px 8px;
		background: var(--line-subtle);
	}
	@keyframes wb-context-in {
		from {
			opacity: 0;
			transform: scale(0.96) translateY(-4px);
		}
		to {
			opacity: 1;
			transform: scale(1) translateY(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.wb-context-menu {
			animation: none;
		}
	}
</style>
