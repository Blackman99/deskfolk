<script lang="ts">
	import type { ClaudeUsage } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { usageLeft, usageLeftText, usageLevel, usageResetText, usageWindowLabel } from './claude-usage.ts';
	import ClaudeUsageFoot from './ClaudeUsageFoot.svelte';

	/**
	 * Every window of your Claude plan (ADR 0061), two lines each: its name, when it starts over and
	 * how much is left of it, then a bar of what is left.
	 */
	interface Props {
		usage: Omit<ClaudeUsage, 'accounts'>;
		t: Copy;
		locale: string;
		/** The clock the reset times count from, ticked by whoever shows this. */
		now: number;
		busy: boolean;
		onRefresh?: () => void;
		/** Whether to say when these were read, with the refresh button; off inside an account's group, whose list has one foot for all. */
		foot?: boolean;
	}

	let { usage, t, locale, now, busy, onRefresh, foot = true }: Props = $props();
</script>

<div class="usage-rows" data-claude-usage-rows>
	<ul>
		{#each usage.windows as window (`${window.kind}:${window.model ?? ''}`)}
			{@const reset = usageResetText(window.resets_at, now, t, locale)}
			<li class="usage-row is-{usageLevel(window.percent)}" data-usage-window={window.kind}>
				<span class="usage-name">{usageWindowLabel(window, t)}</span>
				<span class="usage-reset">{reset ?? ''}</span>
				<span class="usage-percent">{t.claudeAgent.usage.left(usageLeftText(window.percent))}</span>
				<!-- Filled with what is left, so an empty bar is a window spent. -->
				<span class="usage-bar" aria-hidden="true"><span style:width="{usageLeft(window.percent)}%"></span></span>
			</li>
		{/each}
	</ul>
	{#if foot}
		<ClaudeUsageFoot checkedAt={usage.checked_at} stale={usage.error !== null} {t} {locale} {busy} {onRefresh} />
	{/if}
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
