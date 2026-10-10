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
	import { claudeAgentSource, endpointModelOptions } from '../model-source.ts';
	import type { SelectOption } from '../select-options.ts';

	/**
	 * The picker of one built-in call's model (ADR 0077): reading lines (ADR 0055), organizing the
	 * board (ADR 0075) and the rest are all this card. Any model an endpoint lists, or the default
	 * model; and, when `claude` is given, a Claude model run through your own Claude Code (ADR 0061).
	 * The page that holds the card says what the call is for.
	 */
	interface Props {
		/** Which setting this is; the section's own hook for tests and styles. */
		kind: string;
		providers: readonly Provider[];
		/** The model chosen; null follows the default. */
		chosen: ReaderModel | null;
		/** The default endpoint's default model, named on the option that follows it. */
		defaultModel: string | null;
		patch: (patch: SettingsPatch) => Promise<unknown | null>;
		/** The patch that saves a choice (null follows the default again). */
		toPatch: (next: ReaderModel | null) => SettingsPatch;
		/** What the picker is called. */
		title: string;
		/** The option that follows the default model. */
		followDefault: (model: string | null) => string;
		/** Said when a choice was not saved. */
		failed: string;
		/**
		 * Offers the Claude models of your Claude Code: what the daemon finds of it (absent or failing,
		 * as on the phone, no Claude group is offered) and the note said under the picker beside it.
		 * Absent, the setting takes endpoint models only.
		 */
		claude?: { status: (() => Promise<ClaudeCodeStatus>) | null; note: string } | null;
		/** False drops the card's own chrome, for a picker that sits as a row inside another card. */
		framed?: boolean;
		t: Copy;
	}

	let { kind, providers, chosen, defaultModel, patch, toPatch, title, followDefault, failed: failedText, claude = null, framed = true, t }: Props = $props();

	let busy = $state(false);
	let failed = $state(false);
	let claudeStatus = $state<ClaudeCodeStatus | null>(null);
	/** The account a Claude model is picked on: the one already chosen, else the computer's default (''). */
	let pickedAccount = $state('');

	onMount(() => {
		void claude?.status?.().then(
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

	/** The Claude models Claude Code resolves itself, the fastest first: a reading holds up your line. */
	const claudeModels = $derived.by(() => {
		const aliases: string[] = ['haiku', ...CLAUDE_MODEL_ALIASES.filter((alias) => alias !== 'haiku')];
		return isReaderClaudeModel(chosen) && !aliases.includes(chosen.model) ? [...aliases, chosen.model] : aliases;
	});
	/** Offered once Claude Code is there and signed in, and kept while one of its models is what reads. */
	const claudeOffered = $derived(claude !== null && (claudeReady(claudeStatus) || isReaderClaudeModel(chosen)));
	const accountOptions = $derived(claudeAccountOptions(claudeStatus, pickedAccount, t));
	const claudeChosen = $derived(isReaderClaudeModel(chosen) ? chosen : null);

	const options = $derived<SelectOption[]>([
		{ value: FOLLOW, label: followDefault(defaultModel) },
		...endpointModelOptions(providers, t, (provider_id, model) => key({ provider_id, model })),
		...(claudeOffered
			? claudeModels.map((model) => ({
					value: key({ runner: 'claude_code', model, config_dir: null }),
					label: model,
					hint: t.claudeAgent.title,
					group: t.sidebar.botRunnerClaude,
					source: claudeAgentSource(t)
				}))
			: [])
	]);

	async function save(next: ReaderModel | null): Promise<void> {
		if (busy) return;
		busy = true;
		failed = false;
		try {
			const error = await patch(toPatch(next));
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

<section class="side-model-card" class:is-framed={framed} aria-label={title} data-side-model={kind}>
	{#if failed}
		<p class="side-model-error" role="alert">{failedText}</p>
	{/if}
	<div class="side-model-pick">
		<Select value={chosen ? key(chosen) : FOLLOW} {options} size="sm" ariaLabel={title} disabled={busy} onchange={(value) => void choose(value)} />
	</div>
	<!-- Only where a Claude model is chosen: nine rows of the same account picker say nothing. -->
	{#if claudeChosen}
		{#if (claudeStatus?.accounts?.length ?? 0) > 1}
			<div class="side-model-account" data-side-model-account>
				<span class="side-model-account-label">{t.sidebar.botAgentAccount}</span>
				<Select value={pickedAccount} options={accountOptions} size="sm" ariaLabel={t.sidebar.botAgentAccount} disabled={busy} onchange={(value) => void chooseAccount(value)} />
			</div>
		{/if}
		<p class="side-model-note" data-side-model-claude-note>{claude?.note}</p>
	{/if}
</section>

<style>
	.side-model-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
	}

	.side-model-card.is-framed {
		padding: 12px 14px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-xs);
	}

	.side-model-error {
		margin: 0;
		font-size: 12px;
		color: var(--danger-text);
	}

	.side-model-pick,
	.side-model-account {
		max-width: 320px;
	}

	.side-model-account {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	@media (max-width: 720px) {
		.side-model-card.is-framed {
			padding: 12px;
			box-shadow: none;
		}

		.side-model-pick,
		.side-model-account {
			max-width: none;
		}
	}

	.side-model-account-label,
	.side-model-note {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}
</style>
