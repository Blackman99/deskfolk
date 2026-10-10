<script lang="ts">
	import type { UsageWindow } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { usageLeft, usageLeftText, usageLevel, usageResetShort, usageResetText, usageSpan, usageWindowLabel } from './usage.ts';

	/**
	 * One window as a bar on the desktop's usage tab: its name on one line ("Fable · 7 天", a long
	 * model name cut before the length is), when it starts over, what is left, and a bar of it.
	 */
	interface Props {
		window: UsageWindow;
		t: Copy;
		locale: string;
		now: number;
	}

	let { window, t, locale, now }: Props = $props();

	const reset = $derived(usageResetText(window.resets_at, now, t, locale));
	const resetShort = $derived(usageResetShort(window.resets_at, now, t, locale));
</script>

<li class="usage-meter is-{usageLevel(window.percent)}" data-usage-window={window.model ?? window.minutes ?? ''}>
	<span class="usage-gauge-name" title={window.model ? usageWindowLabel(window, t) : undefined}>
		{#if window.model}<span class="usage-gauge-model">{window.model}</span><span class="usage-gauge-sep" aria-hidden="true">·</span>{/if}<span class="usage-gauge-span">{usageSpan(window.minutes, t)}</span>
	</span>
	<span class="usage-reset" title={reset ?? undefined}>
		{#if resetShort}
			<!-- A turning arrow: when it starts over. -->
			<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M3 12a9 9 0 1 0 3-6.7"></path>
				<polyline points="3 4 3 9 8 9"></polyline>
			</svg>
			{resetShort}
		{/if}
	</span>
	<span class="usage-percent">{t.usage.left(usageLeftText(window.percent))}</span>
	<!-- Filled with what is left, so an empty bar is a window spent. -->
	<span class="usage-meter-bar" aria-hidden="true"><span style:width="{usageLeft(window.percent)}%"></span></span>
</li>

<style>
	/* Name, when it starts over, what is left; the bar under all three. */
	.usage-meter {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		align-items: baseline;
		gap: 6px 12px;
		min-width: 0;
		font-size: 13px;
	}

	.usage-gauge-name {
		display: flex;
		gap: 4px;
		min-width: 0;
		overflow: hidden;
		color: var(--ink);
		font-weight: 600;
		white-space: nowrap;
	}

	.usage-gauge-model {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.usage-gauge-sep {
		color: var(--muted);
		font-weight: 400;
	}

	.usage-gauge-span {
		flex: none;
	}

	.usage-reset {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		align-self: center;
		color: var(--muted);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.usage-reset svg {
		flex: none;
	}

	.usage-percent {
		min-width: 4.5em;
		text-align: right;
		color: var(--ink);
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.usage-meter-bar {
		grid-column: 1 / -1;
		height: 6px;
		border-radius: var(--radius-full);
		background: var(--line);
		overflow: hidden;
	}

	.usage-meter-bar > span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--ink-secondary);
	}

	.usage-meter.is-warn .usage-meter-bar > span {
		background: var(--warn);
	}

	.usage-meter.is-warn .usage-percent {
		color: var(--warn-text);
	}

	.usage-meter.is-danger .usage-meter-bar > span {
		background: var(--danger);
	}

	.usage-meter.is-danger .usage-percent {
		color: var(--danger-text);
	}
</style>
