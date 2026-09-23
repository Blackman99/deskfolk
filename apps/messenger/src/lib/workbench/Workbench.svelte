<script lang="ts">
	import type { Snippet } from 'svelte';
	import { WB_SASH_PX, type MinSizeLookup, type Rect, type WorkbenchLayout, type WorkbenchTab } from './layout-types.ts';
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
	import { findPath, focusLeaf, nodeAt, setFloatFrame, tiledLeaves } from './layout-tree.ts';
	import { dragGate } from './pane-resize.svelte.ts';
	import { dropIndicatorRect, dropZoneAt, type DropZone } from './drop-zones.ts';
	import {
		applyDrop,
		beginLeafDrag,
		beginTabDrag,
		dockFloating,
		passedThreshold,
		type PaneDrag
	} from './tab-drag.ts';
	import { WB_FALLBACK_MIN } from './pane-mins.ts';
	import type { FloatFrame } from './layout-types.ts';
	import WorkbenchBranch from './WorkbenchBranch.svelte';
	import WorkbenchFloat from './WorkbenchFloat.svelte';
	import WorkbenchLeaf from './WorkbenchLeaf.svelte';

	type Props = {
		layout: WorkbenchLayout;
		mins: MinSizeLookup;
		t: Copy;
		/** False below the narrow breakpoint: only the focused pane is drawn, the tree untouched. */
		wide: boolean;
		tabBody: Snippet<[WorkbenchTab, string]>;
		tabLabel: Snippet<[WorkbenchTab]>;
		/** What to call a tab in plain text, for the chip that follows the pointer during a drag. */
		tabName?: (tab: WorkbenchTab) => string;
		onLayout: (next: WorkbenchLayout) => void;
		onActivate?: (leafId: string, tabId: string) => void;
		onCloseTab?: (leafId: string, tabId: string) => void;
		onMenu?: (event: MouseEvent, leafId: string) => void;
		emptyActions?: Snippet<[string]>;
	};

	let {
		layout,
		mins,
		t,
		wide,
		tabBody,
		tabLabel,
		tabName,
		onLayout,
		onActivate,
		onCloseTab,
		onMenu,
		emptyActions
	}: Props = $props();

	let host = $state<HTMLDivElement>();
	let viewport = $state<Rect>({ x: 0, y: 0, width: 0, height: 0 });
	let dragging = $state(false);
	let paneDrag = $state<PaneDrag | null>(null);
	let dropZone = $state<DropZone>({ kind: 'none' });
	let ghost = $state<{ x: number; y: number; label: string } | null>(null);
	let nextId = 0;
	const freshId = () => `wb-${Date.now().toString(36)}-${++nextId}`;


	const geometry = $derived<LayoutGeometry | null>(
		viewport.width > 0 && viewport.height > 0 ? computeGeometry(layout, viewport, mins) : null
	);
	const indicator = $derived(
		geometry && paneDrag?.started ? dropIndicatorRect(geometry, dropZone, WB_FALLBACK_MIN) : null
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
		const tracks = branch.children
			.map((_, i) => `${Math.max(0, weights[i]! * drag.extent).toFixed(2)}px`)
			.join(` ${WB_SASH_PX}px `);
		// The grid property itself, not `--wb-tracks`. That variable is set declaratively by the
		// branch, so writing it here means two owners for one inline property: clearing it at the
		// end of a drag took away the value Svelte thought it had already applied, and a drag that
		// ended where it began — no change to commit, so no re-render — left the branch with no
		// track list at all. Every pane in it then collapsed into one column.
		element.style.setProperty(
			branch.axis === 'row' ? 'grid-template-columns' : 'grid-template-rows',
			tracks
		);
	}

	function clearPaint(ids: readonly string[]): void {
		for (const id of ids) {
			const element = trackElement(id);
			if (!element) continue;
			// Back to the stylesheet's `var(--wb-tracks)`, which the branch has been keeping
			// correct the whole time.
			element.style.removeProperty('grid-template-columns');
			element.style.removeProperty('grid-template-rows');
		}
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

	/**
	 * Dragging a tab, or a whole group by its strip. Pointer events throughout: HTML5 drag and
	 * drop has no pointer capture and gives coarse coordinates in this webview.
	 */
	function startPaneDrag(event: PointerEvent, drag: PaneDrag, label: string): void {
		if (event.button !== 0) return;
		const target = event.currentTarget as HTMLElement;
		const pointerId = event.pointerId;
		let current = drag;

		const move = (moveEvent: PointerEvent) => {
			const point = pointFrom(moveEvent);
			if (!current.started) {
				if (!passedThreshold(current, point)) return;
				current = { ...current, started: true };
				paneDrag = current;
				dragging = true;
				dragGate.begin();
				target.setPointerCapture(pointerId);
			}
			// Alt turns any position into a float: there is one window, so "drop outside it" is
			// not available the way it is in an editor with several.
			dropZone = geometry ? dropZoneAt(geometry, point, { float: moveEvent.altKey }) : { kind: 'none' };
			ghost = { x: point.x, y: point.y, label };
		};
		const finish = (endEvent: PointerEvent) => {
			target.removeEventListener('pointermove', move);
			target.removeEventListener('pointerup', finish);
			target.removeEventListener('pointercancel', finish);
			if (!current.started) return;
			const zone = endEvent.type === 'pointercancel' ? ({ kind: 'none' } as DropZone) : dropZone;
			const sourceRect = geometry?.leaves.get(current.leafId);
			paneDrag = null;
			dropZone = { kind: 'none' };
			ghost = null;
			dragging = false;
			dragGate.end();
			const next = applyDrop(layout, current, zone, {
				node: freshId,
				viewport,
				floatMin: WB_FALLBACK_MIN,
				sourceRect
			});
			if (next !== layout) onLayout(next);
		};
		target.addEventListener('pointermove', move);
		target.addEventListener('pointerup', finish);
		target.addEventListener('pointercancel', finish);
	}

	function pointFrom(event: PointerEvent): { x: number; y: number } {
		const box = host?.getBoundingClientRect();
		return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
	}

	function onFloatFrame(leafId: string, frame: FloatFrame): void {
		const next = setFloatFrame(layout, leafId, frame);
		if (next !== layout) onLayout(next);
	}

	function onDock(leafId: string): void {
		const centre = { x: viewport.width / 2, y: viewport.height / 2 };
		const zone = geometry ? dropZoneAt(geometry, centre) : ({ kind: 'none' } as DropZone);
		const next = dockFloating(layout, leafId, zone, {
			node: freshId,
			viewport,
			floatMin: WB_FALLBACK_MIN
		});
		if (next !== layout) onLayout(next);
	}

	/** What the chip that follows the pointer says. An id would tell nobody anything. */
	function nameOf(leafId: string, tabId: string | null): string {
		const leaf = tiledLeaves(layout.root).find((candidate) => candidate.id === leafId) ??
			layout.floating.find((pane) => pane.leaf.id === leafId)?.leaf;
		const tab = tabId
			? leaf?.tabs.find((candidate) => candidate.id === tabId)
			: leaf?.tabs.find((candidate) => candidate.id === leaf.activeTabId);
		if (!tab) return t.pane.title;
		return tabName?.(tab) ?? tab.kind;
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
				{emptyActions}
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
			onTabPointerDown={(event, leafId, tabId) =>
				startPaneDrag(event, beginTabDrag(leafId, tabId, pointFrom(event)), nameOf(leafId, tabId))}
			onStripPointerDown={(event, leafId) => {
				if ((event.target as HTMLElement).closest('.wb-tab, .wb-pane-menu')) return;
				startPaneDrag(event, beginLeafDrag(leafId, pointFrom(event)), nameOf(leafId, null));
			}}
			{onMenu}
			{emptyActions}
		/>

		{#each layout.floating as pane, index (pane.leaf.id)}
			<WorkbenchFloat
				leaf={pane.leaf}
				frame={pane.frame}
				z={index}
				focused={pane.leaf.id === layout.focus.leafId}
				min={WB_FALLBACK_MIN}
				{viewport}
				{t}
				{tabBody}
				{tabLabel}
				onFrame={onFloatFrame}
				onFocus={focus}
				onActivate={(leafId, tabId) => onActivate?.(leafId, tabId)}
				onCloseTab={(leafId, tabId) => onCloseTab?.(leafId, tabId)}
				onTabPointerDown={(event, leafId, tabId) =>
					startPaneDrag(event, beginTabDrag(leafId, tabId, pointFrom(event)), nameOf(leafId, tabId))}
				{onDock}
				{onMenu}
				{emptyActions}
			/>
		{/each}

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
				{#if indicator}
					<div
						class="wb-drop"
						style:left={`${indicator.x}px`}
						style:top={`${indicator.y}px`}
						style:width={`${indicator.width}px`}
						style:height={`${indicator.height}px`}
					></div>
				{/if}
				{#if ghost}
					<div class="wb-ghost" style:transform={`translate3d(${ghost.x + 12}px, ${ghost.y + 12}px, 0)`}>
						{ghost.label}
					</div>
				{/if}
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
	.wb-drop {
		position: absolute;
		background: var(--accent-tint);
		outline: 2px solid var(--accent);
		outline-offset: -2px;
		border-radius: 6px;
		pointer-events: none;
	}
	.wb-ghost {
		position: absolute;
		left: 0;
		top: 0;
		padding: 2px 8px;
		border-radius: 6px;
		font-size: 12px;
		color: var(--text);
		background: var(--pane);
		box-shadow: 0 4px 12px rgb(0 0 0 / 0.2);
		pointer-events: none;
		white-space: nowrap;
	}
	@media (prefers-reduced-motion: reduce) {
		.wb-junction::before {
			transition: none;
		}
	}
</style>
