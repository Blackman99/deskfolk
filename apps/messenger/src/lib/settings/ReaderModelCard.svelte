<script lang="ts">
	import { onMount } from 'svelte';
	import {
		CLAUDE_MODEL_ALIASES,
		isReaderClaudeModel,
		type ClaudeCodeStatus,
		type Provider,
		type ReaderModel,
		type SettingsPatch
	} from '@real-bot/protocol';
	import Select from '../Select.svelte';
	import type { Copy } from '../copy.ts';
	import { claudeAccountOptions, claudeReady } from './claude-agent.ts';

	/**
	 * Which model reads each line for what the app acts on (读句, ADR 0055): any model an endpoint
	 * lists, a Claude model run through your own Claude Code (ADR 0061), or the default model. Your
	 * line waits on the reading, so this is where a fast one goes. The card is that setting's own
	 * page, whose intro says so.
	 */
	interface Props {
		providers: readonly Provider[];
		/** The model chosen for reading; null follows the default. */
		chosen: ReaderModel | null;
		/** The default endpoint's default model, named on the option that follows it. */
		defaultModel: string | null;
		patch: (patch: SettingsPatch) => Promise<unknown | null>;
		/** What the daemon finds of your Claude Code; absent or failing (the phone cannot ask), no Claude group is offered. */
		claudeCode?: (() => Promise<ClaudeCodeStatus>) | null;
		t: Copy;
	}

	let { providers, chosen, defaultModel, patch, claudeCode = null, t }: Props = $props();

	let busy = $state(false);
	let failed = $state(false);
	let claudeStatus = $state<ClaudeCodeStatus | null>(null);
	/** The account a Claude model is picked on: the one already chosen, else the computer's default (''). */
	let pickedAccount = $state('');

	onMount(() => {
		void claudeCode?.().then(
			(status) => (claudeStatus = status),
			() => (claudeStatus = null)
		);
	});
	$effect(() => {
		if (isReaderClaudeModel(chosen)) pickedAccount = chosen.config_dir ?? '';
	});

	const FOLLOW = '';
	const key = (row: ReaderModel) =>
		JSON.stringify(
			isReaderClaudeModel(row)
				? { runner: row.runner, model: row.model }
				: { provider_id: row.provider_id, model: row.model }
		);
	const providerName = (id: string) => providers.find((provider) => provider.id === id)?.name ?? id;
	const named = (row: { provider_id: string; model: string }) =>
		providers.length > 1 ? `${row.model} · ${providerName(row.provider_id)}` : row.model;

	/** The Claude models Claude Code resolves itself, the fastest first: a reading holds up your line. */
	const claudeModels = $derived.by(() => {
		const aliases: string[] = ['haiku', ...CLAUDE_MODEL_ALIASES.filter((alias) => alias !== 'haiku')];
		return isReaderClaudeModel(chosen) && !aliases.includes(chosen.model) ? [...aliases, chosen.model] : aliases;
	});
	/** Offered once Claude Code is there and signed in, and kept while one of its models is what reads. */
	const claudeOffered = $derived(claudeReady(claudeStatus) || isReaderClaudeModel(chosen));
	const accountOptions = $derived(claudeAccountOptions(claudeStatus, pickedAccount, t));
	const claudeChosen = $derived(isReaderClaudeModel(chosen) ? chosen : null);

	const options = $derived([
		{ value: FOLLOW, label: t.readerModel.followDefault(defaultModel), group: undefined as string | undefined },
		...providers.flatMap((provider) =>
			provider.models.map((model) => {
				const row = { provider_id: provider.id, model };
				return { value: key(row), label: named(row), group: undefined as string | undefined };
			})
		),
		...(claudeOffered
			? claudeModels.map((model) => ({
					value: key({ runner: 'claude_code', model, config_dir: null }),
					label: t.readerModel.claudeModel(model),
					group: t.sidebar.botRunnerClaude as string | undefined
				}))
			: [])
	]);

	async function save(next: ReaderModel | null): Promise<void> {
		if (busy) return;
		busy = true;
		failed = false;
		try {
			const error = await patch({ reader_model: next });
			failed = error !== null;
		} finally {
			busy = false;
		}
	}

	function choose(value: string): Promise<void> {
		if (value === FOLLOW) return save(null);
		const row = JSON.parse(value) as { provider_id?: string; runner?: 'claude_code'; model: string };
		if (row.runner === 'claude_code') {
			return save({ runner: 'claude_code', model: row.model, config_dir: pickedAccount || null });
		}
		return save({ provider_id: row.provider_id!, model: row.model });
	}

	function chooseAccount(value: string): Promise<void> {
		pickedAccount = value;
		return claudeChosen ? save({ ...claudeChosen, config_dir: value || null }) : Promise.resolve();
	}
</script>

<section class="reader-card" aria-label={t.readerModel.title} data-reader-model>
	{#if failed}
		<p class="reader-error" role="alert">{t.readerModel.failed}</p>
	{/if}
	<div class="reader-pick">
		<Select value={chosen ? key(chosen) : FOLLOW} {options} size="sm" ariaLabel={t.readerModel.title} disabled={busy} onchange={(value) => void choose(value)} />
	</div>
	{#if claudeOffered}
		{#if (claudeStatus?.accounts?.length ?? 0) > 1}
			<div class="reader-account" data-reader-account>
				<span class="reader-account-label">{t.sidebar.botAgentAccount}</span>
				<Select value={pickedAccount} options={accountOptions} size="sm" ariaLabel={t.sidebar.botAgentAccount} disabled={busy} onchange={(value) => void chooseAccount(value)} />
			</div>
		{/if}
		<p class="reader-note" data-reader-claude-note>{t.readerModel.claudeNote}</p>
	{/if}
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

	.reader-error {
		margin: 0;
		font-size: 12px;
		color: var(--danger-text);
	}

	.reader-pick,
	.reader-account {
		max-width: 320px;
	}

	.reader-account {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	@media (max-width: 720px) {
		.reader-card {
			padding: 12px;
			box-shadow: none;
		}

		.reader-pick,
		.reader-account {
			max-width: none;
		}
	}

	.reader-account-label,
	.reader-note {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}
</style>
