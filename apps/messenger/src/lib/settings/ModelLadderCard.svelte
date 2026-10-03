<script lang="ts">
	import { MODEL_LADDER_MAX, type ModelLadderResponse, type ModelLadderRung, type Provider } from '@real-bot/protocol';
	import Select from '../Select.svelte';
	import type { Copy } from '../copy.ts';

	/** The slice of the API this card uses (ADR 0054). */
	export type ModelLadderApi = {
		modelLadder: () => Promise<ModelLadderResponse>;
		setModelLadder: (items: ModelLadderRung[]) => Promise<ModelLadderResponse>;
	};

	interface Props {
		api: ModelLadderApi | null;
		providers: readonly Provider[];
		t: Copy;
	}

	let { api, providers, t }: Props = $props();

	let rungs = $state<ModelLadderRung[]>([]);
	let available = $state(false);
	let busy = $state(false);
	let failed = $state(false);

	async function load(): Promise<void> {
		if (!api) return;
		try {
			const page = await api.modelLadder();
			rungs = page.items;
			available = page.available;
		} catch {
			available = false;
		}
	}

	// Again when the endpoints change: a rung whose model is no longer listed is gone from it.
	$effect(() => {
		void providers.map((provider) => `${provider.id}:${provider.models.join(',')}`).join('|');
		void load();
	});

	const key = (rung: ModelLadderRung) => JSON.stringify({ provider_id: rung.provider_id, model: rung.model });
	const providerName = (id: string) => providers.find((provider) => provider.id === id)?.name ?? id;
	const named = (rung: ModelLadderRung) => (providers.length > 1 ? `${rung.model} · ${providerName(rung.provider_id)}` : rung.model);

	const addable = $derived(
		providers.flatMap((provider) =>
			provider.models
				.filter((model) => !rungs.some((rung) => rung.provider_id === provider.id && rung.model === model))
				.map((model) => {
					const rung = { provider_id: provider.id, model };
					return { value: key(rung), label: named(rung) };
				})
		)
	);

	async function save(next: ModelLadderRung[]): Promise<void> {
		if (!api || busy) return;
		const before = rungs;
		rungs = next;
		busy = true;
		failed = false;
		try {
			rungs = (await api.setModelLadder(next)).items;
		} catch {
			rungs = before;
			failed = true;
		} finally {
			busy = false;
		}
	}

	function move(index: number, by: -1 | 1): void {
		const next = [...rungs];
		const [rung] = next.splice(index, 1);
		next.splice(index + by, 0, rung!);
		void save(next);
	}

	function add(value: string): void {
		if (!value) return;
		void save([...rungs, JSON.parse(value) as ModelLadderRung]);
	}
</script>

{#if available}
	<section class="ladder-card" aria-label={t.modelLadder.title} data-model-ladder>
		<div class="ladder-head">
			<h3>{t.modelLadder.title}</h3>
			<p>{t.modelLadder.hint}</p>
		</div>
		{#if failed}
			<p class="ladder-error" role="alert">{t.modelLadder.failed}</p>
		{/if}
		{#if rungs.length === 0}
			<p class="ladder-empty">{t.modelLadder.empty}</p>
		{:else}
			<ol class="ladder-list">
				{#each rungs as rung, index (key(rung))}
					<li class="ladder-rung" data-rung={rung.model}>
						<span class="ladder-step" aria-hidden="true">{index + 1}</span>
						<span class="ladder-name" title={named(rung)}>{named(rung)}</span>
						{#if index === 0 && rungs.length > 1}
							<span class="ladder-end">{t.modelLadder.weaker}</span>
						{:else if index === rungs.length - 1 && rungs.length > 1}
							<span class="ladder-end">{t.modelLadder.stronger}</span>
						{/if}
						<span class="ladder-acts">
							<button type="button" class="ladder-button" aria-label={t.modelLadder.up(rung.model)} title={t.modelLadder.up(rung.model)} disabled={busy || index === 0} onclick={() => move(index, -1)}>↑</button>
							<button type="button" class="ladder-button" aria-label={t.modelLadder.down(rung.model)} title={t.modelLadder.down(rung.model)} disabled={busy || index === rungs.length - 1} onclick={() => move(index, 1)}>↓</button>
							<button type="button" class="ladder-button" aria-label={t.modelLadder.remove(rung.model)} title={t.modelLadder.remove(rung.model)} disabled={busy} onclick={() => void save(rungs.filter((_, at) => at !== index))}>×</button>
						</span>
					</li>
				{/each}
			</ol>
		{/if}
		{#if addable.length > 0 && rungs.length < MODEL_LADDER_MAX}
			<div class="ladder-add">
				<Select value="" options={addable} placeholder={t.modelLadder.add} size="sm" ariaLabel={t.modelLadder.add} disabled={busy} onchange={add} />
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

	.ladder-head h3 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
	}

	.ladder-head p,
	.ladder-empty {
		margin: 4px 0 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.ladder-empty {
		margin: 0;
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
</style>
