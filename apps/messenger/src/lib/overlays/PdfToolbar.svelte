<script lang="ts">
	import { ZOOM_PRESETS, zoomIn, zoomMenuValue, zoomOut, zoomPercent } from '../annotations/pdf-region.ts';
	import type { PdfFind } from './pdf-find.svelte.ts';
	import type { PdfPages } from './pdf-pages.svelte.ts';
	import type { PdfViewerLabels } from './PdfViewer.svelte';

	interface Props {
		labels: PdfViewerLabels;
		pages: PdfPages;
		find: PdfFind;
	}

	let { labels, pages, find }: Props = $props();

	let customZoom = $derived(
		pages.zoomMode.kind === 'scale' && !(ZOOM_PRESETS as readonly number[]).includes(pages.zoomMode.value) ? pages.zoomMode.value : null
	);
</script>

<div class="pdf-toolbar" data-annotator-bar>
	<button type="button" class="pdf-tool" title={labels.zoomOut} aria-label={labels.zoomOut} onclick={() => pages.setZoom(zoomOut(pages.zoom))} data-pdf-zoom-out>−</button>
	<select class="pdf-zoom" aria-label={labels.zoom} value={zoomMenuValue(pages.zoomMode)} onchange={pages.onZoomMenu} data-pdf-zoom>
		<option value="fit-width">{pages.zoomMode.kind === 'fit-width' ? `${labels.fitWidth} · ${zoomPercent(pages.zoom)}` : labels.fitWidth}</option>
		<option value="fit-page">{pages.zoomMode.kind === 'fit-page' ? `${labels.fitPage} · ${zoomPercent(pages.zoom)}` : labels.fitPage}</option>
		{#each ZOOM_PRESETS as preset (preset)}
			<option value={String(preset)}>{zoomPercent(preset)}</option>
		{/each}
		{#if customZoom !== null}
			<option value={String(customZoom)}>{zoomPercent(customZoom)}</option>
		{/if}
	</select>
	<button type="button" class="pdf-tool" title={labels.zoomIn} aria-label={labels.zoomIn} onclick={() => pages.setZoom(zoomIn(pages.zoom))} data-pdf-zoom-in>+</button>
	<span class="pdf-sep" aria-hidden="true"></span>
	<input
		class="pdf-page-input"
		type="text"
		inputmode="numeric"
		aria-label={labels.pageNumber}
		bind:value={pages.pageInput}
		oninput={() => (pages.pageInputFocused = true)}
		onkeydown={pages.onPageKey}
		onfocus={(ev) => {
			pages.pageInputFocused = true;
			(ev.currentTarget as HTMLInputElement).select();
		}}
		onblur={() => {
			pages.pageInputFocused = false;
			pages.commitPageInput();
		}}
		data-pdf-page-input
	/>
	<span class="pdf-page-total text-12">{labels.pageCount(pages.numPages)}</span>
	<span class="flex-1"></span>
	<button
		type="button"
		class="pdf-tool"
		class:is-on={find.findOpen}
		title={labels.find}
		aria-label={labels.find}
		aria-pressed={find.findOpen}
		onclick={() => (find.findOpen ? find.closeFind() : find.openFind())}
		data-pdf-find-toggle
	>
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
			<circle cx="11" cy="11" r="7"></circle>
			<line x1="20" y1="20" x2="16.2" y2="16.2"></line>
		</svg>
	</button>
</div>
{#if find.findOpen}
	<div class="pdf-find" role="search">
		<input
			class="pdf-find-input"
			type="search"
			placeholder={labels.findPlaceholder}
			aria-label={labels.find}
			bind:this={find.findInput}
			bind:value={find.findQuery}
			oninput={() => find.queueFind()}
			onkeydown={find.onFindKey}
			data-pdf-find-input
		/>
		<span class="pdf-find-count text-12" aria-live="polite">{find.findStatus}</span>
		<button type="button" class="pdf-tool" title={labels.findPrev} aria-label={labels.findPrev} disabled={find.matches.length === 0} onclick={() => find.stepFind(-1)}>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 15 12 9 18 15"></polyline></svg>
		</button>
		<button type="button" class="pdf-tool" title={labels.findNext} aria-label={labels.findNext} disabled={find.matches.length === 0} onclick={() => find.stepFind(1)}>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
		</button>
		<button type="button" class="pdf-tool" title={labels.findClose} aria-label={labels.findClose} onclick={() => find.closeFind()}>✕</button>
	</div>
{/if}

<style>
	.pdf-toolbar,
	.pdf-find {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 8px;
		background: var(--pane);
		border-bottom: 1px solid var(--line);
		flex-wrap: wrap;
	}

	.pdf-tool {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 26px;
		height: 26px;
		padding: 0 6px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--btn-secondary-bg);
		color: var(--ink);
		font: inherit;
		font-size: 13px;
		line-height: 1;
		cursor: pointer;
	}

	.pdf-tool:hover:not(:disabled) {
		background: var(--btn-secondary-hover);
	}

	.pdf-tool:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.pdf-tool.is-on {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.pdf-zoom, .pdf-page-input, .pdf-find-input {
		height: 26px;
		padding: 0 6px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink);
		font: inherit;
		font-size: 12px;
	}

	.pdf-zoom {
		max-width: 150px;
	}

	.pdf-page-input {
		width: 44px;
		text-align: center;
	}

	.pdf-find-input {
		flex: 1;
		min-width: 120px;
	}

	.pdf-zoom:focus-visible, .pdf-page-input:focus-visible, .pdf-find-input:focus-visible {
		outline: 2px solid var(--accent-border);
		outline-offset: 0;
	}

	.pdf-page-total,
	.pdf-find-count {
		color: var(--muted);
		white-space: nowrap;
	}

	.pdf-find-count {
		min-width: 48px;
		text-align: right;
	}

	.pdf-sep {
		width: 1px;
		height: 16px;
		margin: 0 4px;
		background: var(--line);
	}

	@media (max-width: 680px) {
		.pdf-tool, .pdf-zoom, .pdf-page-input, .pdf-find-input {
			min-height: 40px;
		}

		.pdf-tool {
			min-width: 40px;
		}

		.pdf-page-input {
			width: 52px;
		}
	}
</style>
