<script lang="ts">
	import { onMount } from 'svelte';
	import {
		CLAUDE_MODEL_ALIASES,
		isReaderAgentModel,
		isReaderClaudeModel,
		type AgentsStatusResponse,
		type BotRunner,
		type ClaudeCodeStatus,
		type Provider,
		type ReaderAgentModel,
		type ReaderModel,
		type SettingsPatch
	} from '@real-bot/protocol';
	import Select from '../Select.svelte';
	import type { Copy } from '../copy.ts';
	import { claudeAccountOptions, claudeReady } from './claude-agent.ts';
	import { agentSource, claudeAgentSource, endpointModelOptions } from '../model-source.ts';
	import { agentAccountOptions, agentAccountsOf, agentLabelOf, agentModelsOf, agentReady, agentStatusOf } from '../runner-choice.ts';
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
		/**
		 * Offers the models of your other local agents (ADR 0079) found on this computer and signed in,
		 * each agent its own group: what the daemon finds of them. Absent or failing, none are offered,
		 * and the one already chosen stays shown.
		 */
		agents?: (() => Promise<AgentsStatusResponse>) | null;
		/** False drops the card's own chrome, for a picker that sits as a row inside another card. */
		framed?: boolean;
		t: Copy;
	}

	let { kind, providers, chosen, defaultModel, patch, toPatch, title, followDefault, failed: failedText, claude = null, agents = null, framed = true, t }: Props = $props();

	let busy = $state(false);
	let failed = $state(false);
	let claudeStatus = $state<ClaudeCodeStatus | null>(null);
	let agentsFound = $state<AgentsStatusResponse | null>(null);
	/** The account a Claude model is picked on: the one already chosen, else the computer's default (''). */
	let pickedAccount = $state('');

	onMount(() => {
		void claude?.status?.().then(
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
	$effect(() => {
		if (isReaderAgentModel(chosen)) pickedAccount = chosen.config_dir ?? '';
	});

	const FOLLOW = '';
	const key = (row: ReaderModel) =>
		JSON.stringify(
			isReaderAgentModel(row)
				? { runner: row.runner, model: row.model, ...(row.custom_id ? { custom_id: row.custom_id } : {}) }
				: { provider_id: row.provider_id, model: row.model }
		);
	const sameAgent = (row: ReaderAgentModel, runner: BotRunner, customId: string | null) => row.runner === runner && (row.custom_id ?? null) === customId;

	/** The Claude models Claude Code resolves itself, the fastest first: a reading holds up your line. */
	const claudeModels = $derived.by(() => {
		const aliases: string[] = ['haiku', ...CLAUDE_MODEL_ALIASES.filter((alias) => alias !== 'haiku')];
		return isReaderClaudeModel(chosen) && !aliases.includes(chosen.model) ? [...aliases, chosen.model] : aliases;
	});
	/** The agent whose model is chosen, whichever it is; Claude's is told apart where only it behaves differently. */
	const chosenAgent = $derived(isReaderAgentModel(chosen) ? chosen : null);
	const claudeChosen = $derived(isReaderClaudeModel(chosen) ? chosen : null);
	/** Offered once Claude Code is there and signed in, and kept while one of its models is what reads. */
	const claudeOffered = $derived(claude !== null && (claudeReady(claudeStatus) || claudeChosen !== null));
	/** The other agents' models, a group each: those found and signed in, and the one chosen even when it is neither (the phone cannot ask). */
	const agentGroups = $derived.by(() => {
		const groups: Array<{ runner: BotRunner; customId: string | null; label: string; models: string[] }> = [];
		const other = chosenAgent && chosenAgent.runner !== 'claude_code' ? chosenAgent : null;
		for (const status of agentsFound?.items ?? []) {
			if (status.runner === 'claude_code') continue;
			const customId = status.custom_id ?? null;
			const isChosen = other !== null && sameAgent(other, status.runner, customId);
			if (!agentReady(status) && !isChosen) continue;
			const models = agentModelsOf(status).map((model) => model.id);
			if (other && isChosen && !models.includes(other.model)) models.push(other.model);
			if (models.length > 0) groups.push({ runner: status.runner, customId, label: status.label, models });
		}
		if (other && !groups.some((group) => sameAgent(other, group.runner, group.customId))) {
			groups.push({ runner: other.runner, customId: other.custom_id ?? null, label: agentLabelOf(other.runner, other.custom_id ?? null, agentsFound), models: [other.model] });
		}
		return groups;
	});
	/** The account picker's choices on the chosen agent, and how many accounts it has. */
	const chosenAccounts = $derived.by(() => {
		if (!chosenAgent) return { count: 0, options: [] as Array<{ value: string; label: string }> };
		if (chosenAgent.runner === 'claude_code') {
			return { count: claudeStatus?.accounts?.length ?? 0, options: claudeAccountOptions(claudeStatus, pickedAccount, t) };
		}
		const status = agentStatusOf(agentsFound, chosenAgent.runner, chosenAgent.custom_id ?? null);
		return { count: agentAccountsOf(status).length, options: agentAccountOptions(status, pickedAccount, t) };
	});
	const chosenLabel = $derived(chosenAgent && chosenAgent.runner !== 'claude_code' ? agentLabelOf(chosenAgent.runner, chosenAgent.custom_id ?? null, agentsFound) : '');

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
			: []),
		...agentGroups.flatMap((group) =>
			group.models.map((model) => ({
				value: key({ runner: group.runner, model, config_dir: null, custom_id: group.customId }),
				label: model,
				group: group.label,
				source: agentSource(group.runner, group.label)
			}))
		)
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
		const row = JSON.parse(value) as { provider_id?: string; runner?: BotRunner; model: string; custom_id?: string };
		if (row.runner) {
			const customId = row.custom_id ?? null;
			// The account carries over to another model of the same agent; a different agent starts on this computer's default.
			const account = chosenAgent && sameAgent(chosenAgent, row.runner, customId) ? pickedAccount : '';
			return save({ runner: row.runner, model: row.model, config_dir: account || null, ...(customId ? { custom_id: customId } : {}) });
		}
		return save({ provider_id: row.provider_id!, model: row.model });
	}

	function chooseAccount(value: string): Promise<void> {
		pickedAccount = value;
		return chosenAgent ? save({ ...chosenAgent, config_dir: value || null }) : Promise.resolve();
	}
</script>

<section class="side-model-card" class:is-framed={framed} aria-label={title} data-side-model={kind}>
	{#if failed}
		<p class="side-model-error" role="alert">{failedText}</p>
	{/if}
	<div class="side-model-pick">
		<Select value={chosen ? key(chosen) : FOLLOW} {options} size="sm" ariaLabel={title} disabled={busy} onchange={(value) => void choose(value)} />
	</div>
	<!-- Only where an agent's model is chosen: nine rows of the same account picker say nothing. -->
	{#if chosenAgent}
		{@const accountLabel = claudeChosen ? t.sidebar.botAgentAccount : t.sidebar.botAgentAccountOf(chosenLabel)}
		{#if chosenAccounts.count > 1}
			<div class="side-model-account" data-side-model-account>
				<span class="side-model-account-label">{accountLabel}</span>
				<Select value={pickedAccount} options={chosenAccounts.options} size="sm" ariaLabel={accountLabel} disabled={busy} onchange={(value) => void chooseAccount(value)} />
			</div>
		{/if}
		{#if claudeChosen}
			<p class="side-model-note" data-side-model-claude-note>{claude?.note}</p>
		{:else}
			<p class="side-model-note" data-side-model-agent-note>{t.builtinModels.agentNote(chosenLabel)}</p>
		{/if}
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
