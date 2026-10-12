<script lang="ts">
	import { formatUsd } from '../spend-format.ts';
	import type { SpendCopy } from './spend-copy.ts';

	/**
	 * One row's money. Reported and estimated stay two figures and are never added: a row with only
	 * one shows only that one (an estimate says so), a row with both shows both, each named.
	 */
	interface Props {
		copy: SpendCopy;
		reported: number | null;
		estimated: number | null;
		/** Why a row has neither. */
		missing?: string;
	}

	let { copy, reported, estimated, missing }: Props = $props();

	const both = $derived(reported != null && estimated != null);
</script>

<span class="amount" class:is-pair={both}>
	{#if reported != null}
		<span class="amount-line"><span class="amount-value">{formatUsd(reported)}</span>{#if both}<span class="amount-tag">{copy.reported}</span>{/if}</span>
	{/if}
	{#if estimated != null}
		<span class="amount-line is-estimated"><span class="amount-value">{formatUsd(estimated)}</span><span class="amount-tag">{copy.estimated}</span></span>
	{/if}
	{#if reported == null && estimated == null}
		<span class="amount-none" title={missing}>{copy.dash}</span>
	{/if}
</span>

<style>
	.amount {
		display: inline-flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 1px;
		min-width: 0;
		max-width: 100%;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	/* Short of room, the tag goes under its figure rather than over the next column. */
	.amount-line {
		display: inline-flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		align-items: baseline;
		column-gap: 4px;
	}

	.amount-value {
		font-weight: 600;
		color: var(--ink);
	}

	.is-pair .is-estimated .amount-value {
		font-weight: 500;
		color: var(--ink-secondary);
	}

	.amount-tag {
		font-size: 10.5px;
		font-weight: 500;
		color: var(--muted);
	}

	.amount-none {
		color: var(--muted);
	}
</style>
