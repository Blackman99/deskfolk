<script lang="ts">
	import type { Copy } from '../copy.ts';
	import { usageCheckedTime } from './claude-usage.ts';

	/** When the windows above were read, by your own Claude Code, and a way to read them again (ADR 0061). */
	interface Props {
		checkedAt: string | null;
		/** The latest ask failed: what shows is the answer from `checkedAt`. */
		stale: boolean;
		t: Copy;
		locale: string;
		busy: boolean;
		/** Absent: no button. */
		onRefresh?: () => void;
	}

	let { checkedAt, stale, t, locale, busy, onRefresh }: Props = $props();

	const checked = $derived(usageCheckedTime(checkedAt, locale));
</script>

<div class="usage-foot">
	<span class="usage-checked" class:is-stale={stale}>
		{#if stale && checked}{t.claudeAgent.usage.stale(checked)}{:else if checked}{t.claudeAgent.usage.checkedAt(checked)}{/if}
	</span>
	{#if onRefresh}
		<button type="button" class="btn-xs" disabled={busy} onclick={onRefresh}>{busy ? t.claudeAgent.usage.refreshing : t.claudeAgent.usage.refresh}</button>
	{/if}
</div>

<style>
	.usage-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}

	.usage-checked {
		min-width: 0;
		color: var(--muted);
		font-size: 11px;
		line-height: 1.4;
	}

	.usage-checked.is-stale {
		color: var(--warn-text);
	}

	.usage-foot .btn-xs {
		flex-shrink: 0;
	}
</style>
