<script lang="ts">
	import { untrack } from 'svelte';
	import type { AgentStatus, AgentsStatusResponse } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { agentKey, agentUnreachable } from './agents.ts';
	import AgentCard, { type AgentCardApi } from './AgentCard.svelte';
	import CustomAgentsCard, { type CustomAgentsApi } from './CustomAgentsCard.svelte';

	/**
	 * Your local agents besides Claude Code (ADR 0079), one card each as the daemon finds them, then
	 * the card for your own ACP agents. Asked once when the Agent tab opens (the tab mounts this each
	 * time it is shown), from this Mac or over the relay from a phone.
	 */
	export type OtherAgentsApi = AgentCardApi & CustomAgentsApi & {
		agents: (refresh?: boolean) => Promise<AgentsStatusResponse>;
	};

	interface Props {
		api: OtherAgentsApi | null;
		t: Copy;
	}

	let { api, t }: Props = $props();

	let list = $state<AgentsStatusResponse | null>(null);
	let loading = $state(false);
	let failed = $state(false);
	/** Not there: a phone paired with a Mac on a Deskfolk from before the relay carried it. */
	let unavailable = $state(false);

	async function load(client: OtherAgentsApi): Promise<void> {
		if (loading) return;
		loading = true;
		failed = false;
		try {
			list = await client.agents();
			unavailable = false;
		} catch (error) {
			if (agentUnreachable(error)) unavailable = true;
			else failed = true;
		} finally {
			loading = false;
		}
	}

	// Asks once per client. `load` reads and writes `loading`, so it runs untracked: tracked, every
	// answer would set off the next ask.
	$effect(() => {
		const client = api;
		if (!client) return;
		untrack(() => void load(client));
	});

	function changed(next: AgentStatus): void {
		if (!list) return;
		list = { ...list, items: list.items.map((item) => (agentKey(item) === agentKey(next) ? next : item)) };
	}
</script>

{#if api}
	{#if list}
		{#each list.items as item (agentKey(item))}
			<AgentCard status={item} {api} {t} custom={item.custom_id ? (list.custom_agents.find((agent) => agent.id === item.custom_id) ?? null) : null} onChange={changed} />
		{/each}
		<CustomAgentsCard agents={list.custom_agents} {api} {t} onChange={(response) => (list = response)} />
	{:else if unavailable}
		<p class="agents-note" data-agents-unreachable>{t.agents.unreachable}</p>
	{:else if failed}
		<p class="agents-note" role="alert" data-agents-failed>
			{t.agents.loadFailed}
			<button type="button" class="btn-xs" disabled={loading} onclick={() => void load(api)}>{t.agents.retry}</button>
		</p>
	{:else if loading}
		<p class="agents-note" data-agents-loading>{t.agents.loading}</p>
	{/if}
{/if}

<style>
	.agents-note {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}
</style>
