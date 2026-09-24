<script lang="ts">
	import type { Annotation } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import FileIcon from '../overlays/FileIcon.svelte';
	import { fileIconFor } from '../overlays/file-icon.ts';
	import { positionLabel, resolverName, staleLabel, statusLabel } from './model.ts';

	interface Props {
		annotations: Annotation[];
		t: Copy;
		locale: 'zh' | 'en';
		bots: ReadonlyMap<string, { name: string }>;
		/** Open the file in the preview and go to this spot. */
		onOpen: (row: Annotation) => void;
		/** Flip a sent annotation between pending and resolved; absent when the view is read-only. */
		onToggleStatus?: (row: Annotation, status: 'open' | 'resolved') => void;
		/** For a batch routed into your direct: the way back to the Bot↔Bot message it came from. */
		sourceLabel?: string | null;
		onOpenSource?: () => void;
		/** Why the last status change on this batch did not go through. */
		error?: string | null;
	}

	let { annotations, t, locale, bots, onOpen, onToggleStatus, sourceLabel = null, onOpenSource, error = null }: Props = $props();
</script>

<div class="annot-cards mt-6 flex flex-col gap-4" data-annotation-cards>
	{#if sourceLabel}
		<button type="button" class="annot-source text-11" onclick={() => onOpenSource?.()}>{sourceLabel}</button>
	{/if}
	{#each annotations as row (row.id)}
		{@const stale = staleLabel(t, row, locale)}
		{@const resolver = resolverName(row, bots, t)}
		<div class="annot-card" data-annotation-id={row.id} class:is-resolved={row.status === 'resolved'}>
			<button type="button" class="annot-card-main min-w-0 text-left" onclick={() => onOpen(row)} title={t.chat.annotationOpenFile}>
				<span class="annot-card-file flex items-center gap-4 min-w-0">
					<FileIcon icon={fileIconFor(row.relpath)} size={14} />
					<span class="mono text-11 truncate">{row.relpath}</span>
					<span class="annot-card-pos text-11 truncate">· {positionLabel(row, locale)}</span>
				</span>
				<span class="annot-card-body text-12">{row.body}</span>
				{#if stale}
					<span class="annot-badge is-stale text-10">{stale}</span>
				{/if}
				{#if row.status === 'resolved' && (resolver || row.resolved_note)}
					<span class="annot-card-note text-11">
						{#if resolver}{t.stream.annotationResolvedBy(resolver)}{/if}{#if row.resolved_note}{resolver ? '：' : ''}{row.resolved_note}{/if}
					</span>
				{/if}
			</button>
			{#if row.status !== 'draft' && onToggleStatus}
				<button
					type="button"
					class="annot-badge annot-toggle text-10"
					class:is-open={row.status === 'open'}
					class:is-resolved={row.status === 'resolved'}
					title={row.status === 'open' ? t.stream.annotationResolve : t.stream.annotationReopen}
					onclick={() => onToggleStatus(row, row.status === 'open' ? 'resolved' : 'open')}
				>{statusLabel(t, row.status)}</button>
			{:else}
				<span class="annot-badge text-10" class:is-open={row.status === 'open'} class:is-resolved={row.status === 'resolved'}>{statusLabel(t, row.status)}</span>
			{/if}
		</div>
	{/each}
	{#if error}
		<p class="annot-cards-error text-11 m-0" role="alert">{error}</p>
	{/if}
</div>

<style>
	.annot-card {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 6px 8px;
		border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
		border-radius: 8px;
		background: color-mix(in srgb, currentColor 6%, transparent);
	}
	.annot-card.is-resolved {
		opacity: 0.78;
	}
	.annot-cards-error {
		color: inherit;
		opacity: 0.9;
		text-decoration: underline wavy color-mix(in srgb, currentColor 60%, transparent);
	}
	/* A batch is always your message: on the accent bubble a kind's own tint (TS blue on blue)
	 * can vanish, so the glyph takes the card's text colour. */
	.annot-card-file :global(.file-glyph) {
		color: inherit !important;
	}
	.annot-card-main {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		cursor: pointer;
		font: inherit;
	}
	.annot-card-pos {
		opacity: 0.7;
	}
	.annot-card-body {
		line-height: 1.4;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.annot-card-note {
		opacity: 0.75;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.annot-badge {
		flex-shrink: 0;
		padding: 1px 7px;
		border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
		border-radius: 999px;
		line-height: 16px;
		white-space: nowrap;
		color: inherit;
		background: none;
	}
	.annot-badge.is-open {
		border-color: color-mix(in srgb, var(--accent) 60%, currentColor);
		font-weight: 650;
	}
	.annot-badge.is-resolved {
		opacity: 0.7;
	}
	.annot-badge.is-stale {
		align-self: flex-start;
		border-style: dashed;
		opacity: 0.8;
	}
	.annot-toggle {
		cursor: pointer;
		min-height: 22px;
	}
	.annot-toggle:hover {
		background: color-mix(in srgb, currentColor 10%, transparent);
	}
	.annot-source {
		align-self: flex-start;
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		text-decoration: underline;
		opacity: 0.8;
		cursor: pointer;
	}
	@media (max-width: 680px) {
		.annot-toggle {
			min-height: 30px;
		}
	}
</style>
