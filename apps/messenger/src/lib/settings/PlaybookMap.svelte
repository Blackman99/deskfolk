<script lang="ts">
	import { playbookStep, type PlaybookResolved, type PlaybookStepId } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import Icon from '../Icon.svelte';
	import { layPlaybookFlow, paramText, stepDiffers, stepRole, type PlaybookCard, type PlaybookNodeId } from './playbook-flow.ts';
	import type { RoutingNodeView } from './routing-map.ts';

	/**
	 * One engine on Roles (ADR 0085), drawn as the flow board draws a job: a round per thing that
	 * sets steps off, its root card on top and the steps it sets off under it, each a small card
	 * saying what it runs on now. A step that is off is dashed and dim, one that always runs has a
	 * lock, one changed from its built-in a dot; a call's prompt conflict or unread answers a warning.
	 */
	interface Props {
		resolved: PlaybookResolved;
		builtin: PlaybookResolved;
		viewOf: (role: NonNullable<ReturnType<typeof stepRole>>) => RoutingNodeView;
		/** What a Bot's turn runs on: its own model, or the ladder. */
		turnModel: string;
		selected: PlaybookNodeId | null;
		onpick: (node: PlaybookNodeId) => void;
		t: Copy;
	}

	let { resolved, builtin, viewOf, turnModel, selected, onpick, t }: Props = $props();
	const c = $derived(t.playbooks);

	let width = $state(0);
	const layout = $derived(layPlaybookFlow(width || 360));

	/** A step's line under its name: off, else its model, else its first number. */
	function said(step: PlaybookStepId): string {
		const setting = resolved[step];
		if (!setting.on) return c.offShort;
		const role = stepRole(step);
		if (role) {
			const view = viewOf(role);
			return view.model ?? t.routing.follows[view.follows];
		}
		const spec = playbookStep(step);
		const first = spec.params[0];
		return first ? paramText(first, setting.params[first.key]!, c.unit) : c.on;
	}

	function warned(step: PlaybookStepId): boolean {
		const role = stepRole(step);
		if (!role) return false;
		const view = viewOf(role);
		return view.conflict || view.failures > 0;
	}

	function rootLabel(card: PlaybookCard): string {
		return c.hooks[card.hook]!;
	}
</script>

<div class="playbook-map" role="group" aria-label={c.title} data-playbook-map bind:clientWidth={width}>
	<div class="playbook-flow" style:width="{layout.width}px" style:height="{layout.height}px">
		<svg class="playbook-edges" width={layout.width} height={layout.height} aria-hidden="true">
			{#each layout.edges as edge (edge.to)}
				<path d={edge.d} class:is-off={edge.to !== 'turn' && !resolved[edge.to as PlaybookStepId]?.on}></path>
			{/each}
		</svg>
		{#each layout.cards as card (card.id)}
			{#if card.node === 'turn'}
				<button
					type="button"
					class="playbook-card is-root is-turn"
					class:is-selected={selected === 'turn'}
					style:left="{card.x}px"
					style:top="{card.y}px"
					style:width="{card.w}px"
					style:height="{card.h}px"
					aria-pressed={selected === 'turn'}
					data-playbook-node="turn"
					data-playbook-round="turn"
					onclick={() => onpick('turn')}
				>
					<span class="playbook-card-title">{c.hooks.turn}</span>
					<span class="playbook-card-said">{turnModel}</span>
				</button>
			{:else if card.kind === 'root'}
				<div class="playbook-card is-root" style:left="{card.x}px" style:top="{card.y}px" style:width="{card.w}px" style:height="{card.h}px" data-playbook-round={card.hook}>
					<span class="playbook-card-title">{rootLabel(card)}</span>
				</div>
			{:else}
				{@const step = card.node as PlaybookStepId}
				{@const spec = playbookStep(step)}
				<button
					type="button"
					class="playbook-card is-step"
					class:is-off={!resolved[step].on}
					class:is-selected={selected === step}
					class:is-warn={warned(step)}
					style:left="{card.x}px"
					style:top="{card.y}px"
					style:width="{card.w}px"
					style:height="{card.h}px"
					aria-pressed={selected === step}
					data-playbook-node={step}
					data-on={resolved[step].on}
					onclick={() => onpick(step)}
				>
					<span class="playbook-card-head">
						<span class="playbook-card-dot" aria-hidden="true"></span>
						<span class="playbook-card-title">{c.steps[step]!.name}</span>
						{#if stepDiffers(step, resolved, builtin)}
							<span class="playbook-card-mark" role="img" aria-label={c.changed} title={c.changed} data-differs></span>
						{/if}
						{#if !spec.switchable}
							<Icon name="lock" size={12} class="playbook-card-lock" label={c.locked} title={c.locked} />
						{/if}
					</span>
					<span class="playbook-card-said">{said(step)}</span>
				</button>
			{/if}
		{/each}
	</div>
</div>

<style>
	.playbook-map {
		position: relative;
		width: 100%;
		min-width: 0;
		overflow-x: auto;
		overflow-y: hidden;
	}

	.playbook-flow {
		position: relative;
		margin: 0 auto;
	}

	.playbook-edges {
		position: absolute;
		inset: 0;
		overflow: visible;
		pointer-events: none;
	}

	.playbook-edges path {
		fill: none;
		stroke: var(--line-hover);
		stroke-width: 1.5;
	}

	.playbook-edges path.is-off {
		stroke-dasharray: 4 4;
		opacity: 0.6;
	}

	.playbook-card {
		position: absolute;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 2px;
		padding: 6px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		color: inherit;
		text-align: left;
		min-width: 0;
		/* Not the buttons' `all`: a card moving with the layout must not slide there. */
		transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
	}

	button.playbook-card {
		cursor: pointer;
	}

	button.playbook-card:hover {
		background: var(--line-subtle);
	}

	.playbook-card:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.playbook-card.is-root {
		align-items: center;
		background: var(--chip);
		font-size: 12px;
		font-weight: 600;
	}

	.playbook-card.is-turn {
		border-style: dashed;
		background: var(--pane);
	}

	.playbook-card.is-turn .playbook-card-said {
		font-weight: 400;
	}

	/* A step, as the flow board draws one of the app's own calls. */
	.playbook-card.is-step {
		border-style: dashed;
	}

	.playbook-card.is-selected {
		border-style: solid;
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--accent);
	}

	.playbook-card.is-off {
		opacity: 0.55;
	}

	.playbook-card-head {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		min-width: 0;
	}

	.playbook-card-dot {
		width: 6px;
		height: 6px;
		flex: none;
		border-radius: var(--radius-full);
		background: var(--ok);
	}

	.playbook-card.is-off .playbook-card-dot {
		background: var(--muted);
	}

	.playbook-card.is-warn .playbook-card-dot {
		background: var(--warn);
	}

	.playbook-card-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		font-size: 12px;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.playbook-card-mark {
		width: 6px;
		height: 6px;
		flex: none;
		border-radius: var(--radius-full);
		background: var(--accent);
	}

	.playbook-card :global(.playbook-card-lock) {
		flex: none;
		color: var(--muted);
	}

	.playbook-card-said {
		width: 100%;
		overflow: hidden;
		color: var(--muted);
		font-size: 11px;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
</style>
