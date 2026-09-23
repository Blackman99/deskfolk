<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { MinSizeLookup, Rect, WorkbenchLayout, WorkbenchTab } from './layout-types.ts';
	import type { Copy } from '../copy.ts';
	import { computeGeometry, type LayoutGeometry } from './layout-geometry.ts';
	import {
		beginJunctionDrag,
		beginSashDrag,
		resizeJunction,
		resizeSash,
		weightsAfterSash,
		type JunctionDrag,
		type SashDrag
	} from './layout-resize.ts';
	import { findPath, focusLeaf, nodeAt, tiledLeaves } from './layout-tree.ts';
	import { dragGate } from './pane-resize.svelte.ts';
	import WorkbenchBranch from './WorkbenchBranch.svelte';
	import WorkbenchLeaf from './WorkbenchLeaf.svelte';

	type Props = {
		layout: WorkbenchLayout;
		mins: MinSizeLookup;
		t: Copy;
		/** False below the narrow breakpoint: only the focused pane is drawn, the tree untouched. */
		wide: boolean;
		tabBody: Snippet<[WorkbenchTab, string]>;
		tabLabel: Snippet<[WorkbenchTab]>;
		onLayout: (next: WorkbenchLayout) => void;
		onActivate?: (leafId: string, tabId: string) => void;
		onCloseTab?: (leafId: string, tabId: string) => void;
		onMenu?: (event: MouseEvent, leafId: string) => void;
	};

	let { layout, mins, t, wide, tabBody, tabLabel, onLayout, onActivate, onCloseTab, onMenu }: Props =
		$props();

	let host = $state<HTMLDivElement>();
	let viewport = $state<Rect>({ x: 0, y: 0, width: 0, height: 0 });
	let dragging = $state(false);

	const geometry = $derived<LayoutGeometry | null>(
		viewport.width > 0 && viewport.height > 0 ? computeGeometry(layout, viewport, mins) : null
	);
	const soloLeaf = $derived(
		tiledLeaves(layout.root).find((leaf) => leaf.id === layout.focus.leafId) ??
			layout.floating.find((pane) => pane.leaf.id === layout.focus.leafId)?.leaf ??
			tiledLeaves(layout.root)[0]
	);

	function measure(): void {
		const element = host;
		if (!element) return;
		const box = element.getBoundingClientRect();
		viewport = { x: 0, y: 0, width: box.width, height: box.height };
	}

	$effect(() => {
		measure();
		if (typeof window === 'undefined') return;
		// One measurement of the container, on a real resize. Not a per-element observer: the
		// browser used for UI verification never delivers those, and the layout must not depend
		// on one firing to be drawn at the right size.
		window.addEventListener('resize', measure);
		return () => window.removeEventListener('resize', measure);
	});

	function trackElement(branchId: string): HTMLElement | null {
		return host?.querySelector<HTMLElement>(`[data-branch="${CSS.escape(branchId)}"]`) ?? null;
	}

	/**
	 * Paint a drag straight onto the affected grids rather than through state.
	 *
	 * Only the branches this drag touches are written to, so the cost per frame is set by the
	 * junction's arity and not by how many panes exist.
	 */
	function paint(drag: SashDrag, delta: number): void {
		const element = trackElement(drag.branchId);
		const path = findPath(layout.root, drag.branchId);
		if (!element || !path) return;
		const branch = nodeAt(layout.root, path);
		if (!branch || branch.type !== 'branch') return;
		const weights = weightsAfterSash(drag, delta);
		const row = branch.axis === 'row';
		const tracks = branch.children
			.map((child, i) => {
				const size = Math.max(0, weights[i]! * drag.extent);
				void child;
				return `${size.toFixed(2)}px`;
			})
			.join(' 8px ');
		void row;
		element.style.setProperty('--wb-tracks', tracks);
	}

	function clearPaint(ids: readonly string[]): void {
		for (const id of ids) trackElement(id)?.style.removeProperty('--wb-tracks');
	}

	function startSash(event: PointerEvent, sashId: string): void {
		if (!geometry) return;
		const drag = beginSashDrag(layout, geometry, sashId, mins);
		if (!drag) return;
		event.preventDefault();
		const target = event.currentTarget as HTMLElement;
		target.setPointerCapture(event.pointerId);
		const originX = event.clientX;
		const originY = event.clientY;
		dragging = true;
		dragGate.begin();

		const move = (moveEvent: PointerEvent) => {
			const delta = drag.axis === 'row' ? moveEvent.clientX - originX : moveEvent.clientY - originY;
			paint(drag, delta);
		};
		const finish = (endEvent: PointerEvent) => {
			target.removeEventListener('pointermove', move);
			target.removeEventListener('pointerup', finish);
			target.removeEventListener('pointercancel', finish);
			clearPaint([drag.branchId]);
			dragging = false;
			dragGate.end();
			const delta = drag.axis === 'row' ? endEvent.clientX - originX : endEvent.clientY - originY;
			if (delta !== 0) onLayout(resizeSash(layout, drag, delta));
		};
		target.addEventListener('pointermove', move);
		target.addEventListener('pointerup', finish);
		target.addEventListener('pointercancel', finish);
	}

	function startJunction(event: PointerEvent, junctionId: string): void {
		if (!geometry) return;
		const drag: JunctionDrag | null = beginJunctionDrag(layout, geometry, junctionId, mins);
		if (!drag) return;
		event.preventDefault();
		const target = event.currentTarget as HTMLElement;
		target.setPointerCapture(event.pointerId);
		const originX = event.clientX;
		const originY = event.clientY;
		dragging = true;
		dragGate.begin();
		const vertical = drag.bar.axis === 'row';
		const touched = [drag.bar.branchId, ...drag.stems.map((stem) => stem.branchId)];

		const deltaOf = (moveEvent: PointerEvent) => ({
			across: vertical ? moveEvent.clientX - originX : moveEvent.clientY - originY,
			along: vertical ? moveEvent.clientY - originY : moveEvent.clientX - originX
		});
		const move = (moveEvent: PointerEvent) => {
			const delta = deltaOf(moveEvent);
			paint(drag.bar, delta.across);
			// Every stem takes the same number of pixels, which is what keeps them in line.
			for (const stem of drag.stems) paint(stem, delta.along);
		};
		const finish = (endEvent: PointerEvent) => {
			target.removeEventListener('pointermove', move);
			target.removeEventListener('pointerup', finish);
			target.removeEventListener('pointercancel', finish);
			clearPaint(touched);
			dragging = false;
			dragGate.end();
			const delta = deltaOf(endEvent);
			if (delta.across !== 0 || delta.along !== 0) onLayout(resizeJunction(layout, drag, delta));
		};
		target.addEventListener('pointermove', move);
		target.addEventListener('pointerup', finish);
		target.addEventListener('pointercancel', finish);
	}

	function focus(leafId: string): void {
		const next = focusLeaf(layout, leafId);
		if (next !== layout) onLayout(next);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="wb-root"
	class:is-dragging={dragging}
	class:is-solo={!wide}
	bind:this={host}
	onpointerdowncapture={(event) => {
		const leaf = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-leaf]');
		if (leaf?.dataset.leaf) focus(leaf.dataset.leaf);
	}}
	onfocusincapture={(event) => {
		const leaf = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-leaf]');
		if (leaf?.dataset.leaf) focus(leaf.dataset.leaf);
	}}
