<script lang="ts">
	import type { UsageAgent } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import AgentLogo from '../settings/AgentLogo.svelte';
	import {
		usageAccountShortName,
		usageAccountNote,
		usageCheckedTime,
		usageCreditsText,
		usageLatestCheck,
		usageLeft,
		usageLeftText,
		usageLevel,
		usageResetText,
		usageSplit,
		usageTokenText,
		usageWindowLabel,
		usageWindowsSorted
	} from './usage.ts';

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
		<section class="usage-agent" data-usage-agent={agent.runner}>
			<h3 class="usage-agent-head">
				<AgentLogo runner={agent.runner} size={14} />
				<span class="usage-agent-name">{agent.runner === 'claude_code' ? 'Claude' : agent.label}</span>
				<span class="usage-agent-today">{today(agent)}</span>
			</h3>
			{#each agent.accounts as account (account.config_dir ?? '')}
				{@const note = usageAccountNote(account, t)}
				<div class="usage-account" data-usage-account={account.config_dir ?? ''}>
					<div class="usage-account-head">
						<span class="usage-account-name" title={account.error ?? undefined}>{usageAccountShortName(agent, account, t)}</span>
						{#if account.credits}<span class="usage-credits">{t.usage.credits(usageCreditsText(account.credits, locale))}</span>{/if}
					</div>
					{#if note}
						<p class="usage-note">{note}</p>
					{:else}
						<ul>
							{#each usageWindowsSorted(account.windows) as window (`${window.minutes ?? ''}:${window.model ?? ''}`)}
								{@const reset = usageResetText(window.resets_at, now, t, locale)}
								<li class="usage-row is-{usageLevel(window.percent)}" data-usage-window={window.model ?? window.minutes ?? ''}>
									<span class="usage-name">{usageWindowLabel(window, t)}</span>
									<span class="usage-reset">{reset ?? ''}</span>
									<span class="usage-percent">{t.usage.left(usageLeftText(window.percent))}</span>
									<!-- Filled with what is left, so an empty bar is a window spent. -->
									<span class="usage-bar" aria-hidden="true"><span style:width="{usageLeft(window.percent)}%"></span></span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/each}
		</section>
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

	.usage-agent {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.usage-agent-head,
	.usage-today-head {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
		min-width: 0;
	}

	.usage-agent-name {
		white-space: nowrap;
	}

	.usage-agent-today {
		margin-left: auto;
		color: var(--muted);
		font-weight: 400;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.usage-account {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-left: 20px;
	}

	.usage-account-head {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
		font-size: 12px;
	}

	.usage-account-name {
		color: var(--ink-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.usage-credits {
		margin-left: auto;
		color: var(--muted);
		font-size: 11px;
		white-space: nowrap;
	}

	.usage-note {
		margin: 0;
		color: var(--muted);
		font-size: 12px;
	}

	/* Name, when it starts over, what is left; the bar under all three. */
	.usage-row {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr) max-content;
		gap: 4px 8px;
		align-items: baseline;
		font-size: 12px;
		min-width: 0;
	}

	.usage-name {
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.usage-percent {
		color: var(--ink);
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}

	.usage-bar {
		grid-column: 1 / -1;
		height: 4px;
		border-radius: var(--radius-full);
		background: var(--line);
		overflow: hidden;
	}

	.usage-bar > span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--muted);
	}

	.usage-row.is-warn .usage-bar > span {
		background: var(--warn);
	}

	.usage-row.is-warn .usage-percent {
		color: var(--warn-text);
	}

	.usage-row.is-danger .usage-bar > span {
		background: var(--danger);
	}

	.usage-row.is-danger .usage-percent {
		color: var(--danger-text);
	}

	.usage-reset {
		min-width: 0;
		color: var(--muted);
		font-size: 11px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
