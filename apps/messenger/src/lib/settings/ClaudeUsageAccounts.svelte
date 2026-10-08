<script lang="ts">
	import type { ClaudeAccountUsage } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { usageAccountDetail, usageAccountNote, usageAccountShortLabels, usageCheckedTime, usageLatestCheck } from './claude-usage.ts';
	import ClaudeUsageFoot from './ClaudeUsageFoot.svelte';
	import ClaudeUsageRows from './ClaudeUsageRows.svelte';

	/**
	 * Several Claude accounts' usage (ADR 0061), each in a group of its own: its short name — the
	 * one the closed strip uses — over its email, then its windows. One line under all of them says
	 * when they were read, with one refresh for every account.
	 */
	interface Props {
		accounts: ClaudeAccountUsage[];
		t: Copy;
		locale: string;
		now: number;
		busy: boolean;
		onRefresh?: () => void;
	}

	let { accounts, t, locale, now, busy, onRefresh }: Props = $props();

	const labels = $derived(usageAccountShortLabels(accounts, t));
</script>

<div class="usage-accounts" data-claude-usage-accounts>
	{#each accounts as account, index (account.config_dir ?? '')}
		{@const detail = usageAccountDetail(account, labels[index] ?? '')}
		{@const failedAt = account.error !== null ? usageCheckedTime(account.checked_at, locale) : null}
		<section class="usage-account" aria-label={detail ? `${labels[index]} · ${detail}` : labels[index]} data-usage-account-group={account.config_dir ?? ''}>
			<header class="usage-account-head">
				<span class="usage-account-name">{labels[index]}</span>
				{#if detail}<span class="usage-account-detail" title={detail}>{detail}</span>{/if}
			</header>
			{#if account.available}
				<ClaudeUsageRows usage={account} {t} {locale} {now} {busy} foot={false} />
				{#if failedAt}<p class="usage-account-note is-stale">{t.claudeAgent.usage.stale(failedAt)}</p>{/if}
			{:else}
				<p class="usage-account-note">{usageAccountNote(account, t)}</p>
			{/if}
		</section>
	{/each}
	<ClaudeUsageFoot checkedAt={usageLatestCheck(accounts)} stale={false} {t} {locale} {busy} {onRefresh} />
</div>

<style>
	.usage-accounts {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}

	/* A block per account, so its windows read as its own. */
	.usage-account {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
		padding: 8px 10px 10px;
		border-radius: var(--radius-md);
		background: var(--line-subtle);
	}

	.usage-account-head {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}

	.usage-account-name {
		flex-shrink: 0;
		color: var(--ink);
		font: 600 13px/1.2 var(--font);
	}

	.usage-account-detail {
		min-width: 0;
		color: var(--muted);
		font-size: 11px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.usage-account-note {
		margin: 0;
		color: var(--muted);
		font-size: 12px;
	}

	.usage-account-note.is-stale {
		color: var(--warn-text);
		font-size: 11px;
	}
</style>
