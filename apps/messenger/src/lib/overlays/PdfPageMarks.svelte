<script lang="ts">
	import { toPercentStyle, type Handle, type NormBox } from '../annotations/region-box.ts';
	import type { PdfMark } from '../annotations/pdf-region.ts';
	import type { PdfViewerLabels } from './PdfViewer.svelte';

	interface Props {
		/** The page this overlay sits on. */
		n: number;
		labels: PdfViewerLabels;
		choosing: boolean;
		/** This page's drawn annotations. */
		marks: PdfMark[];
		flashId: string | null;
		peekId: string | null;
		gesture: { kind: string; page: number; box: NormBox } | null;
		pendingShown: { page: number; box: NormBox } | null;
		onOverlayDown: (ev: PointerEvent, n: number) => void;
		onPendingDown: (ev: PointerEvent, n: number, region: NormBox, handle: Handle | null) => void;
		onPendingKey: (ev: KeyboardEvent, n: number, region: NormBox) => void;
		onBadgeDown: (ev: PointerEvent, id: string) => void;
		onBadgeUp: () => void;
		onBadgeClick: (id: string) => void;
	}

	let {
		n,
		labels,
		choosing,
		marks,
		flashId,
		peekId,
		gesture,
		pendingShown,
		onOverlayDown,
		onPendingDown,
		onPendingKey,
		onBadgeDown,
		onBadgeUp,
		onBadgeClick
	}: Props = $props();

	const HANDLES: Handle[] = ['nw', 'ne', 'sw', 'se'];
</script>

<div
	class="pdf-marks"
	class:is-active={choosing}
	data-page={n}
	title={choosing ? labels.region : undefined}
	onpointerdown={(ev) => onOverlayDown(ev, n)}
	role="presentation"
