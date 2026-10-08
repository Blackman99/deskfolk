<script lang="ts">
	import type { Copy } from '../copy.ts';

	/**
	 * The tools menu's button: in the footer on a wide list, beside the search on a phone. The menu
	 * itself is the sidebar's; this is only its anchor, and the arrow keys that open it.
	 */
	type Props = {
		t: Copy;
		phone: boolean;
		open?: boolean;
		focusLast?: boolean;
		/** The menu anchors to this. */
		buttonEl?: HTMLButtonElement | null;
	};

	let { t, phone, open = $bindable(false), focusLast = $bindable(false), buttonEl = $bindable(null) }: Props = $props();

	function onToolsToggleKeyDown(e: KeyboardEvent): void {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		e.preventDefault();
		focusLast = e.key === 'ArrowUp';
		open = true;
	}
</script>

<button
	bind:this={buttonEl}
	type="button"
	class="tools-entry"
	class:foot-action={!phone}
	class:is-active={open}
	title={t.sidebar.tools}
	aria-label={t.sidebar.tools}
	aria-haspopup="menu"
	aria-expanded={open}
	aria-controls={open ? 'sidebar-tools-menu' : undefined}
	onkeydown={onToolsToggleKeyDown}
	onclick={() => (open = !open)}
>
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<rect x="3" y="3" width="7" height="7" rx="1.5"></rect>
		<rect x="14" y="3" width="7" height="7" rx="1.5"></rect>
		<rect x="3" y="14" width="7" height="7" rx="1.5"></rect>
		<rect x="14" y="14" width="7" height="7" rx="1.5"></rect>
	</svg>
	{#if !phone}
		<span class="foot-label">{t.sidebar.tools}</span>
		<svg class="tools-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 15 6-6 6 6"></path></svg>
	{/if}
</button>


<style>
	.foot-action {
		height: 36px;
		padding: 0 7px;
		gap: 6px;
		font: 500 12px/1 var(--font);
		white-space: nowrap;
		border: 1px solid transparent;
		background: transparent;
		border-radius: var(--radius-sm);
		color: var(--muted);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: background 0.15s ease, color 0.15s ease;
		position: relative;
		cursor: pointer;
		flex-shrink: 0;
	}

	.tools-chevron {
		opacity: 0.65;
	}

	/*
	 * A list under 300px tightens the row. Up to there the roomy one has to fit: written out in
	 * English it is 295px wide, and switching any earlier left a band where it overflowed into
	 * icons while a narrower list still showed the words.
	 */
	@container sidebar-footer (max-width: 283px) {
		.foot-action {
			padding-inline: 4px;
			gap: 4px;
		}

		.tools-chevron {
			display: none;
		}
	}

	/*
	 * Icons only. Under 240px the words would stand shoulder to shoulder even where they still fit
	 * (Chinese fits down to the 200px minimum), and at any width once the three no longer fit.
	 */
	@container sidebar-footer (max-width: 223px) {
		.foot-label,
		.tools-chevron {
			display: none;
		}

		.foot-action {
			padding-inline: 8px;
		}
	}

	:global(.foot.is-compact) .foot-label,
	:global(.foot.is-compact) .tools-chevron {
		display: none;
	}

	:global(.foot.is-compact) .foot-action {
		padding-inline: 8px;
	}

	.foot-action:hover:not(:disabled) {
		border-color: var(--line);
		color: var(--ink);
		background: var(--btn-secondary-hover);
		box-shadow: var(--shadow-xs);
	}

	.foot-action.is-active {
		border-color: var(--accent-border);
		color: var(--accent);
		background: var(--accent-tint);
	}

	.foot-action:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-glow);
	}

	.foot-action:disabled {
		opacity: 0.35;
		cursor: default;
	}

	@media (max-width: 680px) {
		.tools-entry {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: var(--tools-entry-size);
			height: var(--tools-entry-size);
			border: 1px solid var(--line);
			border-radius: var(--radius-md);
			background: var(--pane);
			color: var(--ink-secondary);
			cursor: pointer;
			position: relative;
			transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
		}

		.tools-entry:active,
		.tools-entry.is-active {
			background: var(--row-hover);
			color: var(--ink);
			border-color: var(--line-hover);
		}
	}
</style>
