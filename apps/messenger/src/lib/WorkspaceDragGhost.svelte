<script lang="ts">
	import { ghostPlacement, workspaceDrag } from './workspace-drag.svelte.ts';

	/**
	 * What rides under the pointer while files are dragged out of the tree. Mounted once on the
	 * shell, outside every pane: a floating pane's transform would pin `fixed` to that pane.
	 */
	const drag = $derived(workspaceDrag.current);
	let width = $state(0);
	let height = $state(0);
	const at = $derived(
		drag
			? ghostPlacement(drag, { width, height }, { width: window.innerWidth, height: window.innerHeight })
			: { x: 0, y: 0 }
	);
</script>

{#if drag}
	<div
		class="workspace-drag-ghost"
		class:is-over={drag.over !== null}
		style:transform={`translate3d(${at.x}px, ${at.y}px, 0)`}
		bind:offsetWidth={width}
		bind:offsetHeight={height}
		aria-hidden="true"
	>
		{drag.label}
	</div>
{/if}

<style>
	.workspace-drag-ghost {
		position: fixed;
		left: 0;
		top: 0;
		z-index: 1000;
		max-width: 280px;
		padding: 2px 8px;
		overflow: hidden;
		border-radius: 6px;
		font-size: 12px;
		color: var(--ink);
		background: var(--pane);
		box-shadow: 0 4px 12px rgb(0 0 0 / 0.2);
		pointer-events: none;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.workspace-drag-ghost.is-over {
		outline: 1.5px solid var(--accent);
	}
</style>
