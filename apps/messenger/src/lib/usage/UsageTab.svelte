<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { localeTag } from '../locale-tag.ts';
	import UsageBoard from './UsageBoard.svelte';
	import { usageFeedOf } from './usage-feed.svelte.ts';
	import { usageCheckedTime, usageLatestCheck } from './usage.ts';
	import { usageWidget } from './usage-widget.svelte.ts';

	/**
	 * The workbench's usage tab (ADR 0080), opened from Tools and the menu bar where the settings
	 * say: a bar with when it was checked and Refresh, then the board. A hidden ball is brought
	 * back from the bar, since Tools no longer opens it.
	 */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
	}

	let { runtime, t }: Props = $props();

	const feed = $derived(usageFeedOf(runtime));
	const client = $derived(runtime.connection === 'connected' ? runtime.client : null);
	const locale = $derived(localeTag(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh'));
	const checked = $derived(feed.agents ? usageCheckedTime(usageLatestCheck(feed.agents), locale) : null);

	$effect(() => {
		const api = client;
		if (!api) return;
		return feed.watch(api);
	});
</script>

<section class="usage-tab" aria-label={t.usage.title} data-usage-tab>
	<header class="usage-tab-head">
		<h2>{t.usage.title}</h2>
		{#if checked}
			<span class="usage-checked">{feed.failed ? t.usage.stale(checked) : t.usage.checkedAt(checked)}</span>
		{/if}
		<span class="usage-tab-actions">
			{#if usageWidget.hidden}
				<button type="button" class="usage-tab-button usage-tab-widget" onclick={() => usageWidget.unhide()}>{t.usage.showWidget}</button>
			{/if}
			<button
				type="button"
				class="usage-tab-button usage-refresh"
				disabled={feed.busy || !client}
				onclick={() => client && void feed.load(client, true)}
			>
				{feed.busy ? t.usage.refreshing : t.usage.refresh}
			</button>
		</span>
	</header>
	<div class="usage-tab-scroll">
		{#if feed.agents}
			<UsageBoard agents={feed.agents} {t} {locale} now={feed.now} meter="bar" />
		{/if}
	</div>
</section>

<style>
	.usage-tab {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
		background: var(--sidebar-bg);
		color: var(--ink);
		font-family: var(--font);
	}

	.usage-tab-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 6px 12px;
		padding: 18px 24px 14px;
		border-bottom: 1px solid var(--line);
		flex-shrink: 0;
	}

	h2 {
		margin: 0;
		font-size: 18px;
		font-weight: 650;
		letter-spacing: -0.01em;
	}

	.usage-checked {
		color: var(--muted);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}

	.usage-tab-actions {
		display: flex;
		gap: 8px;
		margin-left: auto;
		align-self: center;
	}

	.usage-tab-button {
		min-height: 30px;
		padding: 0 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--ink);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}

	.usage-tab-button:hover:not(:disabled) {
		background: var(--row-hover);
	}

	.usage-tab-button:disabled {
		color: var(--muted);
		cursor: default;
	}

	.usage-tab-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 20px 24px 32px;
	}
</style>
