<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import { holdBack } from './chat/message-text-pages.ts';

	/**
	 * What a dropdown opens as on a phone (`PHONE_SHEET_QUERY`): a sheet from the bottom of the
	 * window, rows sized for a thumb. A dropdown under a button is a mouse's idea — on a phone it
	 * lands under your finger or half off the screen, and its rows are too small to hit.
	 *
	 * It is drawn in the top layer, so it sits over a settings page or a sheet that holds the field,
	 * but it stays inside the component that opened it in the document: that component's
	 * outside-press check, and the backdrop test of a sheet around it, still count a press in it as
	 * inside. The backdrop closes it by its own press, the phone's Back closes it before anything
	 * else, and Escape closes it without reaching whatever is around it.
	 *
	 * Rows marked `sheet-item` take the sheet's row style; a component styles its own rows otherwise.
	 */
	interface Props {
		/** The heading, and the sheet's name for a screen reader. None: just the grip. */
		title?: string | null;
		/** The close button's and the backdrop's name. */
		closeLabel: string;
		onClose: () => void;
		/** A class for the sheet itself, for the component's own rules. */
		class?: string;
		children: Snippet;
	}

	let { title = null, closeLabel, onClose, class: className = '', children }: Props = $props();

	let layerEl = $state<HTMLDivElement | null>(null);
	let sheetEl = $state<HTMLDivElement | null>(null);

	// Over everything, the way a dialog is: a settings page on a phone is one.
	$effect(() => {
		const el = layerEl;
		if (!el || typeof el.showPopover !== 'function') return;
		el.setAttribute('popover', 'manual');
		try {
			el.showPopover();
		} catch {
			// Already showing.
		}
		return () => {
			try {
				el.hidePopover();
			} catch {
				// Gone with it.
			}
			el.removeAttribute('popover');
		};
	});

	// The phone's Back puts the sheet away first, rather than leaving the page under it.
	$effect(() => holdBack(() => onClose()));

	// Focus comes into the sheet, so Escape and a screen reader start there; the page under it stays where it was.
	$effect(() => {
		sheetEl?.focus({ preventScroll: true });
	});

	function onKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		onClose();
	}
</script>

<div bind:this={layerEl} class="bottom-sheet-layer" onkeydown={onKeydown} role="presentation">
	<button type="button" class="bottom-sheet-backdrop" aria-label={closeLabel} tabindex="-1" onclick={() => onClose()}></button>
	<div bind:this={sheetEl} class="bottom-sheet-panel {className}" role="dialog" aria-modal="true" aria-label={title ?? undefined} tabindex="-1">
		<div class="bottom-sheet-grip" aria-hidden="true"></div>
		{#if title}
			<header class="bottom-sheet-head">
				<h2 class="bottom-sheet-title">{title}</h2>
				<button type="button" class="bottom-sheet-close" aria-label={closeLabel} onclick={() => onClose()}>
					<Icon name="x" size={20} />
				</button>
			</header>
		{/if}
		<div class="bottom-sheet-body">
			{@render children()}
		</div>
	</div>
</div>

<style>
	.bottom-sheet-layer {
		position: fixed;
		inset: 0;
		z-index: 400;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		width: 100%;
		height: 100%;
		max-width: none;
		max-height: none;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--ink);
		font-family: var(--font);
		overflow: hidden;
		text-align: left;
	}

	.bottom-sheet-backdrop {
		position: absolute;
		inset: 0;
		border: 0;
		padding: 0;
		background: var(--backdrop, rgba(0, 0, 0, 0.36));
		animation: bottomSheetFade 0.18s ease;
	}

	@keyframes bottomSheetFade {
		from {
			opacity: 0;
		}
	}

	.bottom-sheet-panel {
		position: relative;
		display: flex;
		flex-direction: column;
		max-height: min(86dvh, 86vh);
		background: var(--pane);
		border-radius: 16px 16px 0 0;
		box-shadow: var(--shadow-lg);
		padding-bottom: env(safe-area-inset-bottom, 0);
		outline: none;
		animation: bottomSheetIn 0.24s cubic-bezier(0.16, 1, 0.3, 1);
	}

	@keyframes bottomSheetIn {
		from {
			transform: translateY(100%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.bottom-sheet-panel,
		.bottom-sheet-backdrop {
			animation: none;
		}
	}

	.bottom-sheet-grip {
		flex: none;
		width: 36px;
		height: 4px;
		margin: 8px auto 4px;
		border-radius: 2px;
		background: var(--line);
	}

	.bottom-sheet-head {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
		padding: 2px 8px 6px 20px;
	}

	.bottom-sheet-title {
		flex: 1;
		min-width: 0;
		margin: 0;
		overflow: hidden;
		font-size: 16px;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bottom-sheet-close {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--ink-secondary);
		cursor: pointer;
	}

	.bottom-sheet-close:active {
		background: var(--line-subtle);
	}

	.bottom-sheet-body {
		flex: 1 1 auto;
		min-height: 0;
		padding: 4px 8px 12px;
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
	}

	/*
	 * The row every sheet's list is made of. A component's own row class can stay on the row (tests
	 * and keys find it by that); these rules outweigh its dropdown sizing, hover included.
	 */
	.bottom-sheet-layer .bottom-sheet-body :global(.sheet-item) {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-height: 48px;
		padding: 10px 12px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-size: 15px;
		line-height: 1.35;
		text-align: left;
		cursor: pointer;
		box-sizing: border-box;
		-webkit-tap-highlight-color: transparent;
	}

	.bottom-sheet-layer .bottom-sheet-body :global(.sheet-item:active:not(:disabled)) {
		background: var(--line-subtle);
	}

	.bottom-sheet-layer .bottom-sheet-body :global(.sheet-item:disabled) {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.bottom-sheet-layer .bottom-sheet-body :global(.sheet-item.is-active),
	.bottom-sheet-layer .bottom-sheet-body :global(.sheet-item[aria-current='true']),
	.bottom-sheet-layer .bottom-sheet-body :global(.sheet-item[aria-checked='true']),
	.bottom-sheet-layer .bottom-sheet-body :global(.sheet-item[aria-selected='true']) {
		color: var(--accent);
		font-weight: 600;
	}

	/* What cannot be taken back, in every sheet: Delete, Move to Trash. */
	.bottom-sheet-layer .bottom-sheet-body :global(.sheet-item.is-danger:not(:disabled)) {
		color: var(--danger);
	}

	.bottom-sheet-layer .bottom-sheet-body :global(.sheet-item svg) {
		flex: none;
		width: 20px;
		height: 20px;
	}

	.bottom-sheet-layer .bottom-sheet-body :global(.sheet-item-label) {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bottom-sheet-layer .bottom-sheet-body :global(.sheet-item-detail) {
		display: block;
		overflow: hidden;
		color: var(--muted);
		font-size: 12px;
		font-weight: 400;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bottom-sheet-layer .bottom-sheet-body :global(.sheet-separator) {
		height: 1px;
		margin: 6px 12px;
		background: var(--line);
	}
</style>
