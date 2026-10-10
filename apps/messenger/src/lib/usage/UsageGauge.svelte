<script lang="ts">
	import type { UsageWindow } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { usageLeft, usageLeftText, usageLevel, usageResetShort, usageResetText, usageSpan } from './usage.ts';

	/**
	 * One window as a dial on the usage tab: a ring as full as what is left, the number inside it,
	 * then the window's length, its model when it is a model's own, and when it starts over.
	 */
	interface Props {
		window: UsageWindow;
		t: Copy;
		locale: string;
		now: number;
	}

	let { window, t, locale, now }: Props = $props();

	const R = 30;
	const reset = $derived(usageResetText(window.resets_at, now, t, locale));
	const resetShort = $derived(usageResetShort(window.resets_at, now, t, locale));
</script>

<li class="usage-gauge is-{usageLevel(window.percent)}" data-usage-window={window.model ?? window.minutes ?? ''}>
	<span class="usage-gauge-dial">
		<svg width="76" height="76" viewBox="0 0 76 76" aria-hidden="true">
			<circle cx="38" cy="38" r={R} fill="none" stroke="var(--line)" stroke-width="6" />
			<circle class="usage-gauge-arc" cx="38" cy="38" r={R} fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset={100 - usageLeft(window.percent)} transform="rotate(-90 38 38)" />
		</svg>
		<span class="usage-gauge-value">
			<span class="usage-percent">{usageLeftText(window.percent)}</span>
			<span class="usage-gauge-unit">{t.usage.leftLabel}</span>
		</span>
	</span>
	<!-- "Fable · 7 天" on one line when it fits; a long model name wraps, the length stays whole. -->
	<span class="usage-gauge-name">
		{#if window.model}<span class="usage-gauge-model">{window.model}</span>{' '}{/if}<span class="usage-gauge-tail">{#if window.model}<span class="usage-gauge-sep" aria-hidden="true">·</span>{' '}{/if}<span class="usage-gauge-span">{usageSpan(window.minutes, t)}</span></span>
	</span>
	{#if resetShort}
		<span class="usage-reset" title={reset ?? undefined}>
			<!-- A turning arrow: when it starts over. -->
			<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M3 12a9 9 0 1 0 3-6.7"></path>
				<polyline points="3 4 3 9 8 9"></polyline>
			</svg>
			{resetShort}
		</span>
	{/if}
</li>

<style>
	.usage-gauge {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		min-width: 0;
		text-align: center;
	}

	.usage-gauge-dial {
		position: relative;
		display: grid;
		place-items: center;
		width: 76px;
		height: 76px;
		margin-bottom: 6px;
		color: var(--ink-secondary);
	}

	.usage-gauge-dial svg {
		position: absolute;
		inset: 0;
	}

	.usage-gauge-value {
		display: flex;
		flex-direction: column;
		align-items: center;
		line-height: 1.1;
	}

	.usage-percent {
		color: var(--ink);
		font-size: 15px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.01em;
	}

	.usage-gauge-unit {
		color: var(--muted);
		font-size: 10px;
	}

	.usage-gauge.is-warn .usage-gauge-dial {
		color: var(--warn);
	}

	.usage-gauge.is-warn .usage-percent {
		color: var(--warn-text);
	}

	.usage-gauge.is-danger .usage-gauge-dial {
		color: var(--danger);
	}

	.usage-gauge.is-danger .usage-percent {
		color: var(--danger-text);
	}

	.usage-gauge-name {
		max-width: 100%;
		min-width: 0;
		color: var(--ink);
		font-size: 13px;
		font-weight: 600;
		line-height: 1.35;
		overflow-wrap: anywhere;
		text-align: center;
	}

	/* "· 7 天" never splits from itself; the model name before it wraps at its spaces. */
	.usage-gauge-tail {
		white-space: nowrap;
	}

	.usage-gauge-sep {
		color: var(--muted);
		font-weight: 400;
	}

	.usage-reset {
		max-width: 100%;
		overflow: hidden;
		font-size: 11px;
	}

	.usage-reset {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 3px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.usage-reset svg {
		flex: none;
	}
</style>
