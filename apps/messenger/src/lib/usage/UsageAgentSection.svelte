<script lang="ts">
	import type { UsageAgent } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import AgentLogo from '../settings/AgentLogo.svelte';
	import {
		usageAccountNote,
		usageAccountShortName,
		usageCreditsText,
		usageLeft,
		usageLeftText,
		usageLevel,
		usageResetText,
		usageTokenText,
		usageWindowLabel,
		usageWindowsSorted
	} from './usage.ts';

	/**
	 * One agent's usage (ADR 0080): its name with its day here, then each account with every window,
	 * what is left and when it starts over. The phone's page lists one per agent; the widget shows
	 * the one you point at.
	 */
	interface Props {
		agent: UsageAgent;
		t: Copy;
		locale: string;
		now: number;
		/** The agent's mark beside its name: larger in the widget's card. */
		logoSize?: number;
	}

	let { agent, t, locale, now, logoSize = 14 }: Props = $props();

	/** Several accounts: each in a box of its own, so its windows read as its. */
	const several = $derived(agent.accounts.length > 1);
	const today = $derived(t.usage.today(String(agent.today.turns), usageTokenText(agent.today.tokens)));
</script>

<section class="usage-agent" data-usage-agent={agent.runner}>
	<h3 class="usage-agent-head">
		<AgentLogo runner={agent.runner} size={logoSize} />
		<span class="usage-agent-name">{agent.runner === 'claude_code' ? 'Claude' : agent.label}</span>
		<span class="usage-agent-today">{today}</span>
	</h3>
	{#each agent.accounts as account (account.config_dir ?? '')}
		{@const note = usageAccountNote(account, t)}
		{@const name = usageAccountShortName(agent, account, t)}
		<div class="usage-account" class:is-boxed={several} data-usage-account={account.config_dir ?? ''}>
			<div class="usage-account-head">
				<span class="usage-account-name" title={account.error ?? undefined}>
					{#if name.plan}<span class="usage-account-plan">{name.plan}</span>{/if}
					{#if name.who}<span class="usage-account-who">{name.who}</span>{/if}
				</span>
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

<style>
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

	.usage-agent-head {
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
	}

	/* One box per account when there are several: the account is the group, its windows inside. */
	.usage-account.is-boxed {
		gap: 10px;
		padding: 10px 12px 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--ink) 3%, transparent);
	}

	.usage-account-head {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
		font-size: 12px;
	}

	.usage-account-name {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	/* The plan is what tells accounts apart at a glance; the email is the detail after it. */
	.usage-account-plan {
		flex-shrink: 0;
		padding: 1px 7px;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--ink) 9%, transparent);
		color: var(--ink);
		font-size: 0.92em;
		font-weight: 600;
		line-height: 1.5;
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
</style>
