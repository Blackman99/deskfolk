<script lang="ts">
	import { ANNOTATION_BODY_MAX, type Annotation } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
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
	<header class="annot-list-head flex items-center justify-between gap-6 px-8 py-6">
		<h3 class="annot-list-title text-13 font-semibold m-0">{t.stream.annotationsCount(annotations.length)}</h3>
		{#if onClose}
			<button type="button" class="annot-list-close" title={t.common.close} aria-label={t.common.close} onclick={onClose}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<line x1="18" y1="6" x2="6" y2="18"></line>
					<line x1="6" y1="6" x2="18" y2="18"></line>
				</svg>
			</button>
		{/if}
	</header>
	<div class="annot-filters px-8 pb-6" role="tablist">
		<div class="annot-filter-group">
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
	</div>
	{#if error}
		<p class="annot-list-error text-11 px-8 pb-4 m-0">{error}</p>
	{/if}
	<ol class="annot-items flex-1 min-h-0 overflow-auto m-0 p-0 px-8 pb-8">
		{#if shown.length === 0}
			<li class="annot-empty flex flex-col items-center justify-center text-center py-16 px-8 gap-4">
				<div class="annot-empty-icon">
					<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
					</svg>
				</div>
				<p class="text-12 font-medium m-0">{t.stream.annotationsEmpty}</p>
			</li>
		{/if}
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
						<span class="annot-chip text-10" class:is-open={row.status === 'open'} class:is-resolved={row.status === 'resolved'} class:is-draft={row.status === 'draft'}>{statusLabel(t, row.status)}</span>
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
					<div class="annot-stale-banner flex items-center gap-4 text-10">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path>
							<line x1="12" y1="9" x2="12" y2="13"></line>
							<line x1="12" y1="17" x2="12.01" y2="17"></line>
						</svg>
						<span class="annot-chip is-stale text-10">{stale}</span>
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
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<polyline points="20 6 9 17 4 12"></polyline>
							</svg>
							<span>{t.stream.annotationResolve}</span>
						</button>
					{:else}
						<button type="button" class="artifact-tool-btn annot-btn annot-btn-reopen" onclick={() => onToggleStatus(row, 'open')} disabled={busy}>
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
</section>

<style>
	.annot-list {
		border-left: 1px solid var(--line);
		background: var(--pane);
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.annot-list-head {
		border-bottom: 1px solid var(--line);
	}
	.annot-list-title {
		color: var(--ink);
		letter-spacing: -0.01em;
	}
	.annot-list-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border: 0;
		background: none;
		color: var(--muted);
		cursor: pointer;
		border-radius: var(--radius-sm);
		transition: all 0.12s ease;
	}
	.annot-list-close:hover {
		background: var(--line-subtle);
		color: var(--ink);
	}
	.annot-filters {
		display: flex;
	}
	.annot-filter-group {
		display: flex;
		width: 100%;
		padding: 2px;
		background: var(--line-subtle);
		border-radius: var(--radius-sm);
		border: 1px solid var(--line);
	}
	.annot-filter {
		flex: 1;
		padding: 3px 0;
		border: 0;
		border-radius: calc(var(--radius-sm) - 2px);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		font-weight: 500;
		text-align: center;
		transition: all 0.15s ease;
		white-space: nowrap;
	}
	.annot-filter:hover:not(.is-on) {
		color: var(--ink);
	}
	.annot-filter.is-on {
		background: var(--pane);
		color: var(--accent);
		font-weight: 600;
		box-shadow: var(--shadow-xs);
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
	.annot-empty-icon {
		color: var(--muted-light);
	}
	.annot-item {
		display: flex;
		flex-direction: column;
		margin-bottom: 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
		transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
		overflow: hidden;
	}
	.annot-item:hover {
		border-color: var(--line-hover);
	}
	.annot-item.is-focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 1.5px var(--accent-glow), var(--shadow-xs);
	}
	.annot-item.is-resolved {
		background: var(--bg);
		opacity: 0.9;
	}
	.annot-item.is-draft {
		border-style: dashed;
	}
	.annot-item-main {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px 10px 6px 10px;
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
		border-radius: 999px;
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
		line-height: 1.45;
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--ink);
	}
	.annot-item.is-resolved .annot-item-body {
		color: var(--ink-secondary);
	}
	.annot-stale-banner {
		margin: 0 10px 6px 10px;
		padding: 3px 6px;
		border-radius: var(--radius-sm);
		background: var(--warn-bg);
		border: 1px solid var(--warn-line);
		color: var(--warn-text);
	}
	.annot-item-note {
		margin: 0 10px 6px 10px;
		padding: 4px 8px;
		border-radius: var(--radius-sm);
		background: var(--line-subtle);
		color: var(--muted);
		line-height: 1.4;
	}
	.annot-note-text {
		white-space: pre-wrap;
		word-break: break-word;
	}
	.annot-chip {
		flex-shrink: 0;
		padding: 1px 7px;
		border: 1px solid var(--line);
		border-radius: 999px;
		color: var(--muted);
		line-height: 16px;
		font-weight: 500;
	}
	.annot-chip.is-open {
		color: var(--accent);
		border-color: var(--accent-border);
		background: var(--accent-tint);
	}
	.annot-chip.is-resolved {
		color: var(--ok-text);
		border-color: var(--ok-line);
		background: var(--ok-bg);
	}
	.annot-chip.is-draft {
		border-style: dashed;
	}
	.annot-chip.is-stale {
		border: 0;
		padding: 0;
		color: inherit;
		background: transparent;
	}
	.annot-item-actions {
		padding: 4px 10px 6px 10px;
		border-top: 1px solid var(--line-subtle);
		background: color-mix(in srgb, var(--pane) 95%, var(--ink) 5%);
	}
	.annot-item.is-resolved .annot-item-actions {
		background: color-mix(in srgb, var(--bg) 95%, var(--ink) 5%);
	}
	.annot-item-edit {
		padding: 0 10px 8px 10px;
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
		min-height: 24px;
		padding: 0 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--btn-secondary-bg);
		color: var(--ink-secondary);
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.12s ease;
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
