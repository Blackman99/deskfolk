<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LayoutNode, MinSizeLookup, TabAction, WorkbenchTab } from './layout-types.ts';
	import type { Copy } from '../copy.ts';
	import { minSize, trackTemplate } from './layout-geometry.ts';
	import WorkbenchLeaf from './WorkbenchLeaf.svelte';
	import Self from './WorkbenchBranch.svelte';

	type Props = {
		node: LayoutNode;
		focusId: string;
		/** More than one pane is showing, so the current one is framed. */
		divided: boolean;
		mins: MinSizeLookup;
		t: Copy;
		tabBody: Snippet<[WorkbenchTab, string]>;
		tabLabel: Snippet<[WorkbenchTab]>;
		onFocus: (leafId: string) => void;
		onActivate: (leafId: string, tabId: string) => void;
		onCloseTab: (leafId: string, tabId: string) => void;
		onClosePane?: (leafId: string) => void;
		onSashPointerDown: (event: PointerEvent, sashId: string) => void;
		/** The divider being dragged right now, so it keeps the accent while the pointer is down. */
		draggingSash?: string | null;
		onTabPointerDown?: (event: PointerEvent, leafId: string, tabId: string) => void;
		onStripPointerDown?: (event: PointerEvent, leafId: string) => void;
		onMenu?: (event: MouseEvent, leafId: string) => void;
		emptyActions?: Snippet<[string]>;
		menuActions?: Snippet<[string, string]>;
		tabActions?: (leafId: string, tab: WorkbenchTab) => TabAction[];
	};

	let { node, focusId, divided, mins, t, tabBody, tabLabel, ...rest }: Props = $props();

	const row = $derived(node.type === 'branch' && node.axis === 'row');
	const tracks = $derived(
		node.type === 'branch'
			? trackTemplate(
					node,
					node.children.map((child) => {
						const min = minSize(child, mins);
						return node.axis === 'row' ? min.width : min.height;
					})
				)
			: ''
	);
</script>

{#if node.type === 'leaf'}
	<WorkbenchLeaf
		leaf={node}
		focused={node.id === focusId}
		framed={divided && node.id === focusId}
		{t}
		{tabBody}
		{tabLabel}
		onFocus={rest.onFocus}
		onActivate={rest.onActivate}
		onCloseTab={rest.onCloseTab}
		onClosePane={rest.onClosePane}
		onTabPointerDown={rest.onTabPointerDown}
		onStripPointerDown={rest.onStripPointerDown}
		onMenu={rest.onMenu}
		emptyActions={rest.emptyActions}
		menuActions={rest.menuActions}
		tabActions={rest.tabActions}
	/>
{:else}
	<!--
		One grid per division. `minmax(<min>px, <w>fr)` is the fractional model with a floor, and
		the browser's own "find the size of an fr" loop is exactly the water-filling that
		`allocate()` reproduces for the handles. The dividers are real tracks, not an overlay, so
		they can never sit on top of content.
	-->
	<div
		class="wb-branch"
		class:is-row={row}
		class:is-col={!row}
		data-branch={node.id}
		style:--wb-tracks={tracks}
	>
		{#each node.children as child, index (child.id)}
			{#if index > 0}
				<button
					type="button"
					class="wb-sash"
					class:is-vertical={row}
					class:is-active={rest.draggingSash === `${node.id}#${index}`}
					data-sash={`${node.id}#${index}`}
					aria-label={t.pane.resize}
					onpointerdown={(event) => rest.onSashPointerDown(event, `${node.id}#${index}`)}
				></button>
			{/if}
			<Self
				node={child}
				{focusId}
				{divided}
				{mins}
				{t}
				{tabBody}
				{tabLabel}
				onFocus={rest.onFocus}
				onActivate={rest.onActivate}
				onCloseTab={rest.onCloseTab}
				onClosePane={rest.onClosePane}
				onSashPointerDown={rest.onSashPointerDown}
				draggingSash={rest.draggingSash}
				onTabPointerDown={rest.onTabPointerDown}
				onStripPointerDown={rest.onStripPointerDown}
				onMenu={rest.onMenu}
				emptyActions={rest.emptyActions}
				menuActions={rest.menuActions}
				tabActions={rest.tabActions}
			/>
		{/each}
	</div>
{/if}

<style>
	.wb-branch {
		display: grid;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}
	/* No transition on the tracks, ever: a drag has to follow the pointer exactly, and the
	   three-column shell already has to defeat its own transition to manage that. */
	.wb-branch.is-row {
		grid-template-columns: var(--wb-tracks);
		grid-template-rows: minmax(0, 1fr);
	}
	.wb-branch.is-col {
		grid-template-rows: var(--wb-tracks);
		grid-template-columns: minmax(0, 1fr);
	}
	/*
	 * The same grab bar the sidebar split has: a gutter the width of the track, with a rounded
	 * line down the middle that thickens and takes the accent when you are on it. A one-pixel
	 * hairline between two panes of the same colour is not something anyone can aim at.
	 */
	.wb-sash {
		position: relative;
		padding: 0;
		border: 0;
		background: var(--bg);
		cursor: row-resize;
		touch-action: none;
		z-index: 2;
	}
	.wb-sash.is-vertical {
		cursor: col-resize;
	}
	.wb-sash::before {
		content: '';
		position: absolute;
		background: var(--line);
		border-radius: 99px;
	}
	.wb-sash.is-vertical::before {
		inset: 0 3px;
	}
	.wb-sash:not(.is-vertical)::before {
		inset: 3px 0;
	}
	.wb-sash:hover::before,
	.wb-sash:focus-visible::before,
	.wb-sash.is-active::before {
		background: var(--accent);
	}
	.wb-sash.is-vertical:hover::before,
	.wb-sash.is-vertical:focus-visible::before,
	.wb-sash.is-vertical.is-active::before {
		inset: 0 2px;
	}
	.wb-sash:not(.is-vertical):hover::before,
	.wb-sash:not(.is-vertical):focus-visible::before,
	.wb-sash:not(.is-vertical).is-active::before {
		inset: 2px 0;
	}
</style>
