<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { RoutingEdgeKey, RoutingLane, RoutingNodeId, RoutingNodeView } from './routing-map.ts';

	/**
	 * The map of the app's own calls (ADR 0082): one lane per thing that sets calls off, its steps in
	 * the order they run, and beside a step the calls that run alongside it. Each call is a button
	 * that names its model; a wide window lays a lane out left to right, a phone top to bottom.
	 */
	interface Props {
		lanes: readonly RoutingLane[];
		/** A call's node as it shows: its model and its prompts' marks. */
		viewOf: (role: Exclude<RoutingNodeId, 'turn'>) => RoutingNodeView;
		/** What the Bot's own turn runs on, in a few words. */
		turnModel: string;
		selected: RoutingNodeId | null;
		/** Top to bottom, for a phone. */
		vertical: boolean;
		onpick: (node: RoutingNodeId) => void;
		t: Copy;
	}

	let { lanes, viewOf, turnModel, selected, vertical, onpick, t }: Props = $props();
	const c = $derived(t.routing);
</script>

{#snippet edge(key: RoutingEdgeKey | null, end = false)}
	<span class="routing-edge" class:is-end={end} aria-hidden={key ? undefined : 'true'}>
		{#if key}<span class="routing-edge-label">{c.edges[key]}</span>{/if}
		<span class="routing-edge-line"></span>
	</span>
{/snippet}

{#snippet node(id: RoutingNodeId, branch: boolean)}
	{#if id === 'turn'}
		<button
			type="button"
			class="routing-node is-turn"
			class:is-branch={branch}
			class:is-selected={selected === id}
			aria-pressed={selected === id}
			data-routing-node={id}
			onclick={() => onpick(id)}
		>
			<span class="routing-node-name">{c.turn.name}</span>
			<span class="routing-node-model is-follow">{turnModel}</span>
		</button>
	{:else}
		{@const view = viewOf(id)}
		<button
			type="button"
			class="routing-node"
			class:is-branch={branch}
			class:is-selected={selected === id}
			aria-pressed={selected === id}
			data-routing-node={id}
			onclick={() => onpick(id)}
		>
			<span class="routing-node-name">
				{t.builtinModels.roles[id].name}
				{#if view.conflict || view.failures > 0}
					{@const said = view.conflict ? c.conflict : c.failures(view.failures)}
					<span class="routing-mark is-warn" role="img" aria-label={said} title={said}></span>
				{:else if view.edited > 0}
					<span class="routing-mark" role="img" aria-label={c.edited(view.edited)} title={c.edited(view.edited)}></span>
				{/if}
			</span>
			<span class="routing-node-model" class:is-follow={!view.model}>{view.model ?? c.follows[view.follows]}</span>
		</button>
	{/if}
{/snippet}

<div class="routing-map" class:is-vertical={vertical} role="group" aria-label={c.mapLabel} data-routing-map>
	{#each lanes as lane (lane.key)}
		<section class="routing-lane" data-routing-lane={lane.key} aria-label={c.lanes[lane.key]}>
			<h4 class="routing-trigger">{c.lanes[lane.key]}</h4>
			<div class="routing-steps">
				{#each lane.steps as step (step.node)}
					{@render edge(step.edge)}
					<div class="routing-step">
						{@render node(step.node, false)}
						{#each step.branches as branch (branch.node)}
							<div class="routing-branch">
								<span class="routing-branch-edge">{c.edges[branch.edge]}</span>
								{@render node(branch.node, true)}
							</div>
						{/each}
					</div>
				{/each}
				{#if lane.end}
					{@render edge(lane.end, true)}
				{/if}
			</div>
		</section>
	{/each}
</div>

<style>
	/* The line's lane across the top; the lanes of one call each, two a row under it. */
	.routing-map {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
		min-width: 0;
	}

	.routing-lane:first-child {
		grid-column: 1 / -1;
	}

	.routing-lane {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 12px 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
		min-width: 0;
	}

	.routing-trigger {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	/* Left to right: an arrow, then the step it leads to, the calls beside a step under it. */
	.routing-steps {
		display: flex;
		align-items: flex-start;
		min-width: 0;
	}

	.routing-step {
		flex: 0 1 152px;
		min-width: 120px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.routing-branch {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding-left: 12px;
		border-left: 1px dashed var(--line-hover);
		margin-left: 10px;
	}

	.routing-branch-edge {
		font-size: 11px;
		line-height: 1.3;
		color: var(--muted);
	}

	/* An arrow, its word over it (two lines at most), level with the middle of the calls it joins. */
	.routing-edge {
		flex: 1 1 84px;
		min-width: 60px;
		max-width: 132px;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		gap: 3px;
		height: 32px;
		padding: 0 6px;
	}

	/* The lane's name over it says what sets it off: no arrow into its first call. */
	.routing-edge:first-child {
		display: none;
	}

	.routing-edge.is-end {
		max-width: none;
		flex: 1 1 auto;
	}

	.routing-edge-label {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		font-size: 11px;
		line-height: 1.2;
		color: var(--muted);
		text-align: center;
	}

	.routing-edge.is-end .routing-edge-label {
		text-align: left;
		white-space: normal;
	}

	.routing-edge-line {
		position: relative;
		height: 1px;
		margin-bottom: 4px;
		background: var(--muted);
		opacity: 0.6;
	}

	.routing-edge-line::after {
		content: '';
		position: absolute;
		right: -1px;
		top: -3px;
		border: 3.5px solid transparent;
		border-left: 6px solid var(--muted);
		border-right-width: 0;
	}

	.routing-node {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		width: 100%;
		min-width: 0;
		padding: 7px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--sidebar-bg);
		color: var(--ink);
		text-align: left;
		cursor: pointer;
		transition-property: background-color, border-color, box-shadow;
	}

	.routing-node:hover {
		background: var(--row-hover);
	}

	.routing-node:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.routing-node.is-selected {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		box-shadow: 0 0 0 1px var(--accent-border);
	}

	/* The Bot's own turn is not one of these calls: dashed, the calls hang off it. */
	.routing-node.is-turn {
		border-style: dashed;
	}

	.routing-node.is-branch {
		padding: 5px 9px;
	}

	.routing-node-name {
		display: flex;
		align-items: center;
		gap: 5px;
		max-width: 100%;
		font-size: 13px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.routing-node.is-branch .routing-node-name {
		font-size: 12px;
	}

	/* A long model and the agent it runs on take a second line rather than lose their end. */
	.routing-node-model {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		max-width: 100%;
		overflow: hidden;
		overflow-wrap: anywhere;
		font: 11px/1.4 var(--mono);
		color: var(--ink-secondary);
	}

	.routing-node-model.is-follow {
		font-family: inherit;
		color: var(--muted);
	}

	.routing-mark {
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: var(--radius-full);
		background: var(--accent);
	}

	.routing-mark.is-warn {
		background: var(--warn-text);
	}

	/* A phone: one lane a row, a lane's steps running down, each arrow between them with its word beside it. */
	.routing-map.is-vertical {
		grid-template-columns: minmax(0, 1fr);
	}

	.routing-map.is-vertical .routing-steps {
		flex-direction: column;
		align-items: stretch;
	}

	.routing-map.is-vertical .routing-step {
		flex: none;
		min-width: 0;
	}

	.routing-map.is-vertical .routing-edge {
		flex: none;
		max-width: none;
		height: auto;
		min-height: 22px;
		flex-direction: row-reverse;
		justify-content: flex-end;
		align-items: center;
		gap: 8px;
		padding: 2px 0 2px 14px;
	}

	.routing-map.is-vertical .routing-edge-label {
		text-align: left;
		white-space: normal;
	}

	.routing-map.is-vertical .routing-edge-line {
		flex: none;
		width: 1px;
		height: 18px;
		margin: 0;
	}

	.routing-map.is-vertical .routing-edge-line::after {
		right: -3px;
		top: auto;
		bottom: -1px;
		border: 3.5px solid transparent;
		border-top: 6px solid var(--muted);
		border-bottom-width: 0;
	}

	.routing-map.is-vertical .routing-node {
		padding: 9px 12px;
	}
</style>
