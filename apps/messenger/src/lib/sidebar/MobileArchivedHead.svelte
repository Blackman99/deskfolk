<script lang="ts">
	import type { Copy } from '../copy.ts';

	/** A phone's archived list heads itself: Back on the left, the title and count in the middle. */
	type Props = {
		t: Copy;
		count: number;
		onBack: () => void;
	};

	let { t, count, onBack }: Props = $props();
</script>

<div class="mobile-archived-head">
	<button
		type="button"
		class="mobile-archived-back"
		title={t.sidebar.backToSessions}
		aria-label={t.sidebar.backToSessions}
		onclick={onBack}
	>
		<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<polyline points="15 18 9 12 15 6"></polyline>
		</svg>
	</button>
	<h2 class="mobile-archived-title">
		<span>{t.sidebar.archivedSessions}</span>
		{#if count > 0}
			<span class="mobile-archived-count">({count})</span>
		{/if}
	</h2>
	<div class="mobile-archived-spacer" aria-hidden="true"></div>
</div>

<style>
	.mobile-archived-head { display: none; }

	@media (max-width: 680px) {
		/*
		 * Mobile archived navigation bar: clear Back button on the left, centered title with count.
		 */
		.mobile-archived-head {
			display: flex;
			align-items: center;
			justify-content: space-between;
			height: 52px;
			padding: max(6px, env(safe-area-inset-top, 0px)) 12px 6px 8px;
			background: var(--pane);
			border-bottom: 1px solid var(--line);
			flex-shrink: 0;
		}

		.mobile-archived-back {
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
			transition: background 0.15s ease;
		}

		.mobile-archived-back:active {
			background: var(--row-hover);
		}

		.mobile-archived-title {
			margin: 0;
			font-size: 16px;
			font-weight: 600;
			color: var(--ink);
			display: flex;
			align-items: center;
			gap: 6px;
		}

		.mobile-archived-count {
			font-size: 13px;
			font-weight: 500;
			color: var(--muted);
		}

		.mobile-archived-spacer {
			width: 38px;
			flex-shrink: 0;
		}
	}
</style>
