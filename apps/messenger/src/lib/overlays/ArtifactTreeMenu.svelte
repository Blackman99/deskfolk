<script lang="ts">
	import type { Copy } from '../copy.ts';
	import { computeContextMenuPosition } from '../sidebar/session-context-menu.ts';

	type Props = {
		/** Viewport coordinates of the right-click. */
		x: number;
		y: number;
		t: Copy;
		onOpen: () => void;
		onReveal: () => void;
		onClose: () => void;
	};

	let { x, y, t, onOpen, onReveal, onClose }: Props = $props();

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
		queueMicrotask(() => menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true }));
		const onDown = (event: PointerEvent) => {
			if (!menu.contains(event.target as Node)) onClose();
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

	function items(): HTMLElement[] {
		return [...(menuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
	}

	function onKey(event: KeyboardEvent): void {
		const list = items();
		const index = list.indexOf(document.activeElement as HTMLElement);
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onClose();
			if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			event.stopPropagation();
			if (list.length === 0) return;
			const step = event.key === 'ArrowDown' ? 1 : -1;
			const next = index < 0 ? (step > 0 ? 0 : list.length - 1) : (index + step + list.length) % list.length;
			list[next]!.focus();
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
	<button type="button" class="artifact-tree-menu-item" role="menuitem" data-open onclick={() => pick(onOpen)}>
		{t.stream.artifactOpenSystem}
	</button>
	<button type="button" class="artifact-tree-menu-item" role="menuitem" data-reveal onclick={() => pick(onReveal)}>
		{t.stream.artifactReveal}
	</button>
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
		box-shadow:
			0 12px 30px -4px rgba(15, 23, 42, 0.16),
			0 4px 12px -2px rgba(15, 23, 42, 0.08);
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

	.artifact-tree-menu-item:hover,
	.artifact-tree-menu-item:focus-visible {
		background: var(--line-subtle);
		color: var(--accent);
		outline: none;
	}

	@media (max-width: 680px) {
		.artifact-tree-menu-item {
			min-height: 44px;
		}
	}
</style>
