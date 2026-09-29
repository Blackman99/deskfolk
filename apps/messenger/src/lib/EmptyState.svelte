<script lang="ts">
	import type { Snippet } from 'svelte';
	import BrandMark from './BrandMark.svelte';

	/**
	 * What a pane, a card or a list shows when there is nothing in it yet: the faded mark, a title,
	 * one line on what to do, and the buttons that do it. Every empty place draws this one, so
	 * they read as the same app instead of each inventing a grey circle with an icon in it.
	 */
	interface Props {
		title: string;
		hint?: string;
		/** `page` fills a pane; `inline` sits inside a card, a sidebar or a dialog. */
		size?: 'page' | 'inline';
		/** Heading level for the title, so the outline stays right inside a dialog or a card. */
		level?: 2 | 3;
		/** A small icon on the mark saying what is missing here (a calendar, a search). */
		badge?: Snippet;
		/** The actions under the hint. */
		children?: Snippet;
	}

	let { title, hint, size = 'page', level = 2, badge, children }: Props = $props();
</script>

<div class="empty-state" class:is-inline={size === 'inline'}>
	<div class="empty-art">
		<BrandMark variant="art" size={size === 'page' ? 72 : 52} />
		{#if badge}
			<span class="empty-badge" aria-hidden="true">{@render badge()}</span>
		{/if}
	</div>
	<svelte:element this={level === 2 ? 'h2' : 'h3'} class="empty-title">{title}</svelte:element>
	{#if hint}
		<p class="empty-hint">{hint}</p>
	{/if}
	{#if children}
		<div class="empty-actions">{@render children()}</div>
	{/if}
</div>

<style>
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 8px;
		max-width: 360px;
		margin: auto;
		padding: 40px 24px;
	}

	.empty-state.is-inline {
		padding: 20px 12px;
		gap: 6px;
	}

	.empty-art {
		position: relative;
		margin-bottom: 6px;
	}

	.empty-badge {
		position: absolute;
		right: -4px;
		bottom: -2px;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background: var(--pane);
		border: 1px solid var(--line);
		color: var(--ink-secondary);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.empty-title {
		margin: 0;
		font-size: var(--text-heading);
		font-weight: 650;
		line-height: 1.4;
		color: var(--ink);
	}

	.is-inline .empty-title {
		font-size: var(--text-body);
	}

	.empty-hint {
		margin: 0;
		font-size: var(--text-small);
		line-height: 1.6;
		color: var(--muted);
	}

	.is-inline .empty-hint {
		font-size: var(--text-caption);
	}

	.empty-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 8px;
		padding-top: 8px;
	}
</style>
