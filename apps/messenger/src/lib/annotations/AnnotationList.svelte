<script lang="ts">
	import type { Annotation } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { filterAnnotations, positionLabel, resolverName, staleLabel, statusLabel, type AnnotationListFilter } from './model.ts';

	interface Props {
		/** This file's annotations, in reading order. */
		annotations: Annotation[];
		t: Copy;
		locale: 'zh' | 'en';
		bots: ReadonlyMap<string, { name: string }>;
		focusId: string | null;
		busy?: boolean;
		error?: string | null;
		onReveal: (row: Annotation) => void;
		onEdit: (row: Annotation, body: string) => void;
		onDelete: (row: Annotation) => void;
		onToggleStatus: (row: Annotation, status: 'open' | 'resolved') => void;
		onClose?: () => void;
	}

	let { annotations, t, locale, bots, focusId, busy = false, error = null, onReveal, onEdit, onDelete, onToggleStatus, onClose }: Props = $props();

	let filter = $state<AnnotationListFilter>('all');
	let editingId = $state<string | null>(null);
	let editBody = $state('');
	const shown = $derived(filterAnnotations(annotations, filter));
	const filters: Array<{ key: AnnotationListFilter; label: () => string }> = [
		{ key: 'all', label: () => t.stream.annotationsFilterAll },
		{ key: 'open', label: () => t.stream.annotationsFilterOpen },
		{ key: 'resolved', label: () => t.stream.annotationsFilterResolved },
		{ key: 'draft', label: () => t.stream.annotationsFilterDraft },
	];

	function startEdit(row: Annotation): void {
		editingId = row.id;
		editBody = row.body;
	}

	function commitEdit(row: Annotation): void {
		const body = editBody.trim();
		if (body && body !== row.body) onEdit(row, body);
		editingId = null;
	}

	function onEditKey(ev: KeyboardEvent, row: Annotation): void {
		if (ev.key === 'Escape') {
			ev.preventDefault();
			ev.stopPropagation();
			editingId = null;
		} else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
			ev.preventDefault();
			commitEdit(row);
		}
	}
</script>

