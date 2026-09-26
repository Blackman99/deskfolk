<script lang="ts">
	import { flushSync, type Snippet } from 'svelte';
	import type { FloatFrame, LeafNode, PaneMin, Rect, TabAction, TabClosing, WorkbenchTab } from './layout-types.ts';
	import type { Copy } from '../copy.ts';
	import { moveFrame, resizeFrame, type Corner } from './float-frame.ts';
	import { dragGate } from './pane-resize.svelte.ts';
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
		onClosePane?: (leafId: string) => void;
		/** The tab being dragged right now, wherever it is. */
		draggedTab?: string | null;
		onTabPointerDown?: (event: PointerEvent, leafId: string, tabId: string) => void;
		onStripPointerDown?: (event: PointerEvent, leafId: string) => void;
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
		onClosePane,
		draggedTab = null,
		onTabPointerDown,
		onStripPointerDown,
		onDock,
		onMenu,
		emptyActions,
		menuActions,
		tabActions
	}: Props = $props();

	const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];
	let frameEl = $state<HTMLDivElement>();
	/**
	 * The size and place being shown while a corner is pulled. The layout — and the saved
	 * arrangement — stays at `frame` until the pointer is released. A parent render during the
	 * pull keeps painting this, rather than the frame from when the pull began.
	 */
	let live = $state<FloatFrame | null>(null);
	const shown = $derived(live ?? frame);

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
		const origin = frame;
		dragGate.begin();
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
			target.removeEventListener('pointermove', move);
			target.removeEventListener('pointerup', finish);
			target.removeEventListener('pointercancel', finish);
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
			}
		};
		target.addEventListener('pointermove', move);
		target.addEventListener('pointerup', finish);
		target.addEventListener('pointercancel', finish);
	}
</script>

<div
	class="wb-float"
	class:is-focused={focused}
	data-float={leaf.id}
	bind:this={frameEl}
	style:left={`${shown.x}px`}
	style:top={`${shown.y}px`}
	style:width={`${shown.width}px`}
	style:height={`${shown.height}px`}
	style:z-index={40 + z}
>
	<!-- The title bar moves it; a double click puts it back into the tiled arrangement. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="wb-float-bar"
		onpointerdown={(event) => {
			if ((event.target as HTMLElement).closest('.wb-strip')) return;
			const start = frame;
			const floor = min;
			const box = viewport;
			gesture(event, (dx, dy) => moveFrame(start, dx, dy, floor, box), false);
		}}
		ondblclick={() => onDock?.(leaf.id)}
	></div>
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
		{onClosePane}
		{draggedTab}
		{onTabPointerDown}
		{onStripPointerDown}
		{onMenu}
		{emptyActions}
		{menuActions}
		{tabActions}
	/>
	{#each CORNERS as corner (corner)}
		<button
			type="button"
			class={`wb-float-corner is-${corner}`}
			aria-label={t.pane.resize}
			onpointerdown={(event) => {
				const start = frame;
				const floor = min;
				const box = viewport;
				gesture(event, (dx, dy) => resizeFrame(start, corner, dx, dy, floor, box), true);
			}}
		></button>
	{/each}
</div>

<style>
	.wb-float {
		position: absolute;
		display: flex;
		flex-direction: column;
		border-radius: 10px;
		overflow: hidden;
		background: var(--pane);
		box-shadow: 0 10px 30px rgb(0 0 0 / 0.22);
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
	.wb-float-bar {
		height: 10px;
		flex: 0 0 auto;
		cursor: move;
		touch-action: none;
	}
	.wb-float :global(.wb-leaf) {
		flex: 1;
		min-height: 0;
	}
	.wb-float-corner {
		position: absolute;
		width: 14px;
		height: 14px;
		padding: 0;
		background: none;
		touch-action: none;
	}
	.wb-float-corner.is-nw {
		left: 0;
		top: 0;
		cursor: nwse-resize;
	}
	.wb-float-corner.is-ne {
		right: 0;
		top: 0;
		cursor: nesw-resize;
	}
	.wb-float-corner.is-sw {
		left: 0;
		bottom: 0;
		cursor: nesw-resize;
	}
	.wb-float-corner.is-se {
		right: 0;
		bottom: 0;
		cursor: nwse-resize;
	}
</style>
