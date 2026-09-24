<script lang="ts">
	import type { Copy } from './copy.ts';
	import { copyRenderedImage } from './clipboard.ts';
	import { computeContextMenuPosition } from './sidebar/session-context-menu.ts';

	interface Props {
		src: string;
		x: number;
		y: number;
		t: Copy;
		onClose: () => void;
	}

	let { src, x, y, t, onClose }: Props = $props();

	let menuEl = $state<HTMLDivElement>();
	let placed = $state<{ x: number; y: number } | null>(null);
	const pos = $derived(placed ?? { x, y });
	let failed = $state(false);
	let copying = $state(false);

	/** A floating pane's transform would pin `fixed` to the pane, and the pane clips overflow. */
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

	function onKey(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		onClose();
		if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
	}

	function copy(): void {
		if (copying) return;
		copying = true;
		failed = false;
		void copyRenderedImage(src).then(
			() => onClose(),
			() => {
				copying = false;
				failed = true;
			}
		);
	}
</script>

<div
	bind:this={menuEl}
	class="image-context-menu"
	style:left={`${pos.x}px`}
	style:top={`${pos.y}px`}
	role="menu"
	tabindex="-1"
	aria-label={t.common.copyImage}
	data-testid="image-context-menu"
	use:portal
	onkeydown={onKey}
	oncontextmenu={(event) => {
		event.preventDefault();
		event.stopPropagation();
	}}
>
	<button
		type="button"
		class="image-context-item"
		role="menuitem"
		disabled={copying}
		onclick={copy}
	>
		{failed ? t.common.copyImageFailed : t.common.copyImage}
	</button>
</div>

<style>
	.image-context-menu {
		position: fixed;
		z-index: 1400;
		min-width: 148px;
		padding: 5px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow:
			0 12px 30px -4px rgba(15, 23, 42, 0.16),
			0 4px 12px -2px rgba(15, 23, 42, 0.08);
		user-select: none;
		outline: none;
	}

	.image-context-item {
		display: flex;
		align-items: center;
		width: 100%;
		min-height: 32px;
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

	.image-context-item:hover:not(:disabled),
	.image-context-item:focus-visible:not(:disabled) {
		background: var(--line-subtle);
		color: var(--accent);
		outline: none;
	}

	.image-context-item:disabled {
		cursor: default;
		opacity: 0.7;
	}

	@media (max-width: 680px) {
		.image-context-item {
			min-height: 44px;
		}
	}
</style>
