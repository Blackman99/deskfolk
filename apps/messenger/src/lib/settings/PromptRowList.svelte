<script lang="ts">
	import { MediaQuery } from 'svelte/reactivity';
	import type { Locale, PromptSummary } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { failuresOf, promptChip } from './prompts-view.ts';

	/** Prompts one line each: title, what it is, who edited it and any answers that did not read. */
	interface Props {
		items: readonly PromptSummary[];
		ui: Locale;
		/** Bots by id, to name the one that edited a prompt. */
		botNames: ReadonlyMap<string, string>;
		t: Copy;
		onopen: (item: PromptSummary, event: MouseEvent) => void;
		/** Title over what it is, as on a phone: for a list in a narrow column. */
		stacked?: boolean;
	}

	let { items: list, ui, botNames, t, onopen, stacked = false }: Props = $props();
	const phone = new MediaQuery('(max-width: 720px)');
	const c = $derived(t.prompts);
	const chipOf = (item: PromptSummary) => promptChip(item, botNames, c);
</script>

<ul class="prompts-list" class:is-stacked={stacked || phone.current}>
	{#each list as item (item.id)}
		{@const chip = chipOf(item)}
		{@const failures = failuresOf(item)}
		<li>
			<button type="button" class="prompts-row" data-prompt={item.id} onclick={(event) => onopen(item, event)}>
				<span class="prompts-row-title">{item.title[ui]}</span>
				<span class="prompts-row-summary" title={item.summary[ui]}>{item.summary[ui]}</span>
				<span class="prompts-row-end">
					{#if chip.tone !== 'default'}
						<span class="prompts-chip is-{chip.tone}">{chip.label}</span>
					{/if}
					{#if failures > 0}
						<span class="prompts-chip is-warn">{c.parseFailures(failures)}</span>
					{/if}
					<svg class="prompts-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
				</span>
			</button>
		</li>
	{/each}
</ul>

<style>
	/* One card per group, a hairline between its rows, one line a row: title, then what it is. */
	.prompts-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: fit-content(42%) minmax(0, 1fr) auto;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
		overflow: hidden;
	}

	.prompts-list > li {
		grid-column: 1 / -1;
		display: grid;
		grid-template-columns: subgrid;
	}

	.prompts-list > li + li {
		border-top: 1px solid var(--line-subtle);
	}

	.prompts-row {
		grid-column: 1 / -1;
		display: grid;
		grid-template-columns: subgrid;
		align-items: center;
		column-gap: 14px;
		min-width: 0;
		padding: 9px 10px 9px 12px;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
		transition-property: background-color;
	}

	.prompts-row:hover {
		background: var(--row-hover);
	}

	.prompts-row:focus-visible,
	.prompts-tool:focus-visible,
	.prompts-filter-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.prompts-row-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
	}

	.prompts-row-summary {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: var(--muted);
	}

	.prompts-row-end {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
	}

	.prompts-chevron {
		flex: none;
		color: var(--muted);
		opacity: 0.6;
	}

	.prompts-row:hover .prompts-chevron {
		opacity: 1;
	}

	.prompts-chip {
		padding: 1px 7px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
		white-space: nowrap;
	}

	.prompts-chip.is-edited {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.prompts-chip.is-conflict,
	.prompts-chip.is-warn {
		border-color: var(--warn-line);
		background: var(--warn-bg);
		color: var(--warn-text);
	}

	.prompts-row:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	/* Stacked (a phone, a narrow column): the title over one line of what it is; marks stay on the right. */
	.prompts-list.is-stacked {
		display: flex;
		flex-direction: column;
	}

	.prompts-list.is-stacked > li {
		display: block;
	}

	.is-stacked .prompts-row {
		width: 100%;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas: 'title end' 'summary end';
		row-gap: 2px;
		column-gap: 10px;
		padding: 10px 10px 10px 12px;
	}

	.is-stacked .prompts-row-title {
		grid-area: title;
	}

	.is-stacked .prompts-row-summary {
		grid-area: summary;
	}

	.is-stacked .prompts-row-end {
		grid-area: end;
	}
</style>
