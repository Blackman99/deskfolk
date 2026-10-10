<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { localeTag } from '../locale-tag.ts';
	import UsageBoard from './UsageBoard.svelte';
	import { usageFeedOf } from './usage-feed.svelte.ts';
	import { usageCheckedTime, usageLatestCheck } from './usage.ts';

	/**
	 * A phone's usage page (ADR 0080), opened from Tools in place of the list: Back on the left, the
	 * title in the middle, then the usage tab's board in one column — each agent under its own
	 * head, a card per account, each window a dial — and when it was checked with Refresh.
	 */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
		onBack: () => void;
	}

	let { runtime, t, onBack }: Props = $props();

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

<div class="usage-page-head">
	<button type="button" class="usage-page-back" title={t.usage.back} aria-label={t.usage.back} onclick={onBack}>
		<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<polyline points="15 18 9 12 15 6"></polyline>
		</svg>
	</button>
	<h2 class="usage-page-title">{t.usage.title}</h2>
	<div class="usage-page-spacer" aria-hidden="true"></div>
</div>
<div class="usage-page-body" data-usage-page>
	{#if feed.agents}
		<UsageBoard agents={feed.agents} {t} {locale} now={feed.now} meter="dial" />
		{#if feed.agents.length > 0}
			<footer class="usage-page-foot">
				<span class="usage-checked">{checked ? (feed.failed ? t.usage.stale(checked) : t.usage.checkedAt(checked)) : ''}</span>
				<button type="button" class="usage-refresh" disabled={feed.busy || !client} onclick={() => client && void feed.load(client, true)}>
					{feed.busy ? t.usage.refreshing : t.usage.refresh}
				</button>
			</footer>
		{/if}
	{/if}
</div>

<style>
	.usage-page-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 52px;
		padding: max(6px, env(safe-area-inset-top, 0px)) 12px 6px 8px;
		background: var(--pane);
		border-bottom: 1px solid var(--line);
		flex-shrink: 0;
	}

	.usage-page-back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 38px;
		height: 38px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--accent);
		cursor: pointer;
		flex-shrink: 0;
	}

	.usage-page-back:active {
		background: var(--row-hover);
	}

	.usage-page-title {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
		color: var(--ink);
	}

	.usage-page-spacer {
		width: 38px;
		flex-shrink: 0;
	}

	.usage-page-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 16px 16px calc(76px + env(safe-area-inset-bottom, 0px));
		background: var(--sidebar-bg);
		font-size: 13px;
	}

	.usage-page-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-top: 20px;
		padding-top: 14px;
		border-top: 1px solid var(--line);
	}

	.usage-checked {
		color: var(--muted);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}

	.usage-refresh {
		min-height: 32px;
		padding: 0 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--ink);
		font: inherit;
		cursor: pointer;
	}

	.usage-refresh:disabled {
		color: var(--muted);
		cursor: default;
	}
</style>
