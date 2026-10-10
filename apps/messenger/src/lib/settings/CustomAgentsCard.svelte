<script lang="ts">
	import type { AgentsStatusResponse, CustomAgent } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { agentFailure, CUSTOM_AGENTS_MAX, parseArgs, renamed, type AgentFailure } from './agents.ts';
	import HelpTip from './HelpTip.svelte';

	/**
	 * Your own ACP agents (ADR 0079): any command that speaks the Agent Client Protocol on its
	 * standard input and output, named by you, run with the arguments you give (one per line). Each
	 * change sends the whole list, existing entries by their ids; the daemon answers with every
	 * agent's status again, and refuses (409) to drop one a Bot runs on.
	 */
	export type CustomAgentsApi = {
		setCustomAgents: (agents: Array<Omit<CustomAgent, 'id'> & { id?: string }>) => Promise<AgentsStatusResponse>;
	};

	interface Props {
		agents: CustomAgent[];
		api: CustomAgentsApi | null;
		t: Copy;
		/** Told the daemon's new answer: the statuses and the list as it kept it. */
		onChange?: (response: AgentsStatusResponse) => void;
	}

	let { agents, api, t, onChange }: Props = $props();

	let busy = $state(false);
	let failure = $state<AgentFailure | null>(null);
	let nameDraft = $state('');
	let commandDraft = $state('');
	let argsDraft = $state('');
	/** The agent whose name is being changed, and the name typed so far. */
	let renaming = $state<{ id: string; name: string } | null>(null);

	const full = $derived(agents.length >= CUSTOM_AGENTS_MAX);
	const addable = $derived(nameDraft.trim() !== '' && commandDraft.trim() !== '');

	/** Sends the whole list; true when the daemon kept it. */
	async function save(list: Array<Omit<CustomAgent, 'id'> & { id?: string }>): Promise<boolean> {
		if (!api || busy) return false;
		busy = true;
		failure = null;
		try {
			onChange?.(await api.setCustomAgents(list));
			return true;
		} catch (error) {
			failure = agentFailure(error);
			return false;
		} finally {
			busy = false;
		}
	}

	async function add(): Promise<void> {
		if (!addable) return;
		const saved = await save([...agents, { name: nameDraft.trim(), command: commandDraft.trim(), args: parseArgs(argsDraft) }]);
		if (!saved) return;
		nameDraft = '';
		commandDraft = '';
		argsDraft = '';
	}

	async function rename(): Promise<void> {
		if (!renaming || !renaming.name.trim()) return;
		const saved = await save(renamed(agents, renaming.id, renaming.name.trim()));
		if (saved) renaming = null;
	}
</script>

<section class="custom-card" aria-label={t.agents.custom.title} data-custom-agents>
	<div class="custom-head">
		<h3 class="custom-title">{t.agents.custom.title}<HelpTip text={t.agents.custom.hint} label={t.agents.custom.help} /></h3>
	</div>
	{#if agents.length === 0}
		<p class="custom-note" data-custom-empty>{t.agents.custom.empty}</p>
	{:else}
		<ul class="custom-list">
			{#each agents as agent (agent.id)}
				<li class="custom-agent" data-custom-agent={agent.id}>
					{#if renaming?.id === agent.id}
						<form class="custom-row" onsubmit={(event) => { event.preventDefault(); void rename(); }}>
							<input
								type="text"
								bind:value={renaming.name}
								aria-label={t.agents.custom.name}
								spellcheck="false"
								autocomplete="off"
								disabled={busy}
								data-custom-rename-input
							/>
							<button type="submit" class="btn-xs" disabled={busy || !renaming.name.trim()}>{t.agents.custom.save}</button>
							<button type="button" class="btn-xs" disabled={busy} onclick={() => (renaming = null)}>{t.agents.custom.cancel}</button>
						</form>
					{:else}
						<div class="custom-row">
							<span class="custom-name" data-custom-name>{agent.name}</span>
							<button type="button" class="btn-xs" disabled={busy} onclick={() => (renaming = { id: agent.id, name: agent.name })} data-custom-rename>{t.agents.custom.rename}</button>
							<button type="button" class="btn-xs" disabled={busy} onclick={() => void save(agents.filter((other) => other.id !== agent.id))} data-custom-remove>{t.agents.custom.remove}</button>
						</div>
					{/if}
					<code class="custom-command" data-custom-command>{[agent.command, ...agent.args].join(' ')}</code>
				</li>
			{/each}
		</ul>
	{/if}
	{#if failure}
		<p class="custom-error" role="alert" data-custom-error={failure.kind}>
			{failure.kind === 'in_use' ? t.agents.custom.inUse : failure.kind === 'invalid' ? t.agents.custom.invalid : t.agents.custom.failed}
			{#if failure.detail}<span class="custom-error-detail">{failure.detail}</span>{/if}
		</p>
	{/if}
	{#if full}
		<p class="custom-note" data-custom-full>{t.agents.custom.full(CUSTOM_AGENTS_MAX)}</p>
	{:else}
		<form class="custom-add" onsubmit={(event) => { event.preventDefault(); void add(); }} data-custom-add>
			<input
				type="text"
				bind:value={nameDraft}
				placeholder={t.agents.custom.namePlaceholder}
				aria-label={t.agents.custom.namePlaceholder}
				spellcheck="false"
				autocomplete="off"
				disabled={busy}
				data-custom-name-input
			/>
			<input
				type="text"
				bind:value={commandDraft}
				placeholder={t.agents.custom.commandPlaceholder}
				aria-label={t.agents.custom.commandPlaceholder}
				spellcheck="false"
				autocomplete="off"
				disabled={busy}
				data-custom-command-input
			/>
			<textarea
				bind:value={argsDraft}
				placeholder={t.agents.custom.argsPlaceholder}
				aria-label={t.agents.custom.argsPlaceholder}
				rows="3"
				spellcheck="false"
				autocomplete="off"
				disabled={busy}
				data-custom-args-input
			></textarea>
			<div class="custom-add-foot">
				<button type="submit" class="btn-xs" disabled={busy || !addable}>{t.agents.custom.add}</button>
			</div>
		</form>
	{/if}
</section>

<style>
	.custom-card {
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

	.custom-head h3 {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
	}

	.custom-note {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.custom-error {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--danger-text);
	}

	/* The daemon's own words under ours: they name the Bots that stand in the way. */
	.custom-error-detail {
		display: block;
		margin-top: 2px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	.custom-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* A block per agent: its name and what you can do with it, then the command it runs. */
	.custom-agent {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
		padding: 8px 10px 10px;
		border-radius: var(--radius-md);
		background: var(--line-subtle);
		font-size: 12px;
	}

	.custom-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.custom-name {
		flex: 1 1 auto;
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--ink);
		font: 600 13px/1.3 var(--font);
	}

	.custom-row input {
		flex: 1 1 auto;
		min-width: 0;
		font-size: 12px;
	}

	.custom-command {
		color: var(--muted);
		font-size: 11px;
		overflow-wrap: anywhere;
	}

	.custom-add {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 10px;
		border-top: 1px solid var(--line);
	}

	.custom-add input,
	.custom-add textarea {
		min-width: 0;
		font-size: 12px;
	}

	.custom-add textarea {
		resize: vertical;
		font-family: var(--mono);
	}

	.custom-add-foot {
		display: flex;
		justify-content: flex-end;
	}
</style>
