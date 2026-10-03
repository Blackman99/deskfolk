<script lang="ts">
	import type { Provider, ReaderModel, SettingsPatch } from '@real-bot/protocol';
	import Select from '../Select.svelte';
	import type { Copy } from '../copy.ts';

	/**
	 * Which model reads each line for what the app acts on (读句, ADR 0055): any model an endpoint
	 * lists, or the default model. Your line waits on the reading, so this is where a fast one goes.
	 */
	interface Props {
		providers: readonly Provider[];
		/** The model chosen for reading; null follows the default. */
		chosen: ReaderModel | null;
		/** The default endpoint's default model, named on the option that follows it. */
		defaultModel: string | null;
		patch: (patch: SettingsPatch) => Promise<unknown | null>;
		t: Copy;
	}

	let { providers, chosen, defaultModel, patch, t }: Props = $props();

	let busy = $state(false);
	let failed = $state(false);

	const FOLLOW = '';
	const key = (row: ReaderModel) => JSON.stringify({ provider_id: row.provider_id, model: row.model });
	const providerName = (id: string) => providers.find((provider) => provider.id === id)?.name ?? id;
	const named = (row: ReaderModel) => (providers.length > 1 ? `${row.model} · ${providerName(row.provider_id)}` : row.model);

	const options = $derived([
		{ value: FOLLOW, label: t.readerModel.followDefault(defaultModel) },
		...providers.flatMap((provider) =>
			provider.models.map((model) => {
				const row = { provider_id: provider.id, model };
				return { value: key(row), label: named(row) };
			})
		)
	]);

	async function choose(value: string): Promise<void> {
		if (busy) return;
		busy = true;
		failed = false;
		try {
			const error = await patch({ reader_model: value === FOLLOW ? null : (JSON.parse(value) as ReaderModel) });
			failed = error !== null;
		} finally {
			busy = false;
		}
	}
</script>

<section class="reader-card" aria-label={t.readerModel.title} data-reader-model>
	<div class="reader-head">
		<h3>{t.readerModel.title}</h3>
		<p>{t.readerModel.hint}</p>
	</div>
	{#if failed}
		<p class="reader-error" role="alert">{t.readerModel.failed}</p>
	{/if}
	<div class="reader-pick">
		<Select value={chosen ? key(chosen) : FOLLOW} {options} size="sm" ariaLabel={t.readerModel.title} disabled={busy} onchange={(value) => void choose(value)} />
	</div>
</section>

<style>
	.reader-card {
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

	.reader-head h3 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
	}

	.reader-head p {
		margin: 4px 0 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.reader-error {
		margin: 0;
		font-size: 12px;
		color: var(--danger-text);
	}

	.reader-pick {
		max-width: 320px;
	}
</style>
