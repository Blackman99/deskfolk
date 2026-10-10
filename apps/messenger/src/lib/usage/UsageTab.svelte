<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import UsageView from './UsageView.svelte';
	import { usageWidget } from './usage-widget.svelte.ts';

	/**
	 * The workbench's usage tab (ADR 0080), opened from Tools and the menu bar where the settings
	 * say. A hidden ball is brought back from here, since Tools no longer opens it.
	 */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
	}

	let { runtime, t }: Props = $props();
</script>

<section class="usage-tab" aria-label={t.usage.title} data-usage-tab>
	<div class="usage-tab-body">
		<UsageView {runtime} {t} />
		{#if usageWidget.hidden}
			<button type="button" class="usage-tab-widget" onclick={() => usageWidget.unhide()}>{t.usage.showWidget}</button>
		{/if}
	</div>
</section>

<style>
	.usage-tab {
		height: 100%;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		background: var(--sidebar-bg);
		color: var(--ink);
		font-family: var(--font);
	}

	.usage-tab-body {
		display: flex;
		flex-direction: column;
		gap: 16px;
		max-width: 640px;
		margin: 0 auto;
		padding: 20px 24px;
		font-size: 13px;
	}

	.usage-tab-widget {
		align-self: flex-start;
		min-height: 30px;
		padding: 0 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--ink);
		font: inherit;
		cursor: pointer;
	}

	.usage-tab-widget:hover {
		background: var(--row-hover);
	}
</style>