<section class="annot-list flex flex-col min-h-0" aria-label={t.stream.annotationsTitle} data-annotation-list>
	<header class="annot-list-head flex items-center gap-6 px-8 py-6">
		<h3 class="text-12 font-semibold m-0 flex-1">{t.stream.annotationsCount(annotations.length)}</h3>
		{#if onClose}
			<button type="button" class="annot-list-close" title={t.common.close} onclick={onClose}>✕</button>
		{/if}
	</header>
	<div class="annot-filters flex flex-wrap gap-4 px-8 pb-6" role="tablist">
		{#each filters as item}
			<button
				type="button"
				role="tab"
				aria-selected={filter === item.key}
				class="annot-filter text-11"
				class:is-on={filter === item.key}
				onclick={() => (filter = item.key)}
			>{item.label()}</button>
		{/each}
	</div>
	{#if error}
		<p class="annot-list-error text-11 px-8 pb-4 m-0">{error}</p>
	{/if}
	<ol class="annot-items flex-1 min-h-0 overflow-auto m-0 p-0 px-8 pb-8">
		{#if shown.length === 0}
			<li class="annot-empty text-12 py-8">{t.stream.annotationsEmpty}</li>
		{/if}
		{#each shown as row (row.id)}
			{@const stale = staleLabel(t, row, locale)}
			{@const resolver = resolverName(row, bots, t)}
			<li class="annot-item" class:is-focus={focusId === row.id} class:is-resolved={row.status === 'resolved'} data-annotation-id={row.id}>
				<button type="button" class="annot-item-main text-left min-w-0" onclick={() => onReveal(row)} title={t.stream.annotationGoTo}>
					<span class="annot-item-pos mono text-11 truncate">{positionLabel(row, locale)}</span>
					{#if editingId !== row.id}
						<span class="annot-item-body text-12">{row.body}</span>
					{/if}
				</button>
				{#if editingId === row.id}
					<div class="annot-item-edit flex flex-col gap-4">
						<!-- svelte-ignore a11y_autofocus -->
						<textarea class="annot-textarea" rows="3" bind:value={editBody} autofocus onkeydown={(ev) => onEditKey(ev, row)}></textarea>
						<div class="flex gap-4">
							<button type="button" class="artifact-tool-btn annot-btn" onclick={() => commitEdit(row)} disabled={busy || !editBody.trim()}>{t.stream.annotationSaveDraft}</button>
							<button type="button" class="artifact-tool-btn annot-btn" onclick={() => (editingId = null)}>{t.stream.annotationCancel}</button>
						</div>
					</div>
				{/if}
				<div class="annot-item-meta flex flex-wrap items-center gap-4">
					<span class="annot-chip text-10" class:is-open={row.status === 'open'} class:is-draft={row.status === 'draft'}>{statusLabel(t, row.status)}</span>
					{#if stale}<span class="annot-chip is-stale text-10">{stale}</span>{/if}
					{#if row.status === 'resolved' && (resolver || row.resolved_note)}
						<span class="annot-item-note text-11">{#if resolver}{t.stream.annotationResolvedBy(resolver)}{/if}{#if row.resolved_note}{resolver ? '：' : ''}{row.resolved_note}{/if}</span>
					{/if}
				</div>
				<div class="annot-item-actions flex flex-wrap gap-4">
					{#if row.status === 'draft'}
						<button type="button" class="artifact-tool-btn annot-btn" onclick={() => startEdit(row)} disabled={busy}>{t.stream.annotationEdit}</button>
						<button type="button" class="artifact-tool-btn annot-btn is-danger" onclick={() => onDelete(row)} disabled={busy}>{t.stream.annotationDelete}</button>
					{:else if row.status === 'open'}
						<button type="button" class="artifact-tool-btn annot-btn" onclick={() => onToggleStatus(row, 'resolved')} disabled={busy}>{t.stream.annotationResolve}</button>
					{:else}
						<button type="button" class="artifact-tool-btn annot-btn" onclick={() => onToggleStatus(row, 'open')} disabled={busy}>{t.stream.annotationReopen}</button>
					{/if}
				</div>
			</li>
		{/each}
	</ol>
</section>

<style>
	.annot-list {
		border-left: 1px solid var(--line);
		background: var(--pane);
	}
	.annot-list-head {
		border-bottom: 1px solid var(--line);
	}
	.annot-list-close {
		width: 28px;
		height: 28px;
		border: 0;
		background: none;
		color: var(--muted);
		cursor: pointer;
		border-radius: var(--radius-sm);
	}
	.annot-list-close:hover {
		background: var(--line-subtle);
		color: var(--ink);
	}
	.annot-filter {
		padding: 2px 8px;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--btn-secondary-bg);
		color: var(--ink);
		cursor: pointer;
	}
	.annot-filter.is-on {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}
	.annot-list-error {
		color: var(--danger);
	}
	.annot-items {
		list-style: none;
	}
	.annot-empty {
		color: var(--muted);
	}
	.annot-item {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 8px 8px 8px 10px;
		margin-bottom: 6px;
		border: 1px solid var(--line);
		border-left: 3px solid var(--accent);
		border-radius: var(--radius-md);
		background: var(--pane);
	}
	.annot-item.is-resolved {
		border-left-color: var(--line-hover);
		opacity: 0.85;
	}
	.annot-item.is-focus {
		box-shadow: 0 0 0 2px var(--accent-border);
	}
	.annot-item-main {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 0;
		border: 0;
		background: none;
		color: var(--ink);
		cursor: pointer;
		font: inherit;
	}
	.annot-item-pos {
		color: var(--muted);
	}
	.annot-item-body {
		line-height: 1.4;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.annot-item-note {
		color: var(--muted);
		white-space: pre-wrap;
		word-break: break-word;
	}
	.annot-chip {
		padding: 1px 7px;
		border: 1px solid var(--line);
		border-radius: 999px;
		color: var(--muted);
		line-height: 16px;
	}
	.annot-chip.is-open {
		color: var(--accent);
		border-color: var(--accent-border);
		background: var(--accent-tint);
	}
	.annot-chip.is-draft {
		border-style: dashed;
	}
	.annot-chip.is-stale {
		border-style: dashed;
	}
	.annot-textarea {
		width: 100%;
		resize: vertical;
		padding: 6px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink);
		font: inherit;
		font-size: 12px;
	}
	.annot-btn {
		min-height: 24px;
	}
	.annot-btn.is-danger {
		color: var(--danger);
	}
	@media (max-width: 680px) {
		.annot-list {
			border-left: 0;
			border-top: 1px solid var(--line);
		}
		.annot-btn,
		.annot-filter {
			min-height: 34px;
		}
	}
</style>
