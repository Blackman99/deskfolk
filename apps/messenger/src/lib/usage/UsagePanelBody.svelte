<script lang="ts">
	import type { UsageAgent } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import AgentLogo from '../settings/AgentLogo.svelte';
	import UsageAgentSection from './UsageAgentSection.svelte';
	import { usageCheckedTime, usageLatestCheck, usageSplit, usageTokenText } from './usage.ts';

	/**
	 * Every agent's usage in full (ADR 0080), for the widget's panel and the phone's page: first the
	 * agents that report their plan's windows, each account with every window, how much is left and
	 * when it starts over, with the agent's day here beside its name; then, muted, the agents with
	 * only this app's records of today; then when it was checked, and Refresh.
	 */
	interface Props {
		agents: UsageAgent[];
		t: Copy;
		locale: string;
		now: number;
		busy: boolean;
		/** The latest ask failed: the time said is that of the answer still shown. */
		failed?: boolean;
		onRefresh: () => void;
	}

	let { agents, t, locale, now, busy, failed = false, onRefresh }: Props = $props();

	const split = $derived(usageSplit(agents));
	const checked = $derived(usageCheckedTime(usageLatestCheck(agents), locale));
	const today = (agent: UsageAgent) => t.usage.today(String(agent.today.turns), usageTokenText(agent.today.tokens));
</script>

<div class="usage-body" data-usage-body>
	{#if agents.length === 0}
		<p class="usage-empty">{t.usage.empty}</p>
	{/if}
	{#each split.plans as agent (`${agent.runner}:${agent.custom_id ?? ''}`)}
		<UsageAgentSection {agent} {t} {locale} {now} />
	{/each}
	{#if split.todayOnly.length > 0}
		<section class="usage-today-only" data-usage-today-only>
			<h3 class="usage-today-head" title={t.usage.todayOnlyHint}>{t.usage.todayOnly}</h3>
			<ul>
				{#each split.todayOnly as agent (`${agent.runner}:${agent.custom_id ?? ''}`)}
					<li class="usage-today-row" data-usage-agent={agent.runner}>
						<span class="usage-today-name"><AgentLogo runner={agent.runner} size={14} /><span>{agent.label}</span></span>
						<span class="usage-today-text">{today(agent)}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
	{#if agents.length > 0}
		<footer class="usage-foot">
			<span class="usage-checked">{checked ? (failed ? t.usage.stale(checked) : t.usage.checkedAt(checked)) : ''}</span>
			<button type="button" class="usage-refresh" disabled={busy} onclick={onRefresh}>{busy ? t.usage.refreshing : t.usage.refresh}</button>
		</footer>
	{/if}
</div>

<style>
	.usage-body {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0;
	}

	.usage-empty {
		margin: 0;
		color: var(--muted);
		font-size: 12px;
		line-height: 1.5;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	/* The agents with only this app's records: set apart and quieter than a plan's windows. */
	.usage-today-only {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 12px;
		border-top: 1px dashed var(--line);
	}

	.usage-today-head {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		min-width: 0;
		color: var(--muted);
		font-weight: 500;
		font-size: 11px;
	}

	.usage-today-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--muted);
		min-width: 0;
	}

	.usage-today-name {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		white-space: nowrap;
	}

	.usage-today-text {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.usage-foot {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-top: 10px;
		border-top: 1px solid var(--line);
		font-size: 11px;
		color: var(--muted);
	}

	.usage-checked {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.usage-refresh {
		flex: none;
		padding: 3px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--ink);
		font-size: 11px;
		cursor: pointer;
	}

	.usage-refresh:hover:not(:disabled) {
		background: var(--row-hover);
	}

	.usage-refresh:disabled {
		color: var(--muted);
		cursor: default;
	}
</style>
