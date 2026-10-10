<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import UsageView from './UsageView.svelte';

	/**
	 * A phone's usage page (ADR 0080), opened from Tools in place of the list: Back on the left, the
	 * title in the middle, and everything the wide window's widget panel holds.
	 */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
		onBack: () => void;
	}

	let { runtime, t, onBack }: Props = $props();
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
	<UsageView {runtime} {t} />
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
		font-size: 13px;
	}
</style>
