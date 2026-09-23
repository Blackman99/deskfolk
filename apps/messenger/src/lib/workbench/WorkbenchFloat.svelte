<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { FloatFrame, LeafNode, PaneMin, Rect, WorkbenchTab } from './layout-types.ts';
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
		onTabPointerDown?: (event: PointerEvent, leafId: string, tabId: string) => void;
		onStripPointerDown?: (event: PointerEvent, leafId: string) => void;
		onDock?: (leafId: string) => void;
		onMenu?: (event: MouseEvent, leafId: string) => void;
		emptyActions?: Snippet<[string]>;
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
		onTabPointerDown,
		onStripPointerDown,
		onDock,
		onMenu,
		emptyActions
	}: Props = $props();

	const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];

	function gesture(
		event: PointerEvent,
		step: (dx: number, dy: number) => FloatFrame
	): void {
		event.preventDefault();
		event.stopPropagation();
		onFocus(leaf.id);
		const target = event.currentTarget as HTMLElement;
		target.setPointerCapture(event.pointerId);
		const originX = event.clientX;
		const originY = event.clientY;
		dragGate.begin();
		let latest = frame;

		const move = (moveEvent: PointerEvent) => {
			latest = step(moveEvent.clientX - originX, moveEvent.clientY - originY);
			onFrame(leaf.id, latest);
		};
		const finish = () => {
			target.removeEventListener('pointermove', move);
			target.removeEventListener('pointerup', finish);
			target.removeEventListener('pointercancel', finish);
			dragGate.end();
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
	style:left={`${frame.x}px`}
	style:top={`${frame.y}px`}
	style:width={`${frame.width}px`}
	style:height={`${frame.height}px`}
	style:z-index={40 + z}
>
	<!-- The title bar moves it; a double click puts it back into the tiled arrangement. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="wb-float-bar"
		onpointerdown={(event) => {
			if ((event.target as HTMLElement).closest('.wb-strip')) return;
			gesture(event, (dx, dy) => moveFrame(frame, dx, dy, min, viewport));
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
		{onTabPointerDown}
		{onStripPointerDown}
		{onMenu}
		{emptyActions}
	/>
	{#each CORNERS as corner (corner)}
		<button
			type="button"
			class={`wb-float-corner is-${corner}`}
			aria-label={t.pane.resize}
			onpointerdown={(event) =>
				gesture(event, (dx, dy) => resizeFrame(frame, corner, dx, dy, min, viewport))}
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
		outline: 1px solid var(--hairline);
		outline-offset: -1px;
	}
	.wb-float.is-focused {
		outline-color: var(--accent-border);
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
