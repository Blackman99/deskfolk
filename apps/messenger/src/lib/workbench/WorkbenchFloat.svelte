<script lang="ts">
	import { flushSync, type Snippet } from 'svelte';
	import type { FloatFrame, LeafNode, PaneMin, Rect, TabAction, TabClosing, WorkbenchTab } from './layout-types.ts';
	import type { Copy } from '../copy.ts';
	import { clampFrame, moveFrame, resizeFrame, type Handle } from './float-frame.ts';
	import { dragGate } from './pane-resize.svelte.ts';
	import { trackPointerDrag } from '../pointer-drag.ts';
	import WorkbenchLeaf from './WorkbenchLeaf.svelte';

	type Props = {
		leaf: LeafNode;
		frame: FloatFrame;
		z: number;
		focused: boolean;
		min: PaneMin;
		viewport: Rect;
		t: Copy;
		tabBody: Snippet<[WorkbenchTab, string]>;
		tabLabel: Snippet<[WorkbenchTab]>;
		onFrame: (leafId: string, frame: FloatFrame) => void;
		onFocus: (leafId: string) => void;
		onActivate: (leafId: string, tabId: string) => void;
		onCloseTab: (leafId: string, tabId: string) => void;
		tabClosing?: (leafId: string, tabId: string) => TabClosing | null;
		tabFloating?: (leafId: string, tabId: string) => (() => void) | null;
		onClosePane?: (leafId: string) => void;
		/** The tab being dragged right now, wherever it is. */
		draggedTab?: string | null;
		onTabPointerDown?: (event: PointerEvent, leafId: string, tabId: string) => void;
		onDock?: (leafId: string) => void;
		onMenu?: (event: MouseEvent, leafId: string) => void;
		emptyActions?: Snippet<[string]>;
		menuActions?: Snippet<[string, string]>;
		tabActions?: (leafId: string, tab: WorkbenchTab) => TabAction[];
	};

	let {
		leaf,
		frame,
		z,
		focused,
		min,
		viewport,
		t,
		tabBody,
		tabLabel,
		onFrame,
		onFocus,
		onActivate,
		onCloseTab,
		tabClosing,
		tabFloating,
		onClosePane,
		draggedTab = null,
		onTabPointerDown,
		onDock,
		onMenu,
		emptyActions,
		menuActions,
		tabActions
	}: Props = $props();

	/** Every edge and every corner resizes, so the pane can be pulled open wherever there is room. */
	const HANDLES: Handle[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
	/**
	 * What on the strip is not the title bar: the tabs and the strip's own buttons and menu. A
	 * press anywhere else on it moves the pane, the way the trace window's header did.
	 */
	const NOT_TITLE = '.wb-tab, .wb-pane-menu, .wb-pane-close, .wb-new-tab, .wb-new-menu';
	let frameEl = $state<HTMLDivElement>();
	/** Held while the pane follows the pointer, for the closed hand. */
	let moving = $state(false);
	/**
	 * The size and place being shown while an edge or a corner is pulled. The layout — and the
	 * saved arrangement — stays at `frame` until the pointer is released. A parent render during
	 * the pull keeps painting this, rather than the frame from when the pull began.
	 */
	let live = $state<FloatFrame | null>(null);
	/**
	 * The frame pulled back inside the workbench, which narrows without the window changing size:
	 * the sidebar opening, the preview opening. A pane left near the far edge would hang outside
	 * it, then leap back in on the first pixel of a drag. Drags start from here for the same
	 * reason. The saved frame is not touched, so widening again puts the pane back where it was.
	 */
	const placed = $derived(
		viewport.width > 0 && viewport.height > 0 ? clampFrame(frame, min, viewport) : frame
	);
	const shown = $derived(live ?? placed);

	function gesture(
		event: PointerEvent,
		step: (dx: number, dy: number) => FloatFrame,
		resize: boolean
	): void {
		event.preventDefault();
		event.stopPropagation();
		onFocus(leaf.id);
		const target = event.currentTarget as HTMLElement;
		const root = frameEl;
		if (!root) return;
		target.setPointerCapture(event.pointerId);
		const originX = event.clientX;
		const originY = event.clientY;
		const origin = placed;
		dragGate.begin();
		moving = !resize;
		let latest = origin;

		const move = (moveEvent: PointerEvent) => {
			latest = step(moveEvent.clientX - originX, moveEvent.clientY - originY);
			if (resize) {
				live = latest;
				return;
			}
			// `translate3d` composites. Writing `left`/`top` would lay the pane out on every
			// frame, and writing them through the layout would save the whole arrangement too.
			root.style.transform = `translate3d(${latest.x - origin.x}px, ${latest.y - origin.y}px, 0)`;
		};
		const finish = () => {
			if (!resize) {
				root.style.left = `${latest.x}px`;
				root.style.top = `${latest.y}px`;
				root.style.transform = '';
			}
			const changed =
				latest.x !== origin.x || latest.y !== origin.y ||
				latest.width !== origin.width || latest.height !== origin.height;
			try {
				if (changed) {
					onFrame(leaf.id, latest);
					flushSync();
				}
			} finally {
				dragGate.end();
				live = null;
				moving = false;
			}
		};
		trackPointerDrag(target, { move, end: finish });
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="wb-float"
	class:is-focused={focused}
	class:is-moving={moving}
	data-float={leaf.id}
	bind:this={frameEl}
	style:left={`${shown.x}px`}
	style:top={`${shown.y}px`}
	style:width={`${shown.width}px`}
	style:height={`${shown.height}px`}
	style:z-index={40 + z}
	ondblclick={(event) => {
		// The strip is the title bar: a double click on it puts the pane back into the tiled
		// arrangement. On a tab or a button it is that control's own.
		const target = event.target as HTMLElement;
		if (target.closest('.wb-strip') && !target.closest(NOT_TITLE)) onDock?.(leaf.id);
	}}
>
	<WorkbenchLeaf
		{leaf}
		{focused}
		{t}
		{tabBody}
		{tabLabel}
		{onFocus}
		{onActivate}
		{onCloseTab}
		{tabClosing}
		{tabFloating}
		{onClosePane}
		{draggedTab}
		{onTabPointerDown}
		onStripPointerDown={(event) => {
			if (event.button !== 0 || (event.target as HTMLElement).closest(NOT_TITLE)) return;
			const start = placed;
			const floor = min;
			const box = viewport;
			gesture(event, (dx, dy) => moveFrame(start, dx, dy, floor, box), false);
		}}
		{onMenu}
		{emptyActions}
		{menuActions}
		{tabActions}
	/>
	<!-- Out of the tab order: they answer the pointer only. -->
	{#each HANDLES as handle (handle)}
		<button
			type="button"
			class={`wb-float-grip is-${handle}`}
			tabindex="-1"
			aria-label={t.pane.resize}
			onpointerdown={(event) => {
				if (event.button !== 0) return;
				const start = placed;
				const floor = min;
				const box = viewport;
				gesture(event, (dx, dy) => resizeFrame(start, handle, dx, dy, floor, box), true);
			}}
		></button>
	{/each}
</div>

<style>
	/*
	 * Drawn like the trace window it grew out of: a card with the large radius and shadow, a
	 * hairline round it. It does not clip — the pane inside does — so the grips can reach a few
	 * pixels past its edge, where the pointer finds an edge without landing on the content.
	 */
	.wb-float {
		position: absolute;
		display: flex;
		flex-direction: column;
		border-radius: var(--radius-lg);
		background: var(--pane);
		box-shadow: var(--shadow-lg);
		outline: 1px solid var(--line);
		outline-offset: -1px;
	}
	/* A layer over the content for the same reason a tiled pane's frame is (see WorkbenchLeaf):
	   the pane inside paints right up to the edge and would cover an outline. */
	.wb-float.is-focused::after {
		content: '';
		position: absolute;
		inset: 0;
		z-index: 35;
		border-radius: inherit;
		box-shadow: inset 0 0 0 1px var(--accent);
		pointer-events: none;
	}
	.wb-float :global(.wb-leaf) {
		flex: 1;
		min-height: 0;
		border-radius: inherit;
	}
	/* The strip is the title bar. Its tabs and buttons keep their own pointer. */
	.wb-float :global(.wb-strip) {
		cursor: grab;
		touch-action: none;
		user-select: none;
	}
	.wb-float.is-moving :global(.wb-strip) {
		cursor: grabbing;
	}
	.wb-float :global(.wb-tab) {
		cursor: default;
	}
	/* However many tabs it holds, some of the bar is left bare to take hold of. */
	.wb-float :global(.wb-tabs) {
		max-width: calc(100% - 76px);
	}
	/*
	 * The grips draw nothing: the cursor over an edge already says it can be pulled, as on the
	 * trace window's corners. They straddle the edge, half outside, and sit over the pane's own
	 * layers (its strip, its settings scrim at 30) or the strip would take the top edge.
	 */
	.wb-float-grip {
		position: absolute;
		z-index: 36;
		padding: 0;
		border: 0;
		background: none;
		transition: none;
		touch-action: none;
	}
	.wb-float-grip.is-n,
	.wb-float-grip.is-s {
		left: 10px;
		right: 10px;
		height: 8px;
		cursor: ns-resize;
	}
	.wb-float-grip.is-n {
		top: -4px;
	}
	.wb-float-grip.is-s {
		bottom: -4px;
	}
	.wb-float-grip.is-e,
	.wb-float-grip.is-w {
		top: 10px;
		bottom: 10px;
		width: 8px;
		cursor: ew-resize;
	}
	.wb-float-grip.is-w {
		left: -4px;
	}
	.wb-float-grip.is-e {
		right: -4px;
	}
	.wb-float-grip.is-nw,
	.wb-float-grip.is-ne,
	.wb-float-grip.is-sw,
	.wb-float-grip.is-se {
		width: 14px;
		height: 14px;
	}
	.wb-float-grip.is-nw {
		left: -4px;
		top: -4px;
		cursor: nwse-resize;
	}
	.wb-float-grip.is-ne {
		right: -4px;
		top: -4px;
		cursor: nesw-resize;
	}
	.wb-float-grip.is-sw {
		left: -4px;
		bottom: -4px;
		cursor: nesw-resize;
	}
	.wb-float-grip.is-se {
		right: -4px;
		bottom: -4px;
		cursor: nwse-resize;
	}
</style>
