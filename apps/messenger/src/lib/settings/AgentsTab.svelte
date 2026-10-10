<script lang="ts">
	import { untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { AgentStatus, AgentsStatusResponse, Bot, BotRunner, ClaudeCodeStatus } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { agentCommand, agentKey, agentUnreachable } from './agents.ts';
	import AgentCard, { type AgentCardApi } from './AgentCard.svelte';
	import AgentLogo from './AgentLogo.svelte';
	import ClaudeAgentCard, { type ClaudeAgentApi } from './ClaudeAgentCard.svelte';
	import { claudeAccountLabel } from './claude-agent.ts';
	import CustomAgentsCard, { type CustomAgentsApi } from './CustomAgentsCard.svelte';

	/**
	 * Settings › Agents (ADR 0061, ADR 0079): every local agent as one line — its logo, whether it can
	 * run a Bot now, how it is signed in, how many models it lists and how many Bots it runs — the
	 * ones not installed folded away at the foot, then your own ACP agents. A line opens to that
	 * agent's details and settings (its path, its other accounts): in place on a wide window, one at
	 * a time, and as a page of its own on a phone, Back going to the list. Asked once when the tab
	 * opens, from this Mac or over the relay from a phone.
	 */
	export type AgentsTabApi = ClaudeAgentApi &
		AgentCardApi &
		CustomAgentsApi & {
			agents: (refresh?: boolean, wait?: boolean) => Promise<AgentsStatusResponse>;
		};

	interface Props {
		api: AgentsTabApi | null;
		t: Copy;
		locale?: 'zh' | 'en';
		/** The roster, to say how many Bots each agent runs. */
		bots?: readonly Bot[];
	}

	let { api, t, locale = 'zh', bots = [] }: Props = $props();

	const phone = new MediaQuery('(max-width: 720px)');

	let claude = $state<ClaudeCodeStatus | null>(null);
	let claudeUnreachable = $state(false);
	let list = $state<AgentsStatusResponse | null>(null);
	let loading = $state(false);
	let failed = $state(false);
	/** Not there: a phone paired with a Mac on a Deskfolk from before the relay carried it. */
	let unavailable = $state(false);
	let rechecking = $state(false);
	/** The line opened: `claude_code`, an agent's key, or `custom-agents` for your own ACP agents. */
	let opened = $state<string | null>(null);
	let missingShown = $state(false);

	/** The ask still out, so a check of all made while the first answer is coming waits for it, then asks again. */
	let inFlight: Promise<void> | null = null;

	async function loadAgents(client: AgentsTabApi, refresh = false): Promise<void> {
		if (inFlight) {
			if (!refresh) return inFlight;
			await inFlight;
		}
		inFlight = askAgents(client, refresh);
		try {
			await inFlight;
		} finally {
			inFlight = null;
		}
	}

	async function askAgents(client: AgentsTabApi, refresh: boolean): Promise<void> {
		loading = true;
		failed = false;
		try {
			list = await client.agents(refresh);
			unavailable = false;
		} catch (error) {
			if (agentUnreachable(error)) unavailable = true;
			else failed = true;
		} finally {
			loading = false;
		}
		// Shown as last seen, some looked at again behind it: their fresh answers when they come.
		if (list?.refreshing) void followUp(client);
	}

	/** Waiting on the looks the daemon has going, so the lines it showed from before catch up by themselves. */
	let catchingUp = $state(false);
	async function followUp(client: AgentsTabApi): Promise<void> {
		if (catchingUp) return;
		catchingUp = true;
		try {
			const fresh = await client.agents(false, true);
			list = { ...fresh, refreshing: false };
		} catch {
			// The lines stay as last seen; "Check all again" asks afresh.
		} finally {
			catchingUp = false;
		}
	}

	async function loadClaude(client: AgentsTabApi, refresh = false): Promise<void> {
		try {
			claude = await (refresh ? client.detectClaudeCode() : client.claudeCode());
			claudeUnreachable = false;
		} catch (error) {
			if ((error as { status?: number }).status === 404) claudeUnreachable = true;
		}
	}

	// Asks once per client; untracked, so an answer does not set off the next ask.
	$effect(() => {
		const client = api;
		if (!client) return;
		untrack(() => {
			void loadClaude(client);
			void loadAgents(client);
		});
	});

	async function recheckAll(): Promise<void> {
		if (!api || rechecking) return;
		rechecking = true;
		try {
			await Promise.all([loadClaude(api, true), loadAgents(api, true)]);
		} finally {
			rechecking = false;
		}
	}

	function changed(next: AgentStatus): void {
		if (!list) return;
		list = { ...list, items: list.items.map((item) => (agentKey(item) === agentKey(next) ? next : item)) };
	}

	type RowState = 'ready' | 'signin' | 'missing' | 'checking';
	type Row = { key: string; runner: BotRunner; label: string; state: RowState; summary: string; bots: number; agent: AgentStatus | null };

	function botsOn(runner: BotRunner, customId: string | null): number {
		return bots.filter((bot) => !bot.archived_at && (bot.runner ?? null) === runner && (runner !== 'custom' || bot.agent_custom_id === customId)).length;
	}

	const claudeRow = $derived.by((): Row => {
		const base = { key: 'claude_code', runner: 'claude_code' as const, label: t.claudeAgent.title, bots: botsOn('claude_code', null), agent: null };
		if (claudeUnreachable) return { ...base, state: 'checking', summary: t.agents.list.unreachable };
		if (!claude) return { ...base, state: 'checking', summary: t.agents.loading };
		if (!claude.path) return { ...base, state: 'missing', summary: t.agents.list.notFound('claude') };
		if (claude.logged_in === false) return { ...base, state: 'signin', summary: t.agents.list.signedOut(null) };
		return { ...base, state: 'ready', summary: [claudeAccountLabel(claude, t), claude.version].filter(Boolean).join(' · ') };
	});

	function agentRow(status: AgentStatus): Row {
		const customId = status.custom_id ?? null;
		const custom = customId ? (list?.custom_agents.find((entry) => entry.id === customId) ?? null) : null;
		const base = { key: customId ? `custom:${customId}` : status.runner, runner: status.runner, label: status.label, bots: botsOn(status.runner, customId), agent: status };
		if (!status.path) return { ...base, state: 'missing', summary: t.agents.list.notFound(agentCommand(status, custom)) };
		if (status.logged_in === false) return { ...base, state: 'signin', summary: t.agents.list.signedOut(status.login_command) };
		const providers = status.auth?.split(/,\s*/).filter(Boolean) ?? [];
		const signIn = status.logged_in !== true ? t.agents.list.signInLater
			: providers.length > 2 ? t.agents.list.signedInMany(providers[0]!, providers.length) : (status.auth ?? null);
		const models = status.models.length > 0 ? t.agents.list.models(status.models.length) : null;
		return { ...base, state: 'ready', summary: [signIn, models].filter(Boolean).join(' · ') || t.agents.signedIn(null) };
	}

	/** Still being asked keeps its place among the ready ones: Claude's line does not jump when it answers. */
	const ORDER: Record<RowState, number> = { ready: 0, checking: 0, signin: 1, missing: 2 };
	const rows = $derived([claudeRow, ...(list?.items ?? []).map(agentRow)].sort((a, b) => ORDER[a.state] - ORDER[b.state]));
	/** Found or to sign in: the agents there are to use. The rest wait folded at the foot. */
	const shownRows = $derived(rows.filter((row) => row.state !== 'missing'));
	const missingRows = $derived(rows.filter((row) => row.state === 'missing'));
	const customRow = $derived<Row | null>(list
		? { key: 'custom-agents', runner: 'custom', label: t.agents.list.customRow, state: 'ready', summary: t.agents.list.customSummary(list.custom_agents.length), bots: 0, agent: null }
		: null);
	const openRow = $derived([...rows, ...(customRow ? [customRow] : [])].find((row) => row.key === opened) ?? null);

	function toggle(row: Row): void {
		opened = opened === row.key ? null : row.key;
	}

	/** The open agent's name for the page head on a phone; null on the list, and on a wide window. */
	export function sectionTitle(): string | null {
		return phone.current && openRow ? openRow.label : null;
	}

	/** Back on a phone from an agent's page goes to the list. */
	export function backFromSection(): boolean {
		if (!phone.current || !opened) return false;
		opened = null;
		return true;
	}
</script>

{#snippet detail(row: Row)}
	{#if row.key === 'claude_code'}
		<ClaudeAgentCard {api} {t} {locale} embedded onstatus={(status) => (claude = status)} />
	{:else if row.key === 'custom-agents' && list}
		<CustomAgentsCard agents={list.custom_agents} {api} {t} embedded onChange={(response) => (list = response)} />
	{:else if row.agent}
		<AgentCard status={row.agent} {api} {t} embedded custom={row.agent.custom_id ? (list?.custom_agents.find((agent) => agent.id === row.agent!.custom_id) ?? null) : null} onChange={changed} />
	{/if}
{/snippet}

{#snippet line(row: Row, withState: boolean)}
	{@const open = opened === row.key}
	<li class="agent-row" class:is-open={open && !phone.current} data-agent-row={row.key} data-agent-state={row.state}>
		<button type="button" class="agent-row-head" aria-expanded={phone.current ? undefined : open} onclick={() => toggle(row)}>
			<AgentLogo runner={row.runner} size={28} />
			<span class="agent-row-text">
				<span class="agent-row-name">{row.label}</span>
				<span class="agent-row-summary">{row.summary}</span>
			</span>
			{#if row.bots > 0}
				<span class="agent-row-bots" data-agent-row-bots>{t.agents.list.bots(row.bots)}</span>
			{/if}
			{#if withState}
				<span class="agent-row-state is-{row.state}"><span class="agent-row-dot" aria-hidden="true"></span>{t.agents.list.state[row.state]}</span>
			{/if}
			<svg class="agent-row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				{#if phone.current}<polyline points="9 18 15 12 9 6"></polyline>{:else}<polyline points="6 9 12 15 18 9"></polyline>{/if}
			</svg>
		</button>
		{#if open && !phone.current}
			<div class="agent-row-body">{@render detail(row)}</div>
		{/if}
	</li>
{/snippet}

{#if api}
	<div class="agents-tab" data-agents-tab>
		{#if phone.current && openRow}
			<div class="agents-page" data-agents-page={openRow.key}>
				<div class="agents-page-head">
					<AgentLogo runner={openRow.runner} size={32} />
					<span class="agent-row-text">
						<span class="agent-row-name">{openRow.label}</span>
						<span class="agent-row-summary">{openRow.summary}</span>
					</span>
				</div>
				{@render detail(openRow)}
			</div>
		{:else}
			<div class="agents-top">
				<p class="agents-intro">{t.agents.list.intro}</p>
				<button type="button" class="btn-xs" disabled={rechecking || catchingUp} onclick={() => void recheckAll()} data-agents-recheck-all>{rechecking || catchingUp ? t.agents.checking : t.agents.list.recheckAll}</button>
			</div>
			<ul class="agents-list" aria-label={t.settings.tabAgents}>
				{#each shownRows as row (row.key)}
					{@render line(row, true)}
				{/each}
				{#if customRow}
					{@render line(customRow, false)}
				{/if}
			</ul>
			{#if unavailable}
				<p class="agents-note" data-agents-unreachable>{t.agents.unreachable}</p>
			{:else if failed}
				<p class="agents-note" role="alert" data-agents-failed>
					{t.agents.loadFailed}
					<button type="button" class="btn-xs" disabled={loading} onclick={() => void loadAgents(api)}>{t.agents.retry}</button>
				</p>
			{:else if loading && !list}
				<p class="agents-note" data-agents-loading>{t.agents.loading}</p>
			{/if}
			{#if missingRows.length > 0}
				<button type="button" class="agents-missing-toggle" aria-expanded={missingShown} onclick={() => (missingShown = !missingShown)} data-agents-missing-toggle>
					<svg class="agent-row-chevron" class:is-open={missingShown} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
					{t.agents.list.missingGroup(missingRows.length)}
				</button>
				{#if missingShown}
					<ul class="agents-list is-missing" aria-label={t.agents.list.missingGroup(missingRows.length)}>
						{#each missingRows as row (row.key)}
							{@render line(row, false)}
						{/each}
					</ul>
				{/if}
			{/if}
		{/if}
	</div>
{/if}

<style>
	.agents-tab {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
	}

	.agents-top {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.agents-intro,
	.agents-note {
		flex: 1;
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--muted);
	}

	.agents-note {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}

	/* One frame around the lines, a rule between them: a list, not a stack of cards. */
	.agents-list {
		list-style: none;
		margin: 0;
		padding: 0;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-xs);
		overflow: hidden;
	}

	.agents-list.is-missing {
		box-shadow: none;
	}

	.agent-row + .agent-row {
		border-top: 1px solid var(--line);
	}

	.agent-row-head {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 10px 14px;
		border: 0;
		background: transparent;
		color: var(--ink);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.agent-row-head:hover {
		background: var(--line-subtle);
	}

	.agent-row-head:focus-visible {
		outline: 2px solid var(--accent-border);
		outline-offset: -2px;
	}

	.agent-row.is-open .agent-row-head {
		background: var(--line-subtle);
	}

	.agent-row-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.agent-row-name {
		font-size: 14px;
		font-weight: 600;
	}

	.agent-row-summary {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: var(--muted);
	}

	.agent-row-bots {
		flex: none;
		padding: 1px 7px;
		border-radius: 999px;
		background: var(--chip);
		border: 1px solid var(--chip-line);
		font-size: 11px;
		color: var(--ink-secondary);
		white-space: nowrap;
	}

	.agent-row-state {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		color: var(--ink-secondary);
		white-space: nowrap;
	}

	.agent-row-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--muted-light);
	}

	.agent-row-state.is-ready .agent-row-dot {
		background: var(--ok);
	}

	.agent-row-state.is-signin {
		color: var(--warn-text);
	}

	.agent-row-state.is-signin .agent-row-dot {
		background: var(--warn);
	}

	.agent-row-chevron {
		flex: none;
		color: var(--muted);
		transition: transform 0.18s ease;
	}

	.agent-row.is-open .agent-row-chevron,
	.agent-row-chevron.is-open {
		transform: rotate(180deg);
	}

	.agents-missing-toggle .agent-row-chevron.is-open {
		transform: rotate(90deg);
	}

	.agent-row-body {
		padding: 4px 14px 14px 54px;
		border-top: 1px solid var(--line-subtle);
	}

	.agents-missing-toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		align-self: flex-start;
		padding: 2px 0;
		border: 0;
		background: none;
		color: var(--ink-secondary);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}

	.agents-page {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.agents-page-head {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	@media (max-width: 720px) {
		.agent-row-head {
			min-height: 56px;
			padding: 10px 12px;
		}

		/* The state says it in a word; on a phone the dot and the summary carry it. */
		.agent-row-state {
			font-size: 0;
			gap: 0;
		}

		.agent-row-dot {
			width: 8px;
			height: 8px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.agent-row-chevron {
			transition: none;
		}
	}
</style>
