<script lang="ts" generics="S extends string">
	import type { Snippet } from 'svelte';

	/**
	 * A settings page's sections as tabs along its top, one open under them (Models, Prompts). Each
	 * tab is `${id}-tab-${section}` and controls `${id}-panel`, which the page draws.
	 */
	type Props = {
		id: string;
		sections: readonly S[];
		active: S;
		label: (of: S) => string;
		/** The number on a tab; a tab with 0 shows none. */
		count?: (of: S) => number;
		/** That number in the warning colour. */
		warn?: (of: S) => boolean;
		icon: Snippet<[S, number]>;
		ariaLabel: string;
		onpick: (of: S) => void;
	};

	let { id, sections, active, label, count = () => 0, warn = () => false, icon, ariaLabel, onpick }: Props = $props();
</script>

<div class="section-tabs" role="tablist" aria-label={ariaLabel}>
	{#each sections as of (of)}
		{@const n = count(of)}
		<button
			type="button"
			role="tab"
			id={`${id}-tab-${of}`}
			aria-controls={`${id}-panel`}
			aria-selected={active === of}
			class="section-tab"
			class:is-active={active === of}
			data-section={of}
			onclick={(event) => {
				onpick(of);
				event.currentTarget.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
			}}
		>
			{@render icon(of, 15)}
			<span>{label(of)}</span>
			{#if n > 0}
				<span class="section-tab-count" class:is-warn={warn(of)}>{n}</span>
			{/if}
		</button>
	{/each}
</div>

<style>
	/*
	 * Four tabs fill a narrow window, more so in English: the row scrolls sideways rather than push
	 * the dialog wider. The rule under it is a shadow, not a border, so the scroll does not clip the
	 * active tab's underline drawn over it.
	 */
	.section-tabs {
		flex: none;
		display: flex;
		align-items: stretch;
		gap: 6px;
		padding: 0 16px;
		box-shadow: inset 0 -1px 0 var(--line);
		background: var(--pane);
		overflow-x: auto;
		scrollbar-width: none;
	}

	.section-tabs::-webkit-scrollbar {
		display: none;
	}

	.section-tab {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		min-height: 44px;
		padding: 10px 8px 8px;
		border: 0;
		border-bottom: 2px solid transparent;
		border-radius: 0;
		background: transparent;
		color: var(--ink-secondary);
		font-size: 13px;
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
		transition-property: color, border-color;
	}

	.section-tab:hover {
		color: var(--ink);
	}

	.section-tab:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.section-tab.is-active {
		color: var(--accent);
		font-weight: 600;
		border-bottom-color: var(--accent);
	}

	.section-tab > :global(svg) {
		flex: none;
		color: var(--muted);
	}

	.section-tab.is-active > :global(svg) {
		color: var(--accent);
	}

	.section-tab-count {
		min-width: 18px;
		padding: 0 5px;
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 11px;
		font-weight: 600;
		line-height: 16px;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	.section-tab.is-active .section-tab-count {
		background: var(--accent-tint);
		color: var(--accent);
	}

	.section-tab .section-tab-count.is-warn {
		background: var(--warn-bg);
		color: var(--warn-text);
	}
</style>
