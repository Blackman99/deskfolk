<script lang="ts">
	import { flushSync, type Snippet } from 'svelte';
	import { WB_SASH_PX, type MinSizeLookup, type Rect, type TabAction, type WorkbenchLayout, type WorkbenchTab } from './layout-types.ts';
	import type { Copy } from '../copy.ts';
	import { canSplit, computeGeometry, type Direction, type LayoutGeometry } from './layout-geometry.ts';
	import {
		beginJunctionDrag,
		beginSashDrag,
		resizeJunction,
		resizeSash,
		weightsAfterSash,
		type JunctionDrag,
		type SashDrag
	} from './layout-resize.ts';
	import { closeLeaf, findPath, focusLeaf, nodeAt, setFloatFrame, splitLeaf, tiledLeaves } from './layout-tree.ts';
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
	import { SPLIT_TOWARDS, applyCommand, isTypingTarget } from './workbench-commands.ts';
	import type { FloatFrame } from './layout-types.ts';
	import WorkbenchBranch from './WorkbenchBranch.svelte';
	import WorkbenchFloat from './WorkbenchFloat.svelte';
	import WorkbenchLeaf from './WorkbenchLeaf.svelte';
	import PaneContextMenu from './PaneContextMenu.svelte';
	import { paneEditAt, type PaneEdit } from './pane-edit.ts';

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
		onClosePane?: (leafId: string) => void;
		onMenu?: (event: MouseEvent, leafId: string) => void;
		emptyActions?: Snippet<[string]>;
		/** The strip's + menu. A second argument is the text typed into its filter. */
		menuActions?: Snippet<[string, string]>;
		/** What a tab offers for what it shows: under its ⋯, and first in a right-click on it. */
		tabActions?: (leafId: string, tab: WorkbenchTab) => TabAction[];
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
		onClosePane,
		onMenu,
		emptyActions,
		menuActions,
		tabActions
	}: Props = $props();

	let host = $state<HTMLDivElement>();
	let viewport = $state<Rect>({ x: 0, y: 0, width: 0, height: 0 });
	let dragging = $state(false);
	/** Which divider is under the pointer right now; it keeps the accent for the whole drag. */
	let draggingSash = $state<string | null>(null);
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
	/*
	 * The floating panes in a fixed document order; `z` alone says which is on top. Drawing them
	 * in z-order moved a pane's element when a press raised it, in the middle of that press: the
	 * browser then aims the rest of it somewhere else and the click never arrives, so the first
	 * click on anything in a pane underneath was lost.
	 */
	const floatingInPlace = $derived(
		[...layout.floating].sort((a, b) => (a.leaf.id < b.leaf.id ? -1 : a.leaf.id > b.leaf.id ? 1 : 0))
	);
	/** A floating pane always has the tiled tree beside it, so either one means two or more. */
	const divided = $derived(layout.root.type === 'branch' || layout.floating.length > 0);
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
	 * Only the branches this drag touches are written to. Every pane on that branch takes its new
	 * share immediately; what waits until release is the measuring those panes do from a resize.
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
		draggingSash = sashId;
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
			draggingSash = null;
			try {
				const delta = drag.axis === 'row' ? endEvent.clientX - originX : endEvent.clientY - originY;
				if (delta !== 0) {
					onLayout(resizeSash(layout, drag, delta));
					flushSync();
				}
			} finally {
				dragGate.end();
			}
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
			try {
				const delta = deltaOf(endEvent);
				if (delta.across !== 0 || delta.along !== 0) {
					onLayout(resizeJunction(layout, drag, delta));
					flushSync();
				}
			} finally {
				dragGate.end();
			}
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

	/** Make the pane an event happened in the current one. */
	function focusFrom(target: EventTarget | null): void {
		const leaf = (target as HTMLElement | null)?.closest<HTMLElement>('[data-leaf]');
		if (leaf?.dataset.leaf) focus(leaf.dataset.leaf);
	}

	/*
	 * Scrolling a pane makes it the current one, the way a press in it does. A listener of its
	 * own rather than an `onwheel` attribute: Svelte leaves wheel listeners active, and an active
	 * one here would make the browser wait on it before every scroll step in every pane. Once
	 * the pane is current, `focusLeaf` hands back the same layout, so a long scroll writes once.
	 */
	$effect(() => {
		const element = host;
		if (!element) return;
		const onWheel = (event: WheelEvent) => focusFrom(event.target);
		element.addEventListener('wheel', onWheel, { capture: true, passive: true });
		return () => element.removeEventListener('wheel', onWheel, { capture: true });
	});

	/**
	 * A right-click anywhere in a pane opens its menu, unless something inside has already
	 * answered it. The message menu and the editor's say so by cancelling the event, and they run
	 * first because they sit deeper. A text field answers by being one: its own menu is where
	 * paste is. The terminal's field does not count — it is xterm's hidden textarea, moved under
	 * the pointer — so a terminal pane splits like any other.
	 */
	const OWN_MENU = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
	let paneMenu = $state<{
		leafId: string;
		/** The tab right-clicked, when it was one: what it offers comes first. */
		tabId: string | null;
		x: number;
		y: number;
		seq: number;
		edit: PaneEdit | null;
		canCopy: boolean;
	} | null>(null);
	let paneMenuSeq = 0;
	const paneMenuFloating = $derived(
		paneMenu ? layout.floating.some((pane) => pane.leaf.id === paneMenu!.leafId) : false
	);

	function openPaneMenu(event: MouseEvent): void {
		// ⌥ asks for the webview's own menu: Inspect Element, and copy where there is a selection.
		// A rendered picture has its own menu (copy image); it cancels the event before this runs.
		if (!wide || event.defaultPrevented || event.altKey) return;
		const target = event.target as HTMLElement | null;
		if (!target || (target.closest(OWN_MENU) && !target.closest('.xterm'))) return;
		const leafId =
			target.closest<HTMLElement>('[data-leaf]')?.dataset.leaf ??
			target.closest<HTMLElement>('[data-float]')?.dataset.float;
		if (!leafId) return;
		event.preventDefault();
		let { clientX: x, clientY: y } = event;
		// From the keyboard there is no pointer: hang it off whatever had focus instead.
		if (x === 0 && y === 0) {
			const box = (event.target as HTMLElement).getBoundingClientRect();
			x = box.left;
			y = box.bottom;
		}
		const edit = paneEditAt(target);
		const tabId = target.closest<HTMLElement>('[data-tab]')?.dataset.tab ?? null;
		paneMenu = { leafId, tabId, x, y, seq: ++paneMenuSeq, edit, canCopy: edit?.canCopy() ?? false };
	}

	/** Read while the menu is open, so a pin toggled elsewhere is not shown the old way round. */
	function actionsOf(leafId: string, tabId: string | null): TabAction[] {
		if (!tabId || !tabActions) return [];
		const leaf = tiledLeaves(layout.root).find((candidate) => candidate.id === leafId) ??
			layout.floating.find((pane) => pane.leaf.id === leafId)?.leaf;
		const tab = leaf?.tabs.find((candidate) => candidate.id === tabId);
		return tab ? tabActions(leafId, tab) : [];
	}

	function fitsFor(leafId: string): { row: boolean; column: boolean } {
		const room = (axis: 'row' | 'column') => canSplit(layout, leafId, axis, viewport, mins, WB_FALLBACK_MIN);
		return { row: room('row'), column: room('column') };
	}

	/** The same split ⌘\ makes, aimed at the pane that was right-clicked and in any direction. */
	function splitTowards(leafId: string, dir: Direction): void {
		const next = applyCommand(
			focusLeaf(layout, leafId),
			{ kind: 'split', ...SPLIT_TOWARDS[dir] },
			{ viewport, mins, ids: freshId, newPaneMin: WB_FALLBACK_MIN },
			(current, id, axis, side) => splitLeaf(current, id, axis, side, [], { leaf: freshId(), branch: freshId() })
		);
		if (next !== layout) onLayout(next);
	}

	function closePane(leafId: string): void {
		if (onClosePane) onClosePane(leafId);
		else onLayout(closeLeaf(layout, leafId, freshId()));
	}

	/** A pane that goes away — closed, docked, healed — takes its menu with it. */
	$effect(() => {
		const open = paneMenu;
		if (!open) return;
		const exists =
			tiledLeaves(layout.root).some((leaf) => leaf.id === open.leafId) ||
			layout.floating.some((pane) => pane.leaf.id === open.leafId);
		if (!exists || !wide) paneMenu = null;
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="wb-root"
	class:is-dragging={dragging}
	class:is-solo={!wide}
	bind:this={host}
	onpointerdowncapture={(event) => focusFrom(event.target)}
	onfocusincapture={(event) => focusFrom(event.target)}
	oncontextmenu={openPaneMenu}
	onkeydowncapture={(event) => {
		// Scrolling another pane leaves the caret where it was. Typing there again is the keyboard
		// saying where it is, so the current pane goes back with it. Only for typing: ⌘⌥ arrows
		// move the current pane without moving focus, and must not be pulled back to it.
		if (isTypingTarget(event.target)) focusFrom(event.target);
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
				onClosePane={closePane}
				{onMenu}
				{emptyActions}
				{menuActions}
				{tabActions}
			/>
		{/if}
	{:else}
		<WorkbenchBranch
			node={layout.root}
			focusId={layout.focus.leafId}
			{divided}
			{mins}
			{t}
			{tabBody}
			{tabLabel}
			onFocus={focus}
			onActivate={(leafId, tabId) => onActivate?.(leafId, tabId)}
			onCloseTab={(leafId, tabId) => onCloseTab?.(leafId, tabId)}
			onClosePane={closePane}
			onSashPointerDown={startSash}
			{draggingSash}
			onTabPointerDown={(event, leafId, tabId) =>
				startPaneDrag(event, beginTabDrag(leafId, tabId, pointFrom(event)), nameOf(leafId, tabId))}
			onStripPointerDown={(event, leafId) => {
				if ((event.target as HTMLElement).closest('.wb-tab, .wb-pane-menu, .wb-pane-close, .wb-new-tab, .wb-new-menu')) return;
				startPaneDrag(event, beginLeafDrag(leafId, pointFrom(event)), nameOf(leafId, null));
			}}
			{onMenu}
			{emptyActions}
			{menuActions}
			{tabActions}
		/>

		{#each floatingInPlace as pane (pane.leaf.id)}
			<WorkbenchFloat
				leaf={pane.leaf}
				frame={pane.frame}
				z={layout.floating.indexOf(pane)}
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
				onClosePane={closePane}
				onTabPointerDown={(event, leafId, tabId) =>
					startPaneDrag(event, beginTabDrag(leafId, tabId, pointFrom(event)), nameOf(leafId, tabId))}
				{onDock}
				{onMenu}
				{emptyActions}
				{menuActions}
				{tabActions}
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

		{#if paneMenu}
			{@const open = paneMenu}
			{#key open.seq}
				<PaneContextMenu
					x={open.x}
					y={open.y}
					{t}
					actions={actionsOf(open.leafId, open.tabId)}
					fits={fitsFor(open.leafId)}
					floating={paneMenuFloating}
					edit={open.edit ? { canCopy: open.canCopy, onCopy: open.edit.copy, onPaste: open.edit.paste } : null}
					onSplit={(dir) => splitTowards(open.leafId, dir)}
					onDock={() => onDock(open.leafId)}
					onClosePane={() => closePane(open.leafId)}
					onClose={() => (paneMenu = null)}
				/>
			{/key}
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
		/*
		 * The gutter colour, owned here rather than inherited. Panes paint themselves `--pane`,
		 * so whatever shows between them is the seam — and if that is left to whatever happens to
		 * be behind the workbench, the seam is invisible wherever the host is also `--pane`,
		 * which is exactly what the main column is.
		 */
		background: var(--bg);
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
	/*
	 * Visible at rest, because a point that drags in two directions is not something to discover
	 * by sweeping the pointer around. A small diamond sitting on the crossing, taking the accent
	 * and growing when you are on it.
	 */
	.wb-junction::before {
		content: '';
		position: absolute;
		inset: 9px;
		border-radius: 2px;
		background: var(--line-hover);
		transform: rotate(45deg);
		transition:
			inset 0.12s ease,
			background 0.12s ease;
	}
	.wb-junction:hover::before,
	.wb-junction:focus-visible::before {
		inset: 6px;
		background: var(--accent);
	}
	@media (prefers-reduced-motion: reduce) {
		.wb-junction::before {
			transition: none;
		}
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
		color: var(--ink);
		background: var(--pane);
		box-shadow: 0 4px 12px rgb(0 0 0 / 0.2);
		pointer-events: none;
		white-space: nowrap;
	}
</style>
