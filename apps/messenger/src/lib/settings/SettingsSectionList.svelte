<script lang="ts" generics="S extends string">
	import type { Snippet } from 'svelte';

	/**
	 * On a phone, a settings page's sections as a list, each with a line on what it holds (Models,
	 * Prompts); a row opens that section as a page of its own, one level deeper.
	 */
	type Props = {
		sections: readonly S[];
		label: (of: S) => string;
		summary: (of: S) => string;
		icon: Snippet<[S, number]>;
		ariaLabel: string;
		onpick: (of: S) => void;
	};

	let { sections, label, summary, icon, ariaLabel, onpick }: Props = $props();
</script>

<nav class="section-list" aria-label={ariaLabel}>
	{#each sections as of (of)}
		<button type="button" class="section-list-row" data-section={of} onclick={() => onpick(of)}>
			{@render icon(of, 19)}
			<span class="section-list-text">
				<span class="section-list-name">{label(of)}</span>
				<span class="section-list-summary">{summary(of)}</span>
			</span>
			<span class="section-list-chevron" aria-hidden="true"></span>
		</button>
	{/each}
</nav>

<style>
	/* The rows read as the settings list one level up: one rounded group, a hairline between rows. */
	.section-list {
		display: flex;
		flex-direction: column;
		border-radius: var(--radius-lg);
		overflow: hidden;
		background: var(--pane);
	}

	.section-list-row {
		position: relative;
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-height: 64px;
		padding: 10px 14px;
		border: 0;
		border-radius: 0;
		background: var(--pane);
		color: var(--ink);
		text-align: left;
		cursor: pointer;
		transition-property: background-color;
	}

	.section-list-row + .section-list-row::before {
		content: '';
		position: absolute;
		left: 45px;
		right: 0;
		top: 0;
		height: 1px;
		background: var(--line);
	}

	.section-list-row:active {
		background: var(--row-hover);
	}

	.section-list-row > :global(svg) {
		flex: none;
		color: var(--muted);
	}

	.section-list-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.section-list-name {
		font-size: 15px;
		font-weight: 500;
		line-height: 1.3;
	}

	.section-list-summary {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		line-height: 1.35;
		color: var(--muted);
	}

	.section-list-chevron {
		flex: none;
		width: 8px;
		height: 8px;
		margin: 0 3px 0 5px;
		border-top: 1.8px solid var(--muted);
		border-right: 1.8px solid var(--muted);
		transform: rotate(45deg);
	}
</style>
