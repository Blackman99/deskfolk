<script lang="ts">
	import type { ClaudeUsage } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { usageCheckedTime, usageLevel, usagePercentText, usageResetText, usageWindowLabel } from './claude-usage.ts';

	/** Every window of your Claude plan with its bar and when it starts over (ADR 0061). */
	interface Props {
		usage: Omit<ClaudeUsage, 'accounts'>;
		t: Copy;
		locale: string;
		/** The clock the reset times count from, ticked by whoever shows this. */
		now: number;
		busy: boolean;
		/** Absent: no button, for every account but the last when several are shown, so one refresh asks them all. */
		onRefresh?: () => void;
	}

	let { usage, t, locale, now, busy, onRefresh }: Props = $props();

	const checked = $derived(usageCheckedTime(usage.checked_at, locale));
</script>

<div class="usage-rows" data-claude-usage-rows>
	<ul>
		{#each usage.windows as window (`${window.kind}:${window.model ?? ''}`)}
			{@const reset = usageResetText(window.resets_at, now, t, locale)}
			<li class="usage-row is-{usageLevel(window.percent)}" data-usage-window={window.kind}>
				<span class="usage-name">{usageWindowLabel(window, t)}</span>
				<span class="usage-percent">{usagePercentText(window.percent)}</span>
				<span class="usage-bar" aria-hidden="true"><span style:width="{window.percent}%"></span></span>
				{#if reset}<span class="usage-reset">{reset}</span>{/if}
			</li>
		{/each}
	</ul>
	<div class="usage-foot">
		<span class="usage-checked" class:is-stale={usage.error !== null}>
			{#if usage.error !== null && checked}{t.claudeAgent.usage.stale(checked)}{:else if checked}{t.claudeAgent.usage.checkedAt(checked)}{/if}
		</span>
		{#if onRefresh}
			<button type="button" class="btn-xs" disabled={busy} onclick={onRefresh}>{busy ? t.claudeAgent.usage.refreshing : t.claudeAgent.usage.refresh}</button>
		{/if}
	</div>
</div>

<style>
	.usage-rows {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.usage-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) max-content;
		gap: 3px 8px;
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
		grid-column: 1 / -1;
		color: var(--muted);
		font-size: 11px;
	}

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
