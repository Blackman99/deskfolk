<script lang="ts">
	import type { UsageAgent } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import AgentLogo from '../settings/AgentLogo.svelte';
	import UsageGauge from './UsageGauge.svelte';
	import {
		usageAccountNote,
		usageAccountShortName,
		usageCreditsText,
		usageSplit,
		usageTokenText,
		usageWindowsSorted
	} from './usage.ts';

	/**
	 * Every agent's usage laid out for a whole tab (ADR 0080): a band per agent with its day here,
	 * a card per account across the width, each window a dial; the agents with only this app's
	 * records of today in one row of chips at the end.
	 */
	interface Props {
		agents: UsageAgent[];
		t: Copy;
		locale: string;
		now: number;
	}

	let { agents, t, locale, now }: Props = $props();

	/** The narrowest an account card gets; as many columns as fit, an agent's accounts side by side. */
	const CARD_MIN = 360;
	const GAP = 12;
	let width = $state(0);
	const columns = $derived(Math.max(1, Math.floor((width + GAP) / (CARD_MIN + GAP))));
	const span = (agent: UsageAgent) => Math.min(columns, Math.max(1, agent.accounts.length));

	const split = $derived(usageSplit(agents));
	const key = (agent: UsageAgent) => `${agent.runner}:${agent.custom_id ?? ''}`;
	const name = (agent: UsageAgent) => (agent.runner === 'claude_code' ? 'Claude' : agent.label);
	const today = (agent: UsageAgent) => t.usage.today(String(agent.today.turns), usageTokenText(agent.today.tokens));
</script>

<div class="usage-board" data-usage-body bind:clientWidth={width} style:--usage-columns={columns}>
	{#if agents.length === 0}
		<p class="usage-board-empty">{t.usage.empty}</p>
	{/if}
	{#each split.plans as agent (key(agent))}
		<section class="usage-board-agent" data-usage-agent={agent.runner} style:--usage-span={span(agent)}>
			<h3 class="usage-board-agent-head">
				<AgentLogo runner={agent.runner} size={22} />
				<span class="usage-board-agent-name">{name(agent)}</span>
				<span class="usage-agent-today">{today(agent)}</span>
			</h3>
			{#each agent.accounts as account (account.config_dir ?? '')}
				{@const note = usageAccountNote(account, t)}
				{@const who = usageAccountShortName(agent, account, t)}
				<article class="usage-board-account" data-usage-account={account.config_dir ?? ''}>
					<header class="usage-board-account-head">
						<span class="usage-account-name" title={account.error ?? undefined}>
							{#if who.plan}<span class="usage-account-plan">{who.plan}</span>{/if}
							{#if who.who}<span class="usage-account-who">{who.who}</span>{/if}
						</span>
						{#if account.credits}<span class="usage-credits">{t.usage.credits(usageCreditsText(account.credits, locale))}</span>{/if}
					</header>
					{#if note}
						<p class="usage-note">{note}</p>
					{:else}
						<ul class="usage-board-gauges">
							{#each usageWindowsSorted(account.windows) as window (`${window.minutes ?? ''}:${window.model ?? ''}`)}
								<UsageGauge {window} {t} {locale} {now} />
							{/each}
						</ul>
					{/if}
				</article>
			{/each}
		</section>
	{/each}
	{#if split.todayOnly.length > 0}
		<section class="usage-board-today" data-usage-today-only>
			<h3 class="usage-board-today-head">{t.usage.todayOnly}<span>{t.usage.todayOnlyHint}</span></h3>
			<ul>
				{#each split.todayOnly as agent (key(agent))}
					<li class="usage-board-chip" data-usage-agent={agent.runner}>
						<AgentLogo runner={agent.runner} size={18} />
						<span class="usage-board-chip-name">{agent.label}</span>
						<span class="usage-agent-today">{today(agent)}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	h3 {
		margin: 0;
	}

	/*
	 * One grid for every agent: each takes as many columns as it has accounts, so a wide tab puts
	 * several agents in a row instead of stacking each under the last.
	 */
	.usage-board {
		display: grid;
		grid-template-columns: repeat(var(--usage-columns, 1), minmax(0, 1fr));
		gap: 28px 12px;
		align-items: start;
		min-width: 0;
	}

	.usage-board-empty {
		grid-column: 1 / -1;
		margin: 0;
		color: var(--muted);
		font-size: 13px;
		line-height: 1.5;
	}

	/* Its head over its own columns, its cards on the board's columns. */
	.usage-board-agent {
		grid-column: span var(--usage-span, 1);
		display: grid;
		grid-template-columns: subgrid;
		gap: 12px;
		align-content: start;
		min-width: 0;
	}

	.usage-board-agent-head {
		grid-column: 1 / -1;
	}

	.usage-board-agent-head {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		font-size: 15px;
		font-weight: 650;
		color: var(--ink);
	}

	.usage-board-agent-name {
		white-space: nowrap;
	}

	.usage-agent-today {
		color: var(--muted);
		font-size: 12px;
		font-weight: 400;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.usage-board-account {
		display: flex;
		flex-direction: column;
		gap: 16px;
		min-width: 0;
		padding: 14px 16px 18px;
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		background: var(--pane);
	}

	.usage-board-account-head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-size: 13px;
	}

	.usage-account-name {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.usage-account-plan {
		flex-shrink: 0;
		padding: 1px 8px;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--ink) 9%, transparent);
		color: var(--ink);
		font-size: 12px;
		font-weight: 600;
		line-height: 1.6;
	}

	.usage-account-who {
		min-width: 0;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.usage-credits {
		margin-left: auto;
		color: var(--muted);
		font-size: 12px;
		white-space: nowrap;
	}

	.usage-note {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
	}

	.usage-board-gauges {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
		gap: 18px 8px;
	}

	.usage-board-today {
		grid-column: 1 / -1;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding-top: 20px;
		border-top: 1px solid var(--line);
	}

	.usage-board-today-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 10px;
		color: var(--ink-secondary);
		font-size: 13px;
		font-weight: 600;
	}

	.usage-board-today-head span {
		color: var(--muted);
		font-size: 12px;
		font-weight: 400;
	}

	.usage-board-today ul {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.usage-board-chip {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		padding: 6px 12px 6px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--pane);
		font-size: 13px;
	}

	.usage-board-chip-name {
		color: var(--ink);
		white-space: nowrap;
	}
</style>
