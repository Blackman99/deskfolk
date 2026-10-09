<script lang="ts">
	import { MODEL_LADDER_MAX, type ModelLadderRung, type Provider } from '@real-bot/protocol';
	import Select from '../Select.svelte';
	import type { Copy } from '../copy.ts';
	import type { ModelLadder } from './model-ladder.svelte.ts';

	/** The model ladder's own page (ADR 0054). What it says it is for is the page's intro, not this card's. */
	interface Props {
		/** Read and saved by its owner, which also needs it before this page opens. */
		ladder: ModelLadder;
		providers: readonly Provider[];
		t: Copy;
	}

	let { ladder, providers, t }: Props = $props();

	const key = (rung: ModelLadderRung) => JSON.stringify({ provider_id: rung.provider_id, model: rung.model });
	const providerName = (id: string) => providers.find((provider) => provider.id === id)?.name ?? id;
	const named = (rung: ModelLadderRung) => (providers.length > 1 ? `${rung.model} · ${providerName(rung.provider_id)}` : rung.model);

	const addable = $derived(
		providers.flatMap((provider) =>
			provider.models
				.filter((model) => !ladder.rungs.some((rung) => rung.provider_id === provider.id && rung.model === model))
				.map((model) => {
					const rung = { provider_id: provider.id, model };
					return { value: key(rung), label: named(rung) };
				})
		)
	);

	function move(index: number, by: -1 | 1): void {
		const next = [...ladder.rungs];
		const [rung] = next.splice(index, 1);
		next.splice(index + by, 0, rung!);
		void ladder.save(next);
	}

	function add(value: string): void {
		if (!value) return;
		void ladder.save([...ladder.rungs, JSON.parse(value) as ModelLadderRung]);
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
			<ol class="ladder-list">
				{#each ladder.rungs as rung, index (key(rung))}
					<li class="ladder-rung" data-rung={rung.model}>
						<span class="ladder-step" aria-hidden="true">{index + 1}</span>
						<span class="ladder-name" title={named(rung)}><span class="ladder-model">{rung.model}</span>{#if providers.length > 1}<span class="ladder-sep">{' · '}</span><span class="ladder-provider">{providerName(rung.provider_id)}</span>{/if}</span>
						{#if index === 0 && ladder.rungs.length > 1}
							<span class="ladder-end">{t.modelLadder.weaker}</span>
						{:else if index === ladder.rungs.length - 1 && ladder.rungs.length > 1}
							<span class="ladder-end">{t.modelLadder.stronger}</span>
						{/if}
						<span class="ladder-acts">
							<button type="button" class="ladder-button" aria-label={t.modelLadder.up(rung.model)} title={t.modelLadder.up(rung.model)} disabled={ladder.busy || index === 0} onclick={() => move(index, -1)}>↑</button>
							<button type="button" class="ladder-button" aria-label={t.modelLadder.down(rung.model)} title={t.modelLadder.down(rung.model)} disabled={ladder.busy || index === ladder.rungs.length - 1} onclick={() => move(index, 1)}>↓</button>
							<button type="button" class="ladder-button" aria-label={t.modelLadder.remove(rung.model)} title={t.modelLadder.remove(rung.model)} disabled={ladder.busy} onclick={() => void ladder.save(ladder.rungs.filter((_, at) => at !== index))}>×</button>
						</span>
					</li>
				{/each}
			</ol>
		{/if}
		{#if addable.length > 0 && ladder.rungs.length < MODEL_LADDER_MAX}
			<div class="ladder-add">
				<Select value="" options={addable} placeholder={t.modelLadder.add} size="sm" ariaLabel={t.modelLadder.add} disabled={ladder.busy} onchange={add} />
			</div>
		{/if}
	</section>
{/if}

<style>
	.ladder-card {
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

	.ladder-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.ladder-rung {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		padding: 6px 8px 6px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
	}

	.ladder-step {
		flex: none;
		min-width: 18px;
		font-size: 11px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--muted);
	}

	.ladder-name {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 12px;
		color: var(--ink);
	}

	.ladder-end {
		flex: none;
		font-size: 11px;
		color: var(--muted);
	}

	.ladder-acts {
		flex: none;
		display: inline-flex;
		gap: 4px;
	}

	.ladder-button {
		width: 26px;
		height: 26px;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--ink-secondary);
		font-size: 13px;
		line-height: 1;
		cursor: pointer;
	}

	.ladder-button:hover:not(:disabled) {
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.ladder-button:disabled {
		cursor: default;
		opacity: 0.4;
	}

	.ladder-add {
		max-width: 320px;
	}

	/* On a phone the endpoint goes under the model, and the buttons are big enough to tap. */
	@media (max-width: 720px) {
		.ladder-card {
			padding: 12px;
			box-shadow: none;
		}

		/* Weaker / stronger sits under the step number, so the model's name has the row. */
		.ladder-rung {
			display: grid;
			grid-template-columns: 22px minmax(0, 1fr) auto;
			grid-template-rows: auto auto;
			align-items: center;
			column-gap: 8px;
			row-gap: 0;
			padding: 8px 8px 8px 10px;
		}

		.ladder-step {
			grid-column: 1;
			grid-row: 1;
			align-self: end;
		}

		.ladder-end {
			grid-column: 1;
			grid-row: 2;
			align-self: start;
		}

		.ladder-name {
			grid-column: 2;
			grid-row: 1 / span 2;
			display: flex;
			flex-direction: column;
			gap: 2px;
			white-space: normal;
		}

		.ladder-acts {
			grid-column: 3;
			grid-row: 1 / span 2;
		}

		/* A long model id wraps rather than losing its end, which is often what tells two apart. */
		.ladder-model {
			font-size: 13px;
			overflow-wrap: anywhere;
		}

		.ladder-provider {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.ladder-sep {
			display: none;
		}

		.ladder-provider {
			font-family: var(--font);
			font-size: 12px;
			color: var(--muted);
		}

		.ladder-acts {
			gap: 4px;
		}

		.ladder-button {
			width: 36px;
			height: 36px;
			font-size: 15px;
		}

		.ladder-add {
			max-width: none;
		}
	}
</style>
