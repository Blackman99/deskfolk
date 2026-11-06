<script lang="ts">
	import { untrack } from 'svelte';
	import { isBotRunner, type Bot, type PatchBotRequest } from '@real-bot/protocol';
	import { loadClaudeModels } from '../claude-models.svelte.ts';
	import type { Copy } from '../copy.ts';
	import { endpointSource } from '../model-source.ts';
	import { agentLabelOf, agentStatusOf } from '../runner-choice.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import AgentTune from './AgentTune.svelte';
	import TunePicker from './TunePicker.svelte';
	import { agentBotPatch, agentTuneModels, endpointTuneLabels, endpointTuneTree } from './bot-tune.ts';
	import { accountChoices, agentsStatus, claudeStatus, loadAgentsStatus, loadClaudeStatus } from './project-agent-options.svelte.ts';

	/**
	 * A Bot's model and thinking level, picked in its direct's composer as a project session's are
	 * (`bot-tune.ts`). They are the Bot's own, the ones its profile sets: a pick holds wherever it
	 * works. On the app's own loop the picker goes endpoint, model, level; on a local agent it is the
	 * agent's picker (`AgentTune.svelte`), with your Claude accounts when there is a second one.
	 */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		bot: Bot;
		disabled: boolean;
		onpick: (change: PatchBotRequest) => void;
	};

	let { runtime, t, bot, disabled, onpick }: Props = $props();

	const runner = $derived(bot.runner && isBotRunner(bot.runner) ? bot.runner : null);
	const customId = $derived(bot.agent_custom_id ?? null);
	const account = $derived(bot.agent_config_dir ?? '');

	// Asked once each a page; untracked, so what the asking writes does not ask again.
	$effect(() => {
		const api = runtime.client;
		const on = runner;
		const dir = account || null;
		untrack(() => {
			if (on === 'claude_code') {
				loadClaudeStatus(api);
				loadClaudeModels(api, dir);
			} else if (on) {
				loadAgentsStatus(api);
			}
		});
	});

	const accountOptions = $derived(accountChoices(claudeStatus(), account, t.project.defaultAccount));
	/** Picked only with a second account to pick, and never from a daemon that has no accounts for a Bot. */
	const accountShown = $derived(runner === 'claude_code' && bot.agent_config_dir !== undefined && accountOptions.length > 1);
	const agentName = $derived(runner === 'claude_code' ? t.project.agentNames.claude_code : runner ? agentLabelOf(runner, customId, agentsStatus()) : '');
	/** Any agent but Claude: the models it lists, each with the levels it takes. */
	const agentModels = $derived(
		runner && runner !== 'claude_code' ? agentTuneModels(agentStatusOf(agentsStatus(), runner, customId), runner, bot.agent_model ?? '', t.project.modelDefault) : undefined
	);

	const providers = $derived(runtime.snapshot.providers);
	const tree = endpointTuneTree({
		get t() {
			return t;
		},
		get bot() {
			return bot;
		},
		get providers() {
			return providers;
		},
		onpick: (change) => onpick(change)
	});
	const shown = $derived(endpointTuneLabels(t, bot, providers));
</script>

{#if runner}
	<AgentTune
		{t}
		agent={runner}
		{agentName}
		tune={{ account, model: bot.agent_model ?? '', effort: bot.agent_effort ?? '' }}
		models={agentModels}
		accounts={accountShown ? accountOptions : null}
		accountLocked={false}
		{disabled}
		client={runtime.client}
		onpick={(change) => onpick(agentBotPatch(change))}
		data-bot-tune=""
	/>
{:else}
	<TunePicker
		{t}
		{tree}
		label={t.composer.tuneLabel}
		mark={shown.endpoint ? endpointSource(shown.endpoint, t) : null}
		value={shown.value}
		level={shown.level}
		aside={shown.aside}
		title={shown.title}
		sheetTitle={bot.name}
		{disabled}
		data-bot-tune=""
	/>
{/if}
