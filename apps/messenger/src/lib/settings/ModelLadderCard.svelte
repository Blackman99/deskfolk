<script lang="ts">
	import {
		AGENT_KINDS,
		CLAUDE_MODEL_ALIASES,
		isLadderAgentRung,
		MODEL_LADDER_MAX,
		sameLadderRung,
		type AgentsStatusResponse,
		type BotRunner,
		type ClaudeCodeStatus,
		type ModelLadderAgentRung,
		type ModelLadderRung,
		type Provider
	} from '@real-bot/protocol';
	import { onMount, tick } from 'svelte';
	import { flip } from 'svelte/animate';
	import ModelPicker from '../ModelPicker.svelte';
	import Select from '../Select.svelte';
	import type { Copy } from '../copy.ts';
	import type { ModelLadder } from './model-ladder.svelte.ts';
	import { beginLadderDrag, ladderPlace, movedTo, type LadderDrag } from './ladder-drag.ts';
	import { sourceCount, type PickerData } from '../model-picker.ts';
	import { agentPickerSources, claudePickerSource, endpointPickerSources } from '../model-picker-sources.ts';
	import { endpointSource, runnerSource } from '../model-source.ts';
	import { agentAccountOptions, agentAccountsOf, agentLabelOf, agentModelsOf, agentStatusOf } from '../runner-choice.ts';
	import { thinkingLevelLabel } from '../copy.ts';
	import { claudeAccountOptions, claudeReady } from './claude-agent.ts';
	import ModelSourceMark from '../ModelSourceMark.svelte';
	import { prefersReducedMotion } from '../reduced-motion.ts';

	/** The model ladder's own page (ADR 0054). What it says it is for is the page's intro, not this card's. */
	interface Props {
		/** Read and saved by its owner, which also needs it before this page opens. */
		ladder: ModelLadder;
		providers: readonly Provider[];
		/**
		 * What the daemon finds of your Claude Code (ADR 0076): once it is there and signed in, the
		 * Claude models Agent settings offer can be rungs too. Absent or failing (the phone cannot ask),
		 * none are offered, and the ones already on the ladder stay.
		 */
		claudeCode?: (() => Promise<ClaudeCodeStatus>) | null;
		/**
		 * What the daemon finds of your other local agents (ADR 0079): the models of those found and
		 * signed in can be rungs too, grouped by agent. Absent or failing, none are offered.
		 */
		agents?: (() => Promise<AgentsStatusResponse>) | null;
		t: Copy;
	}

	let { ladder, providers, claudeCode = null, agents = null, t }: Props = $props();

	let claudeStatus = $state<ClaudeCodeStatus | null>(null);
	let agentsFound = $state<AgentsStatusResponse | null>(null);
	onMount(() => {
		void claudeCode?.().then(
			(status) => (claudeStatus = status),
			() => (claudeStatus = null)
		);
		if (agents) {
			// Called inside the try: a client that has no such call (an older Mac, a fake) fails as an answer does.
			void (async () => {
				try {
					agentsFound = await agents();
				} catch {
					agentsFound = null;
				}
			})();
		}
	});

	let list = $state<HTMLOListElement | null>(null);
	/** The rung being dragged and where it would land; the others make room while it is held. */
	let drag = $state<LadderDrag | null>(null);

	const key = (rung: ModelLadderRung) =>
		JSON.stringify(
			isLadderAgentRung(rung)
				? { runner: rung.runner, model: rung.model, effort: rung.effort, config_dir: rung.config_dir, ...(rung.custom_id ? { custom_id: rung.custom_id } : {}) }
				: { provider_id: rung.provider_id, model: rung.model }
		);
	const providerOf = (id: string) => providers.find((provider) => provider.id === id);
	const providerName = (id: string) => providerOf(id)?.name ?? id;
	/** Whose a rung is: Claude Agent, or the other agent's name (your own ACP agent by the name you gave it). */
	const agentName = (rung: ModelLadderAgentRung) =>
		rung.runner === 'claude_code' ? t.claudeAgent.title : agentLabelOf(rung.runner, rung.custom_id ?? null, agentsFound);
	const named = (rung: ModelLadderRung) =>
		isLadderAgentRung(rung)
			? `${rung.model} · ${agentName(rung)}`
			: providers.length > 1
				? `${rung.model} · ${providerName(rung.provider_id)}`
				: rung.model;

	/** Agent models are added at the agent's default effort, on this computer's default account; each rung then picks its own. */
	const agentRung = (runner: BotRunner, model: string, customId: string | null = null): ModelLadderAgentRung => ({
		runner,
		model,
		effort: null,
		config_dir: null,
		...(customId ? { custom_id: customId } : {})
	});
	const claudeRung = (model: string) => agentRung('claude_code', model);
	const onLadder = (rung: ModelLadderRung) => ladder.rungs.some((kept) => sameLadderRung(kept, rung));

	/** What the agents list, else the default model one named: the models a rung can be. */
	const agentsOffered = $derived<AgentsStatusResponse | null>(
		agentsFound ? { ...agentsFound, items: agentsFound.items.map((status) => ({ ...status, models: agentModelsOf(status) })) } : null
	);

	/**
	 * What is listed and not on the ladder yet: each endpoint, then the Claude models Agent settings
	 * offer, then each other agent found and signed in, which also takes a model typed into the
	 * search. A source with nothing left to add is left out.
	 */
	const addable = $derived.by((): PickerData => {
		const claudeModels = CLAUDE_MODEL_ALIASES.filter((model) => !onLadder(claudeRung(model)));
		const sources = [
			...endpointPickerSources(
				providers,
				t,
				(provider_id, model) => key({ provider_id, model }),
				(provider_id, model) => !onLadder({ provider_id, model })
			),
			...(claudeReady(claudeStatus) && claudeModels.length > 0 ? [claudePickerSource(t, (model) => key(claudeRung(model)), claudeModels)] : []),
			...agentPickerSources(agentsOffered, t, (runner, model, customId) => key(agentRung(runner, model, customId)), {
				typed: true,
				keep: (runner, model, customId) => !onLadder(agentRung(runner, model, customId))
			})
		];
		return { specials: [], sources: sources.filter((source) => sourceCount(source) > 0 || source.custom) };
	});

	/** The effort levels a rung's agent takes; none for one that has none. */
	const effortOptions = (rung: ModelLadderAgentRung) => [
		{ value: '', label: t.modelLadder.effort(t.sidebar.botAgentEffortDefault) },
		...AGENT_KINDS[rung.runner].efforts.map((level) => ({ value: level, label: t.modelLadder.effort(thinkingLevelLabel(t.sidebar.thinkingLevels, level)) }))
	];
	/**
	 * The accounts a rung can spend, named short enough to sit beside its effort: this computer's
	 * default, else the account's email (Claude) or what it signs in with (the others), its directory
	 * when there is none.
	 */
	const accountOptions = (rung: ModelLadderAgentRung) => {
		const current = rung.config_dir ?? '';
		if (rung.runner !== 'claude_code') return agentAccountOptions(agentStatusOf(agentsFound, rung.runner, rung.custom_id ?? null), current, t);
		return claudeAccountOptions(claudeStatus, current, t).map((option) => ({
			value: option.value,
			label: option.value
				? (claudeStatus?.accounts?.find((account) => account.config_dir === option.value)?.email ?? option.value)
				: t.sidebar.botAgentAccountDefault
		}));
	};
	/** An account is picked per rung only when there is more than one, or the rung is on one already. */
	const accountsShown = (rung: ModelLadderAgentRung) =>
		(rung.runner === 'claude_code'
			? (claudeStatus?.accounts?.length ?? 0)
			: agentAccountsOf(agentStatusOf(agentsFound, rung.runner, rung.custom_id ?? null)).length) > 1 || Boolean(rung.config_dir);

	/** An agent rung's effort or account changed: the ladder is saved with it in its place. */
	function retune(index: number, change: Partial<Pick<ModelLadderAgentRung, 'effort' | 'config_dir'>>): void {
		const rung = ladder.rungs[index];
		if (ladder.busy || !rung || !isLadderAgentRung(rung)) return;
		void ladder.save(ladder.rungs.map((kept, at) => (at === index ? { ...rung, ...change } : kept)));
	}

	/** Where a rung stands now, counting the place a held rung would land in. */
	const placeOf = (index: number) => (drag ? ladderPlace(index, drag.from, drag.slot) : index);
	/** How far up the ladder a place is, 0 at the weakest and 100 at the strongest: the rung's colour. */
	const strength = (place: number) => (ladder.rungs.length > 1 ? Math.round((place / (ladder.rungs.length - 1)) * 100) : 100);
	const offsetOf = (index: number) => (!drag ? 0 : index === drag.from ? drag.dy : (placeOf(index) - index) * drag.shift);

	function reorder(from: number, slot: number): void {
		if (ladder.busy || from === slot || slot < 0 || slot >= ladder.rungs.length) return;
		void ladder.save(movedTo(ladder.rungs, from, slot));
	}

	function press(event: PointerEvent, index: number): void {
		if (ladder.busy || !list) return;
		const rows = [...list.querySelectorAll<HTMLElement>(':scope > .ladder-rung')];
		beginLadderDrag(event, index, rows, { onDrag: (next) => (drag = next), onDrop: reorder });
	}

	/** The grip moves its rung by keyboard too. Moving a rung takes the focus out of the page, so it is put back on the same grip. */
	async function key_(event: KeyboardEvent, index: number): Promise<void> {
		const by = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
		if (!by) return;
		event.preventDefault();
		if (ladder.busy || index + by < 0 || index + by >= ladder.rungs.length) return;
		reorder(index, index + by);
		await tick();
		list?.querySelectorAll<HTMLElement>('.ladder-grip')[index + by]?.focus();
	}

	/** The add picker's choice, put back to its placeholder once added: the rung shows on the list. */
	let picking = $state('');
	function add(value: string): void {
		picking = '';
		if (!value) return;
		const rung = JSON.parse(value) as ModelLadderRung;
		// A name typed into the search can be one already on the ladder.
		if (onLadder(rung)) return;
		void ladder.save([...ladder.rungs, rung]);
	}
