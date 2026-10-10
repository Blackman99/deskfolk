<script lang="ts">
	import type { UsageAccount } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import UsageRing from './UsageRing.svelte';
	import { usageAccountNote, usageCreditsText, usageSummary, usageTightest } from './usage.ts';

	/**
	 * One account's usage in a line (ADR 0080), as the menu bar says it: a ring for its tightest
	 * window, then what is left of the plan's 5-hour and 7-day windows; or why there are none. The
	 * whole of it is in the usage widget.
	 */
	interface Props {
		account: UsageAccount;
		t: Copy;
	}

	let { account, t }: Props = $props();

	const tightest = $derived(account.available ? usageTightest(account.windows) : null);
	const summary = $derived(usageSummary(account, t));
</script>

<span class="usage-line" data-usage-line title={account.error ?? undefined}>
	{#if tightest}
		<UsageRing percent={tightest.percent} size={13} />
		<span>{summary}</span>
		{#if account.credits}<span class="usage-line-credits">· {t.usage.credits(usageCreditsText(account.credits))}</span>{/if}
	{:else}
		<span class="usage-line-note">{usageAccountNote(account, t)}</span>
	{/if}
</span>

<style>
	.usage-line {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		color: var(--ink);
		min-width: 0;
	}

	.usage-line-credits,
	.usage-line-note {
		color: var(--muted);
	}
</style>
