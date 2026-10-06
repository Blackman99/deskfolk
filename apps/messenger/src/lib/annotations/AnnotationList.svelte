<script lang="ts">
	import { ANNOTATION_BODY_MAX, type Annotation } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import EmptyState from '../EmptyState.svelte';
	import { compactPositionLabel, filterAnnotations, positionLabel, resolverName, staleLabel, statusLabel, type AnnotationListFilter } from './model.ts';

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
		/** Nothing here can be annotated (no Bot handed the file over): the empty list says so. */
		noTarget?: boolean;
	}

	let { annotations, t, locale, bots, focusId, busy = false, error = null, onReveal, onEdit, onDelete, onToggleStatus, onClose, noTarget = false }: Props = $props();

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
	/** How many rows each state has on this file, whichever tab is showing. */
	const counts = $derived({
		all: annotations.length,
		open: annotations.filter((row) => row.status === 'open').length,
		resolved: annotations.filter((row) => row.status === 'resolved').length,
		draft: annotations.filter((row) => row.status === 'draft').length,
	});
	/** What an empty tab says: why nothing is here, and how something gets here. */
	const empty = $derived.by(() => {
		if (filter === 'open') return { title: t.stream.annotationsEmptyOpen, hint: t.stream.annotationsEmptyOpenHint };
		if (filter === 'resolved') return { title: t.stream.annotationsEmptyResolved, hint: t.stream.annotationsEmptyResolvedHint };
		if (filter === 'draft') return { title: t.stream.annotationsEmptyDraft, hint: t.stream.annotationsEmptyDraftHint };
		return { title: t.stream.annotationsEmpty, hint: noTarget ? t.stream.annotationNoTarget : t.stream.annotationsEmptyHint };
	});

	function markNumber(row: Annotation): number {
		const index = annotations.findIndex((a) => a.id === row.id);
		return index >= 0 ? index + 1 : 1;
	}

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
	<!-- The title and the tabs are one block; the line under it is where the list starts. -->
	<div class="annot-list-top">
		<header class="annot-list-head flex items-center justify-between gap-6">
			<h3 class="annot-list-title text-13 font-semibold m-0">{t.stream.annotationsCount(annotations.length)}</h3>
			{#if onClose}
				<button type="button" class="annot-list-close" title={t.common.close} aria-label={t.common.close} onclick={onClose}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<line x1="18" y1="6" x2="6" y2="18"></line>
						<line x1="6" y1="6" x2="18" y2="18"></line>
					</svg>
				</button>
			{/if}
		</header>
		<div class="annot-filters" role="tablist">
			{#each filters as item}
				<button
					type="button"
					role="tab"
					aria-selected={filter === item.key}
					class="annot-filter"
					class:is-on={filter === item.key}
					onclick={() => (filter = item.key)}
				>
					<!-- Each state keeps its colour wherever it shows: here, on the row, on the file. -->
					{#if item.key !== 'all'}
						<span class="annot-dot" class:is-open={item.key === 'open'} class:is-resolved={item.key === 'resolved'} class:is-draft={item.key === 'draft'} aria-hidden="true"></span>
					{/if}
					<span class="annot-filter-label">{item.label()}</span>
					{#if item.key !== 'all' && counts[item.key] > 0}
						<span class="annot-filter-count">{counts[item.key]}</span>
					{/if}
				</button>
			{/each}
		</div>
	</div>
	{#if error}
		<p class="annot-list-error text-11 m-0">{error}</p>
	{/if}
	{#if shown.length === 0}
		<div class="annot-empty">
			<EmptyState size="inline" level={3} title={empty.title} hint={empty.hint}>
				{#snippet badge()}
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
					</svg>
				{/snippet}
			</EmptyState>
		</div>
	{:else}
		<ol class="annot-items">
			{#each shown as row (row.id)}
				{@const stale = staleLabel(t, row, locale)}
				{@const resolver = resolverName(row, bots, t)}
				<li class="annot-item" class:is-focus={focusId === row.id} class:is-resolved={row.status === 'resolved'} class:is-draft={row.status === 'draft'} data-annotation-id={row.id}>
					<button type="button" class="annot-item-main text-left min-w-0" onclick={() => onReveal(row)} aria-pressed={focusId === row.id} title={focusId === row.id ? t.stream.annotationDeselect : t.stream.annotationGoTo}>
						<div class="annot-item-head flex items-center justify-between gap-4">
							<div class="annot-item-target flex items-center gap-4 min-w-0">
								<span class="annot-mark-num" class:is-open={row.status === 'open'} class:is-resolved={row.status === 'resolved'} class:is-draft={row.status === 'draft'}>
									{markNumber(row)}
								</span>
								{#if row.anchor_kind === 'image_region'}
									<svg class="annot-kind-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<rect x="3" y="3" width="18" height="18" rx="2"></rect>
										<circle cx="9" cy="9" r="2"></circle>
										<path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"></path>
									</svg>
								{:else if row.anchor_kind === 'text_range'}
									<svg class="annot-kind-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<line x1="4" y1="6" x2="20" y2="6"></line>
										<line x1="4" y1="12" x2="14" y2="12"></line>
										<line x1="4" y1="18" x2="18" y2="18"></line>
									</svg>
								{:else if row.anchor_kind === 'pdf_region'}
									<svg class="annot-kind-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
										<polyline points="14 2 14 8 20 8"></polyline>
									</svg>
								{:else if row.anchor_kind === 'html_element'}
									<svg class="annot-kind-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<polyline points="16 18 22 12 16 6"></polyline>
										<polyline points="8 6 2 12 8 18"></polyline>
									</svg>
								{:else if row.anchor_kind === 'media_time'}
									<svg class="annot-kind-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<circle cx="12" cy="12" r="10"></circle>
										<polyline points="12 6 12 12 16 14"></polyline>
									</svg>
								{/if}
								<span class="annot-item-pos mono text-11 truncate" title={positionLabel(row, locale)}>{compactPositionLabel(row, locale)}</span>
							</div>
							<span class="annot-chip" class:is-open={row.status === 'open'} class:is-resolved={row.status === 'resolved'} class:is-draft={row.status === 'draft'}>
								<span class="annot-dot" class:is-open={row.status === 'open'} class:is-resolved={row.status === 'resolved'} class:is-draft={row.status === 'draft'} aria-hidden="true"></span>
								{statusLabel(t, row.status)}
							</span>
						</div>
						{#if editingId !== row.id}
							<span class="annot-item-body text-12">{row.body}</span>
						{/if}
					</button>
					{#if editingId === row.id}
						<div class="annot-item-edit flex flex-col gap-4">
							<!-- svelte-ignore a11y_autofocus -->
							<textarea class="annot-textarea" rows="3" maxlength={ANNOTATION_BODY_MAX} bind:value={editBody} autofocus onkeydown={(ev) => onEditKey(ev, row)}></textarea>
							<div class="flex gap-4 justify-end">
								<button type="button" class="artifact-tool-btn annot-btn" onclick={() => commitEdit(row)} disabled={busy || !editBody.trim()}>{t.stream.annotationSaveDraft}</button>
								<button type="button" class="artifact-tool-btn annot-btn" onclick={() => (editingId = null)}>{t.stream.annotationCancel}</button>
							</div>
						</div>
					{/if}
					{#if stale}
						<div class="annot-stale-banner flex items-center gap-4 text-11">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path>
								<line x1="12" y1="9" x2="12" y2="13"></line>
								<line x1="12" y1="17" x2="12.01" y2="17"></line>
							</svg>
							<span class="annot-stale-text">{stale}</span>
						</div>
					{/if}
					{#if row.status === 'resolved' && (resolver || row.resolved_note)}
						<div class="annot-item-note text-11 flex items-start gap-4">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="flex-shrink-0 mt-2">
								<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
								<polyline points="22 4 12 14.01 9 11.01"></polyline>
							</svg>
							<span class="annot-note-text">{#if resolver}{t.stream.annotationResolvedBy(resolver)}{/if}{#if row.resolved_note}{resolver ? '：' : ''}{row.resolved_note}{/if}</span>
						</div>
					{/if}
					<div class="annot-item-actions flex items-center justify-end gap-4">
						{#if row.status === 'draft'}
							<button type="button" class="artifact-tool-btn annot-btn" onclick={() => startEdit(row)} disabled={busy}>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
									<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
								</svg>
								<span>{t.stream.annotationEdit}</span>
							</button>
							<button type="button" class="artifact-tool-btn annot-btn is-danger" onclick={() => onDelete(row)} disabled={busy}>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<polyline points="3 6 5 6 21 6"></polyline>
									<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
								</svg>
								<span>{t.stream.annotationDelete}</span>
							</button>
						{:else if row.status === 'open'}
							<button type="button" class="artifact-tool-btn annot-btn annot-btn-resolve" onclick={() => onToggleStatus(row, 'resolved')} disabled={busy}>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<polyline points="20 6 9 17 4 12"></polyline>
								</svg>
								<span>{t.stream.annotationResolve}</span>
							</button>
						{:else}
							<button type="button" class="artifact-tool-btn annot-btn annot-btn-reopen" onclick={() => onToggleStatus(row, 'open')} disabled={busy}>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
									<path d="M21 3v5h-5"></path>
									<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>
									<path d="M3 21v-5h5"></path>
								</svg>
								<span>{t.stream.annotationReopen}</span>
							</button>
						{/if}
					</div>
				</li>
			{/each}
		</ol>
	{/if}
</section>

<style>
	/*
	 * A state has one colour wherever it shows — the tab's dot, the row's edge and label, the
	 * numbered mark on the file: 待处理 teal (the file's own marks), 已处理 green, 草稿 grey and
	 * dashed. Being picked is told apart by form, not by that teal: a raised tab, an outlined row.
	 */
	.annot-list {
		border-left: 1px solid var(--line);
		background: var(--pane);
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.annot-list-top {
		flex-shrink: 0;
		border-bottom: 1px solid var(--line);
	}
	.annot-list-head {
		min-height: 48px;
		padding: 10px 8px 8px 14px;
	}
	.annot-list-title {
		color: var(--ink);
		letter-spacing: -0.01em;
	}
	.annot-list-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 0;
		background: none;
		color: var(--muted);
		cursor: pointer;
		border-radius: var(--radius-sm);
		transition: 0.12s ease;
		transition-property: var(--transition-props);
	}
	.annot-list-close:hover {
		background: var(--line-subtle);
		color: var(--ink);
	}
	.annot-filters {
		display: flex;
		gap: 2px;
		margin: 0 12px 12px;
		padding: 3px;
		background: var(--line-subtle);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
	}
	/* Widths follow the labels, so 全部 gives its room to the tabs that carry a dot and a count. */
	.annot-filter {
		flex: 1 1 auto;
		min-width: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		min-height: 26px;
		padding: 0 6px;
		border: 0;
		border-radius: calc(var(--radius-md) - 3px);
		background: transparent;
		color: var(--muted);
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		white-space: nowrap;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}
	.annot-filter:hover:not(.is-on) {
		color: var(--ink);
	}
	.annot-filter.is-on {
		background: var(--pane);
		color: var(--ink);
		font-weight: 600;
		box-shadow: var(--shadow-xs);
	}
	.annot-filter-label {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.annot-filter-count {
		color: var(--muted);
		font-size: 10px;
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}
	.annot-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
		background: var(--annot-state);
	}
	.annot-dot.is-draft {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--annot-state);
	}
	.is-open {
		--annot-state: var(--accent);
	}
	.is-resolved {
		--annot-state: var(--ok);
	}
	.is-draft {
		--annot-state: var(--muted);
	}
	.annot-list-error {
		padding: 8px 16px 0;
		color: var(--danger);
	}
	.annot-empty {
		flex: 1;
		min-height: 0;
		overflow: auto;
		display: flex;
	}
	.annot-items {
		flex: 1;
		min-height: 0;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 0;
		padding: 12px 12px 16px;
		list-style: none;
	}
	.annot-item {
		--annot-state: var(--accent);
		position: relative;
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
		transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
		overflow: hidden;
	}
	/* The row's state, down its left edge, readable at a glance down the list. */
	.annot-item::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		width: 3px;
		background: var(--annot-state);
	}
	.annot-item:hover {
		border-color: var(--line-hover);
	}
	.annot-item.is-focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 1.5px var(--accent-glow), var(--shadow-xs);
	}
	.annot-item.is-resolved {
		--annot-state: var(--ok);
		background: var(--bg);
	}
	.annot-item.is-draft {
		--annot-state: var(--muted-light);
		border-style: dashed;
	}
	.annot-item-main {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px 12px 8px 15px;
		border: 0;
		background: none;
		color: var(--ink);
		cursor: pointer;
		font: inherit;
		width: 100%;
	}
	.annot-item-main:focus-visible {
		outline: none;
	}
	.annot-item-head {
		width: 100%;
	}
	.annot-item-target {
		flex: 1;
	}
	.annot-mark-num {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 18px;
		height: 18px;
		padding: 0 4px;
		border-radius: var(--radius-full);
		font-size: 10px;
		font-weight: 700;
		line-height: 1;
		flex-shrink: 0;
		border: 1px solid var(--line);
		background: var(--btn-secondary-bg);
		color: var(--muted);
	}
	.annot-mark-num.is-open {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}
	.annot-mark-num.is-resolved {
		background: var(--ok-bg);
		border-color: var(--ok-line);
		color: var(--ok-text);
	}
	.annot-mark-num.is-draft {
		border-style: dashed;
		background: var(--input-bg);
		color: var(--muted);
	}
	.annot-kind-icon {
		flex-shrink: 0;
		color: var(--muted);
	}
	.annot-item-pos {
		color: var(--muted);
	}
	.annot-item-body {
		font-size: 13px;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--ink);
	}
	.annot-item.is-resolved .annot-item-body {
		color: var(--ink-secondary);
	}
	.annot-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		flex-shrink: 0;
		padding: 0 8px;
		height: 20px;
		border-radius: var(--radius-full);
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
		background: var(--line-subtle);
	}
	.annot-chip.is-open {
		color: var(--accent);
		background: var(--accent-tint);
	}
	.annot-chip.is-resolved {
		color: var(--ok-text);
		background: var(--ok-bg);
	}
	.annot-chip.is-draft {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--line);
	}
	.annot-stale-banner {
		margin: 0 12px 8px 15px;
		padding: 4px 8px;
		border-radius: var(--radius-sm);
		background: var(--warn-bg);
		border: 1px solid var(--warn-line);
		color: var(--warn-text);
	}
	.annot-item-note {
		margin: 0 12px 8px 15px;
		padding: 6px 8px;
		border-radius: var(--radius-sm);
		background: var(--line-subtle);
		color: var(--ink-secondary);
		line-height: 1.45;
	}
	.annot-item-note svg {
		color: var(--ok);
	}
	.annot-note-text {
		white-space: pre-wrap;
		word-break: break-word;
	}
	.annot-item-actions {
		padding: 6px 12px 6px 15px;
		border-top: 1px solid var(--line-subtle);
	}
	.annot-item-edit {
		padding: 0 12px 8px 15px;
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
	.annot-textarea:focus {
		outline: none;
		border-color: var(--accent);
	}
	.annot-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-height: 26px;
		padding: 0 9px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--btn-secondary-bg);
		color: var(--ink-secondary);
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		transition: 0.12s ease;
		transition-property: var(--transition-props);
		white-space: nowrap;
	}
	.annot-btn:hover:not(:disabled) {
		border-color: var(--line-hover);
		color: var(--ink);
		background: var(--btn-secondary-hover);
	}
	.annot-btn.annot-btn-resolve:hover:not(:disabled) {
		border-color: var(--ok-line);
		background: var(--ok-bg);
		color: var(--ok-text);
	}
	.annot-btn.annot-btn-reopen:hover:not(:disabled) {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}
	.annot-btn.is-danger:hover:not(:disabled) {
		border-color: var(--danger-line);
		background: var(--danger-bg);
		color: var(--danger-text);
	}
	.annot-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	@media (max-width: 680px) {
		.annot-list {
			border-left: 0;
			border-top: 1px solid var(--line);
		}
		.annot-btn,
		.annot-filter {
			min-height: 32px;
		}
	}
</style>