</script>

{#if ladder.available}
	<section class="ladder-card" aria-label={t.modelLadder.title} data-model-ladder>
		{#if ladder.failed}
			<p class="ladder-error" role="alert">{t.modelLadder.failed}</p>
		{/if}
		{#if ladder.rungs.length === 0}
			<p class="ladder-empty">{t.modelLadder.empty}</p>
		{:else}
			{#if ladder.rungs.length > 1}
				<!-- The colours' legend: words too, since a colour alone says nothing to some. -->
				<div class="ladder-scale" aria-hidden="true">
					<span>{t.modelLadder.weaker}</span>
					<span class="ladder-scale-bar"></span>
					<span>{t.modelLadder.stronger}</span>
				</div>
			{/if}
			<ol class="ladder-list" class:is-dragging={drag !== null} bind:this={list}>
				{#each ladder.rungs as rung, index (key(rung))}
					{@const agent = isLadderAgentRung(rung) ? rung : null}
					{@const provider = isLadderAgentRung(rung) ? undefined : providerOf(rung.provider_id)}
					{@const place = placeOf(index)}
					<!-- flip runs as a Web Animation, which the global reduced-motion rule does not reach. -->
					<li
						class="ladder-rung"
						class:is-held={drag?.from === index}
						class:is-last={index === ladder.rungs.length - 1}
						class:is-deep={strength(place) > 60}
						data-rung={rung.model}
						style:--rung-strength="{strength(place)}%"
						style:--rung-next="{strength(place + 1)}%"
						style:transform={drag ? `translateY(${offsetOf(index)}px)` : null}
						animate:flip={{ duration: prefersReducedMotion() ? 0 : 160 }}
					>
						<span class="ladder-step" aria-hidden="true">{place + 1}</span>
						<div class="ladder-body">
							{#if agent}
								<!-- An agent rung (ADR 0076, ADR 0079) is tuned as Agent settings tune a Bot: its effort where the agent takes one, and the account it spends. -->
								<span class="ladder-name" title={named(rung)}><span class="ladder-model">{rung.model}</span></span>
								<span class="ladder-source"><ModelSourceMark source={runnerSource(agent.runner, agentName(agent), t)} /></span>
								{#if AGENT_KINDS[agent.runner].efforts.length > 0 || accountsShown(agent)}
									<span class="ladder-tune" data-rung-agent={agent.runner} data-rung-claude={agent.runner === 'claude_code' ? '' : undefined}>
										{#if AGENT_KINDS[agent.runner].efforts.length > 0}
											<Select
												value={agent.effort ?? ''}
												options={effortOptions(agent)}
												size="sm"
												ariaLabel={t.modelLadder.effortOf(rung.model)}
												disabled={ladder.busy}
												onchange={(value) => retune(index, { effort: value || null })}
											/>
										{/if}
										{#if accountsShown(agent)}
											<Select
												value={agent.config_dir ?? ''}
												options={accountOptions(agent)}
												size="sm"
												ariaLabel={t.modelLadder.accountOf(rung.model)}
												disabled={ladder.busy}
												onchange={(value) => retune(index, { config_dir: value || null })}
											/>
										{/if}
									</span>
								{/if}
							{:else if !isLadderAgentRung(rung)}
								<span class="ladder-name" title={named(rung)}><span class="ladder-model">{rung.model}</span>{#if providers.length > 1}<span class="ladder-sep">{' · '}</span><span class="ladder-provider">{providerName(rung.provider_id)}</span>{/if}</span>
								<!-- Where the model comes from, as in the picker that added it; an endpoint gone since has none. -->
								{#if provider}
									<span class="ladder-source"><ModelSourceMark source={endpointSource(provider, t)} /></span>
								{/if}
							{/if}
							<button type="button" class="ladder-button ladder-remove" aria-label={t.modelLadder.remove(rung.model)} title={t.modelLadder.remove(rung.model)} disabled={ladder.busy} onclick={() => void ladder.save(ladder.rungs.filter((_, at) => at !== index))}>×</button>
							<!-- Not disabled while a save is out: the arrow keys would lose the focus they move with. -->
							<button
								type="button"
								class="ladder-button ladder-grip"
								aria-label={t.modelLadder.move(rung.model)}
								title={t.modelLadder.move(rung.model)}
								aria-disabled={ladder.busy}
								onpointerdown={(event) => press(event, index)}
								onkeydown={(event) => void key_(event, index)}
							>
								<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4" /><circle cx="7.5" cy="3" r="1.4" /><circle cx="2.5" cy="8" r="1.4" /><circle cx="7.5" cy="8" r="1.4" /><circle cx="2.5" cy="13" r="1.4" /><circle cx="7.5" cy="13" r="1.4" /></svg>
							</button>
						</div>
					</li>
				{/each}
			</ol>
		{/if}
		{#if addable.sources.length > 0 && ladder.rungs.length < MODEL_LADDER_MAX}
			<div class="ladder-add">
				<ModelPicker bind:value={picking} data={addable} {t} placeholder={t.modelLadder.add} size="sm" title={t.modelLadder.add} ariaLabel={t.modelLadder.add} disabled={ladder.busy} onchange={add} />
			</div>
		{/if}
	</section>
{/if}

<style>
	/* The ladder runs from a pale wash of the accent (weakest) to the accent itself (strongest). */
	.ladder-card {
		--ladder-weak: color-mix(in oklch, var(--accent) 22%, var(--pane));
		--ladder-strong: var(--accent);
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 14px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-xs);
		min-width: 0;
	}

	.ladder-empty {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.ladder-error {
		margin: 0;
		font-size: 12px;
		color: var(--danger-text);
	}

	.ladder-scale {
		display: flex;
		align-items: center;
		gap: 8px;
		max-width: 240px;
		font-size: 11px;
		color: var(--muted);
	}

	.ladder-scale-bar {
		flex: 1 1 auto;
		height: 4px;
		border-radius: 2px;
		background: linear-gradient(to right, var(--ladder-weak), var(--ladder-strong));
	}

	.ladder-list {
		--ladder-gap: 8px;
		/* Where a node's middle sits below its rung's top: the middle of a two-line rung. */
		--ladder-node-middle: 27px;
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--ladder-gap);
	}

	/* A node on the rail, then the rung's card. */
	.ladder-rung {
		--rung-color: color-mix(in oklch, var(--ladder-strong) var(--rung-strength), var(--ladder-weak));
		--rung-next-color: color-mix(in oklch, var(--ladder-strong) var(--rung-next), var(--ladder-weak));
		position: relative;
		display: flex;
		align-items: flex-start;
		gap: 10px;
		min-width: 0;
	}

	/* The rail from this node to the next one, shading on towards it. Nodes sit at one height from their rung's top, so it meets the next node even when a name wraps. */
	.ladder-rung:not(.is-last)::before {
		content: '';
		position: absolute;
		left: 10px;
		top: var(--ladder-node-middle);
		width: 3px;
		height: calc(100% + var(--ladder-gap));
		border-radius: 2px;
		background: linear-gradient(var(--rung-color), var(--rung-next-color));
	}

	/* While one is held the rungs move apart, and a rail between them would bend. */
	.ladder-list.is-dragging .ladder-rung::before {
		opacity: 0;
	}

	.ladder-list.is-dragging .ladder-rung:not(.is-held) {
		transition: transform 0.15s ease;
	}

	.ladder-rung.is-held {
		z-index: 1;
	}

	.ladder-step {
		position: relative;
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 23px;
		height: 23px;
		margin-top: calc(var(--ladder-node-middle) - 11.5px);
		border-radius: 50%;
		background: var(--rung-color);
		color: var(--ink);
		font-size: 11px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		transition: background-color 0.15s ease;
	}

	/* On the deeper rungs the number goes light, as on any accent fill. */
	.ladder-rung.is-deep .ladder-step {
		color: var(--on-accent);
	}

	/* The model's name has the first line to itself; where it comes from goes under it, so names line up whatever their mark. */
	.ladder-body {
		flex: 1 1 auto;
		min-width: 0;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto auto;
		grid-template-rows: auto auto;
		align-items: center;
		column-gap: 6px;
		row-gap: 2px;
		padding: 7px 4px 7px 12px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		transition: border-color 0.15s ease, box-shadow 0.15s ease;
	}

	.is-held .ladder-body {
		border-color: var(--accent-border);
		box-shadow: var(--shadow-md);
	}

	.ladder-name {
		display: contents;
	}

	/* A long model id wraps rather than losing its end, which is often what tells two apart. */
	.ladder-model {
		grid-column: 1 / span 2;
		grid-row: 1;
		min-width: 0;
		overflow-wrap: anywhere;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 12.5px;
		line-height: 1.35;
		color: var(--ink);
	}

	.ladder-source {
		grid-column: 1;
		grid-row: 2;
		display: inline-flex;
	}

	.ladder-sep {
		display: none;
	}

	.ladder-provider {
		grid-column: 2;
		grid-row: 2;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: var(--muted);
	}

	/* An agent rung's effort and account, where an endpoint rung names its endpoint. */
	.ladder-tune {
		grid-column: 2;
		grid-row: 2;
		display: flex;
		flex-wrap: wrap;
		gap: 4px 6px;
		min-width: 0;
		padding: 2px 0;
	}

	/* Each picker as wide as what it says, not the row. */
	.ladder-tune > :global(.real-select) {
		width: auto;
		min-width: 0;
		max-width: 100%;
	}

	.ladder-button {
		grid-row: 1 / span 2;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		padding: 0;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		font-size: 16px;
		line-height: 1;
		cursor: pointer;
		transition: background-color 0.15s ease, color 0.15s ease;
	}

	.ladder-button:hover:not(:disabled) {
		background: var(--row-hover);
		color: var(--ink);
	}

	.ladder-button:disabled {
		cursor: default;
		opacity: 0.4;
	}

	.ladder-remove {
		grid-column: 3;
	}

	/* Where a rung is taken hold of: a finger on it drags, it never scrolls the page. */
	.ladder-grip {
		grid-column: 4;
		cursor: grab;
		touch-action: none;
	}

	.ladder-grip svg {
		fill: currentColor;
	}

	.is-held .ladder-grip {
		cursor: grabbing;
		color: var(--accent);
	}

	.ladder-add {
		max-width: 320px;
	}

	/* On a phone the buttons are big enough to tap. */
	@media (max-width: 720px) {
		.ladder-card {
			padding: 12px;
			box-shadow: none;
		}

		/* Tight enough that a 21-character model id stays on one line at 347 px. */
		.ladder-rung {
			gap: 8px;
		}

		.ladder-body {
			column-gap: 4px;
			padding: 7px 2px 7px 10px;
		}

		.ladder-model {
			font-size: 13px;
		}

		.ladder-button {
			width: 34px;
			height: 38px;
			font-size: 18px;
		}

		.ladder-add {
			max-width: none;
		}
	}
</style>