>
	{#each marks as mark (mark.id)}
		<div
			class="pdf-mark is-{mark.status}"
			class:is-stale={mark.stale}
			class:is-flash={flashId === mark.id}
			style={toPercentStyle(mark.box)}
			data-annotation-id={mark.id}
		>
			<button
				type="button"
				class="pdf-mark-badge"
				title={mark.stale ? `${mark.body}\n${labels.stale}` : mark.body}
				aria-label={labels.mark(mark.n, mark.body)}
				onpointerdown={(ev) => onBadgeDown(ev, mark.id)}
				onpointerup={onBadgeUp}
				onpointercancel={onBadgeUp}
				onclick={() => onBadgeClick(mark.id)}
			>{mark.n}</button>
			{#if peekId === mark.id}
				<span class="pdf-mark-peek text-12" role="tooltip">{mark.body}{mark.stale ? ` · ${labels.stale}` : ''}</span>
			{/if}
		</div>
	{/each}
	{#if gesture?.kind === 'new' && gesture.page === n}
		<div class="pdf-mark is-drawing" style={toPercentStyle(gesture.box)}></div>
	{/if}
	{#if pendingShown && pendingShown.page === n}
		{@const region = pendingShown.box}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			class="pdf-mark is-pending"
			style={toPercentStyle(region)}
			title={labels.pending}
			aria-label={labels.pending}
			role="group"
			tabindex="0"
			onpointerdown={(ev) => onPendingDown(ev, n, region, null)}
			onkeydown={(ev) => onPendingKey(ev, n, region)}
			data-pdf-pending
		>
			{#each HANDLES as handle (handle)}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<span
					class="pdf-handle is-{handle}"
					title={labels.resize}
					onpointerdown={(ev) => onPendingDown(ev, n, region, handle)}
				></span>
			{/each}
		</div>
	{/if}
</div>

<style>
	.pdf-marks {
		position: absolute;
		inset: 0;
		z-index: 3;
		pointer-events: none;
	}

	.pdf-marks.is-active {
		pointer-events: auto;
		cursor: crosshair;
		touch-action: none;
	}

	/* Open: accent, solid. Draft: dotted and lighter. Resolved: grey. Stale: dashed. */
	.pdf-mark {
		position: absolute;
		box-sizing: border-box;
		border: 2px solid var(--accent);
		border-radius: 2px;
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		pointer-events: none;
	}

	.pdf-mark.is-draft {
		border-style: dotted;
		background: color-mix(in srgb, var(--accent) 6%, transparent);
	}

	.pdf-mark.is-resolved {
		border-color: color-mix(in srgb, var(--muted) 70%, transparent);
		background: color-mix(in srgb, var(--muted) 10%, transparent);
	}

	.pdf-mark.is-stale {
		border-style: dashed;
	}

	.pdf-mark.is-flash {
		animation: pdf-mark-flash 1.4s ease-out;
	}

	.pdf-mark.is-drawing {
		border-style: dashed;
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}

	.pdf-mark.is-pending {
		border-width: 2px;
		background: var(--accent-glow);
		box-shadow: 0 0 0 1px var(--pdf-paper);
		pointer-events: auto;
		cursor: move;
		touch-action: none;
	}

	.pdf-mark.is-pending:focus-visible {
		outline: 2px solid var(--accent-border);
		outline-offset: 2px;
	}

	.pdf-mark-badge {
		position: absolute;
		left: 0;
		top: 0;
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border: 0;
		border-radius: var(--radius-full);
		background: var(--accent);
		color: var(--you-text);
		font: inherit;
		font-size: 11px;
		font-weight: 600;
		line-height: 18px;
		text-align: center;
		transform: translate(-60%, -60%);
		box-shadow: var(--shadow-md);
		pointer-events: auto;
		cursor: pointer;
	}

	.pdf-mark.is-draft .pdf-mark-badge {
		background: var(--pane);
		color: var(--accent);
		box-shadow: inset 0 0 0 2px var(--accent), var(--shadow-md);
	}

	.pdf-mark.is-resolved .pdf-mark-badge {
		background: var(--muted);
	}

	.pdf-mark-peek {
		position: absolute;
		left: 0;
		top: calc(100% + 6px);
		z-index: 5;
		max-width: 240px;
		padding: 4px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-md);
		white-space: pre-wrap;
		pointer-events: none;
	}

	.pdf-handle {
		position: absolute;
		width: 10px;
		height: 10px;
		border: 2px solid var(--accent);
		border-radius: 2px;
		background: var(--pdf-paper);
		box-sizing: border-box;
	}

	.pdf-handle::before {
		content: '';
		position: absolute;
		inset: -8px;
	}

	.pdf-handle.is-nw {
		left: -6px;
		top: -6px;
		cursor: nwse-resize;
	}

	.pdf-handle.is-ne {
		right: -6px;
		top: -6px;
		cursor: nesw-resize;
	}

	.pdf-handle.is-sw {
		left: -6px;
		bottom: -6px;
		cursor: nesw-resize;
	}

	.pdf-handle.is-se {
		right: -6px;
		bottom: -6px;
		cursor: nwse-resize;
	}

	@keyframes pdf-mark-flash {
		0%,
		40% {
			box-shadow: 0 0 0 6px var(--accent-glow);
			background: color-mix(in srgb, var(--accent) 32%, transparent);
		}
		100% {
			box-shadow: 0 0 0 0 transparent;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.pdf-mark.is-flash {
			animation: none;
			background: color-mix(in srgb, var(--accent) 28%, transparent);
		}
	}

	@media (max-width: 680px) {
		.pdf-mark-badge::before {
			content: '';
			position: absolute;
			inset: -11px;
		}

		.pdf-handle {
			width: 14px;
			height: 14px;
		}

		.pdf-handle::before {
			inset: -13px;
		}

		.pdf-handle.is-nw,
		.pdf-handle.is-sw {
			left: -8px;
		}

		.pdf-handle.is-ne,
		.pdf-handle.is-se {
			right: -8px;
		}

		.pdf-handle.is-nw,
		.pdf-handle.is-ne {
			top: -8px;
		}

		.pdf-handle.is-sw,
		.pdf-handle.is-se {
			bottom: -8px;
		}
	}
</style>