>
	{#if !wide}
		<!-- Too narrow to divide: one pane fills it. The tree is not touched, so widening the
		     window brings the arrangement back exactly as it was. -->
		{#if soloLeaf}
			<WorkbenchLeaf
				leaf={soloLeaf}
				focused={true}
				{t}
				{tabBody}
				{tabLabel}
				onFocus={focus}
				onActivate={(leafId, tabId) => onActivate?.(leafId, tabId)}
				onCloseTab={(leafId, tabId) => onCloseTab?.(leafId, tabId)}
				{onMenu}
			/>
		{/if}
	{:else}
		<WorkbenchBranch
			node={layout.root}
			focusId={layout.focus.leafId}
			{mins}
			{t}
			{tabBody}
			{tabLabel}
			onFocus={focus}
			onActivate={(leafId, tabId) => onActivate?.(leafId, tabId)}
			onCloseTab={(leafId, tabId) => onCloseTab?.(leafId, tabId)}
			onSashPointerDown={startSash}
			{onMenu}
		/>

		{#if geometry}
			<!-- Handles and indicators live in one layer above the panes. Anchoring each handle to
			     a divider's end in CSS would place it exactly, but a cross would then draw two
			     handles on the same point and need an arbitrary tie-break. -->
			<div class="wb-overlay" aria-hidden={dragging}>
				{#each geometry.junctions as junction (junction.id)}
					<button
						type="button"
						class="wb-junction"
						aria-label={t.pane.junction}
						style:left={`${junction.point.x}px`}
						style:top={`${junction.point.y}px`}
						onpointerdown={(event) => startJunction(event, junction.id)}
					></button>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.wb-root {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: minmax(0, 1fr);
		/* Fills whatever it is put in. Without this it is a block-level grid sized by its
		   content, which leaves a band of background under the panes in any host that does not
		   stretch its children. */
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}
	/* While a divider is moving, nothing inside a pane may swallow the pointer — an editor or a
	   terminal would otherwise take it the moment the cursor crossed into one. */
	.wb-root.is-dragging :global(.wb-body) {
		pointer-events: none;
	}
	.wb-overlay {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}
	.wb-junction {
		position: absolute;
		width: 24px;
		height: 24px;
		margin: -12px 0 0 -12px;
		padding: 0;
		background: none;
		pointer-events: auto;
		cursor: move;
		touch-action: none;
	}
	.wb-junction::before {
		content: '';
		position: absolute;
		inset: 8px;
		border-radius: 2px;
		background: var(--hairline);
		opacity: 0;
		transform: rotate(45deg);
	}
	.wb-junction:hover::before,
	.wb-junction:focus-visible::before {
		opacity: 1;
		background: var(--accent);
	}
	@media (prefers-reduced-motion: reduce) {
		.wb-junction::before {
			transition: none;
		}
	}
</style>
