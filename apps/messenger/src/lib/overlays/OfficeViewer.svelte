<script lang="ts">
	import { untrack } from 'svelte';
	import type { Copy } from '../copy.ts';
	import { themeManager } from '../theme.ts';
	import { pageCspNonce } from './artifacts.ts';
	import { holdFullscreenPreview } from './fullscreen-preview.ts';
	import { checkOfficeArchive, OFFICE_MAX_BYTES, type OfficeKind } from './office/archive.ts';
	import { slideForKey, slideZoom } from './office/slides.ts';
	import { columnName, readSpreadsheet, type Spreadsheet } from './office/spreadsheet.ts';

	interface Props {
		data: Blob;
		kind: OfficeKind;
		title: string;
		labels: Copy['stream']['office'];
	}
	let { data, kind, title, labels }: Props = $props();
	let host = $state<HTMLElement | null>(null);
	let rootEl = $state<HTMLElement | null>(null);
	let fullButton = $state<HTMLButtonElement | null>(null);
	let enlarged = $state(false);
	let phase = $state<'loading' | 'ready' | 'error' | 'limit'>('loading');
	let book = $state<Spreadsheet | null>(null);
	let sheetIndex = $state(0);
	let slideIndex = $state(0);
	let slideCount = $state(0);
	let busy = $state(false);
	let retry = $state(0);
	let viewer: import('@aiden0z/pptx-renderer').PptxViewer | null = null;
	const sheet = $derived(book?.sheets[sheetIndex]);
	// Props arrive through getters: a pane rebuilds the object it hands its path down in whenever
	// another pane switches conversations, so `title` fires again with the same path. The document
	// is rebuilt only when one of these really changes.
	const file = $derived(data);
	const fileKind = $derived(kind);
	const fileName = $derived(title);

	function exitFull() {
		enlarged = false;
		fullButton?.focus({ preventScroll: true });
	}

	/**
	 * The frame runs no script, so nothing can listen for keys pressed in it — not even a listener
	 * added from here. In full screen it hands focus back to the layer, on the next task (in the
	 * same one WebKit keeps the keys in the frame), and the layer does what the frame did: Escape
	 * leaves, and scrolling and copying go to the document.
	 */
	function documentFrameEl(): HTMLIFrameElement | null {
		return host?.querySelector('iframe') ?? null;
	}

	function reclaimFocus() {
		const frame = documentFrameEl();
		if (!frame || document.activeElement !== frame) return;
		setTimeout(() => {
			if (enlarged && document.activeElement === frame) rootEl?.focus({ preventScroll: true });
		}, 0);
	}

	function copyFromFrame(event: ClipboardEvent) {
		if (document.activeElement !== rootEl) return;
		const text = documentFrameEl()?.contentDocument?.getSelection()?.toString() ?? '';
		if (!text || !event.clipboardData) return;
		event.clipboardData.setData('text/plain', text);
		event.preventDefault();
	}

	function scrollFrame(event: KeyboardEvent): boolean {
		if (document.activeElement !== rootEl || event.metaKey || event.ctrlKey || event.altKey) return false;
		const view = documentFrameEl()?.contentWindow;
		if (!view) return false;
		const page = view.innerHeight * 0.9;
		const steps: Record<string, number> = {
			ArrowDown: 40, ArrowUp: -40, PageDown: page, PageUp: -page, ' ': event.shiftKey ? -page : page
		};
		if (event.key === 'Home') view.scrollTo({ top: 0 });
		else if (event.key === 'End') view.scrollTo({ top: view.document.documentElement.scrollHeight });
		else if (event.key in steps) view.scrollBy({ top: steps[event.key] });
		else return false;
		return true;
	}

	/** A presentation in full screen turns its pages the way a slide show does. */
	function slideKey(event: KeyboardEvent): boolean {
		if (fileKind !== 'presentation' || phase !== 'ready' || event.metaKey || event.ctrlKey || event.altKey) return false;
		const next = slideForKey(event.key, slideIndex, slideCount);
		if (next === null) return false;
		if (next !== slideIndex) void slide(next);
		return true;
	}

	function onFullscreenKey(event: KeyboardEvent) {
		if (!enlarged) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopImmediatePropagation();
			exitFull();
		} else if (slideKey(event) || scrollFrame(event)) event.preventDefault();
	}

	$effect(() => {
		const root = rootEl;
		if (!root || !enlarged) return;
		// The top layer escapes transformed panes without moving or reloading the iframe.
		root.setAttribute('popover', 'manual');
		try {
			root.showPopover();
		} catch {
			root.removeAttribute('popover');
			enlarged = false;
			return;
		}
		const releaseBack = holdFullscreenPreview(exitFull);
		window.addEventListener('keydown', onFullscreenKey, true);
		window.addEventListener('blur', reclaimFocus);
		document.addEventListener('copy', copyFromFrame);
		reclaimFocus();
		return () => {
			releaseBack();
			window.removeEventListener('keydown', onFullscreenKey, true);
			window.removeEventListener('blur', reclaimFocus);
			document.removeEventListener('copy', copyFromFrame);
			root.hidePopover();
			root.removeAttribute('popover');
		};
	});

	$effect(() => {
		const target = host;
		const blob = file;
		const format = fileKind;
		const name = fileName;
		retry;
		if (!target) return;
		const abort = new AbortController();
		let ownViewer: typeof viewer = null;
		let stopTheme: (() => void) | null = null;
		let sizes: ResizeObserver | null = null;
		untrack(() => {
			enlarged = false;
			phase = 'loading'; book = null; sheetIndex = 0; slideIndex = 0; slideCount = 0; busy = false;
		});
		void (async () => {
			try {
				if (blob.size > OFFICE_MAX_BYTES) throw new Error('office-limit');
				const bytes = await blob.arrayBuffer();
				if (abort.signal.aborted) return;
				checkOfficeArchive(bytes, format);
				if (format === 'spreadsheet') {
					const result = await readSpreadsheet(bytes);
					if (abort.signal.aborted) return;
					book = result;
				} else {
					const { documentFrame, localOfficeData, paintOfficeFill } = await import('./office/document.ts');
					if (abort.signal.aborted) return;
					const root = await documentFrame(target, name, abort.signal);
					if (abort.signal.aborted) return;
					const frameDocument = root.ownerDocument;
					stopTheme = themeManager.subscribe(() => paintOfficeFill(frameDocument, target));
					const local = localOfficeData(bytes);
					if (format === 'word') {
						const { parseAsync, renderDocument } = await import('docx-preview');
						if (abort.signal.aborted) return;
						const options = {
							ignoreWidth: true, ignoreHeight: true, ignoreFonts: true,
							useBase64URL: true, renderAltChunks: false,
							renderComments: false, renderChanges: false
						};
						const doc = await parseAsync(local, options);
						if (abort.signal.aborted) return;
						const nodes = await renderDocument(doc, options);
						if (abort.signal.aborted) return;
						const nonce = pageCspNonce();
						for (const node of nodes) {
							if (nonce && node instanceof HTMLStyleElement) node.nonce = nonce;
							root.appendChild(node);
						}
					} else {
						const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import('@aiden0z/pptx-renderer');
						if (abort.signal.aborted) return;
						// The renderer's own fit follows the width only, so a wide pane or a full screen cut
						// the slide off or left the space under it. The scale here fits both sides; the
						// frame centres what is left over.
						frameDocument.documentElement.classList.add('slides');
						const current = new PptxViewer(root, {
							fitMode: 'none', zipLimits: RECOMMENDED_ZIP_LIMITS,
							lazySlides: true, lazyMedia: true, pdfjs: false
						});
						ownViewer = current;
						await current.open(local, { renderMode: 'slide', signal: abort.signal });
						if (abort.signal.aborted) { current.destroy(); return; }
						viewer = current;
						slideCount = current.slideCount;
						sizes = new ResizeObserver(() => {
							const zoom = slideZoom(
								{ width: root.clientWidth, height: root.clientHeight },
								{ width: current.slideWidth, height: current.slideHeight }
							);
							if (zoom !== null) current.setZoom(zoom).catch(() => {});
						});
						sizes.observe(target);
					}
				}
				if (!abort.signal.aborted) phase = 'ready';
			} catch (error) {
				if (abort.signal.aborted) return;
				ownViewer?.destroy(); viewer = null; target.replaceChildren();
				phase = error instanceof Error && error.message === 'office-limit' ? 'limit' : 'error';
			}
		})();
		return () => {
			abort.abort(); sizes?.disconnect(); ownViewer?.destroy(); stopTheme?.();
			if (viewer === ownViewer) viewer = null;
			target.replaceChildren();
		};
	});

	async function slide(next: number) {
		const current = viewer;
		if (!current || busy || next < 0 || next >= slideCount) return;
		busy = true;
		try {
			await current.goToSlide(next);
			if (viewer === current) slideIndex = next;
		} catch {
			if (viewer === current) phase = 'error';
		} finally {
			if (viewer === current) busy = false;
		}
	}
</script>

<section class="office-viewer" class:is-enlarged={enlarged} bind:this={rootEl} tabindex="-1" aria-label={title} aria-busy={phase === 'loading'}>
	<div class="office-toolbar">
		<span class="office-type">{kind === 'word' ? 'Word' : kind === 'spreadsheet' ? 'Excel' : 'PowerPoint'}</span>
		<span class="office-readonly">{labels.readOnly}</span>
		{#if enlarged}<span class="office-filename" title={title}>{title}</span>{/if}
		<div class="office-actions">
			{#if phase === 'ready' && kind === 'presentation' && slideCount > 0}
				<div class="office-pages">
					<button type="button" aria-label={labels.previous} disabled={busy || slideIndex === 0} onclick={() => slide(slideIndex - 1)}>‹</button>
					<span aria-live="polite">{slideIndex + 1} / {slideCount}</span>
					<button type="button" aria-label={labels.next} disabled={busy || slideIndex === slideCount - 1} onclick={() => slide(slideIndex + 1)}>›</button>
				</div>
			{/if}
			<button
				type="button" class="office-full" bind:this={fullButton}
				aria-label={enlarged ? labels.exitFull : labels.fullscreen}
				title={enlarged ? labels.exitFull : labels.fullscreen}
				aria-pressed={enlarged}
				onclick={() => enlarged ? exitFull() : (enlarged = true)}
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					{#if enlarged}<path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6"></path>
					{:else}<path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6"></path>{/if}
				</svg>
			</button>
		</div>
	</div>
	{#if phase === 'loading'}
		<p class="office-status" role="status">{labels.loading}</p>
	{:else if phase === 'error' || phase === 'limit'}
		<div class="office-status" role="alert">
			<p>{phase === 'limit' ? labels.tooLarge : labels.failed}</p>
			{#if phase === 'error'}<button type="button" onclick={() => retry++}>{labels.retry}</button>{/if}
		</div>
	{/if}
	<div class="office-document" class:hidden={kind === 'spreadsheet' || phase !== 'ready'} bind:this={host}></div>
	{#if phase === 'ready' && kind === 'spreadsheet'}
		{#if book && book.sheets.length > 0}
			<div class="office-sheets" aria-label={labels.sheets}>
				{#each book.sheets as tab, index}
					<button type="button" aria-pressed={sheetIndex === index} onclick={() => sheetIndex = index}>{tab.name}</button>
				{/each}
			</div>
			{#if book.truncated || sheet?.truncated}<p class="office-notice">{labels.truncated}</p>{/if}
			{#if sheet && sheet.rows.length > 0 && sheet.columns > 0}
				{#key sheetIndex}
					<div class="office-grid" role="region" aria-label={sheet.name}>
						<table>
							<thead><tr><th aria-label={labels.row}></th>{#each Array(sheet.columns) as _, index}<th scope="col">{columnName(index)}</th>{/each}</tr></thead>
							<tbody>{#each sheet.rows as row}<tr><th scope="row">{row.number}</th>{#each row.cells as cell}<td>{cell}</td>{/each}</tr>{/each}</tbody>
						</table>
					</div>
				{/key}
			{:else}<p class="office-status">{labels.emptySheet}</p>{/if}
		{:else}<p class="office-status">{labels.empty}</p>{/if}
	{:else if phase === 'ready' && kind === 'presentation' && slideCount === 0}
		<p class="office-status">{labels.empty}</p>
	{/if}
	<p class="office-notice">{kind === 'spreadsheet' ? labels.sheetHint : labels.layoutHint}</p>
</section>

<style>
	.office-viewer { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 320px; min-width: 0; overflow: hidden; background: var(--pane); color: var(--ink); }
	.office-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; flex: none; min-height: 40px; padding: 6px 10px; border-bottom: 1px solid var(--line); }
	.office-viewer.is-enlarged { position: fixed; inset: 0; width: 100%; height: 100dvh; max-width: none; max-height: none; min-height: 0; margin: 0; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); border: 0; box-sizing: border-box; }
	.office-viewer::backdrop { background: var(--pane); }
	/* Only ever focused by hand-back from the document, never from the keyboard. */
	.office-viewer:focus { outline: none; }
	.office-filename { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 12px; }
	.office-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
	.office-full { display: grid; place-items: center; min-width: 36px; min-height: 36px; padding: 6px; flex: none; }
	.office-viewer.is-enlarged .office-document { min-height: 0; }
	.office-type { font-size: 12px; font-weight: 600; }
	.office-readonly { font-size: 11px; color: var(--muted); }
	.office-pages { display: flex; align-items: center; gap: 8px; margin-left: auto; font-size: 12px; font-variant-numeric: tabular-nums; }
	button { border: 1px solid var(--line); border-radius: 5px; padding: 6px 10px; background: var(--pane); color: var(--ink); cursor: pointer; font: inherit; font-size: 12px; }
	button:disabled { opacity: .4; cursor: default; }
	button:focus-visible, .office-grid:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
	.office-pages button { min-width: 32px; min-height: 32px; font-size: 20px; padding: 0; }
	.office-document { position: relative; flex: 1; min-height: 240px; overflow: hidden; }
	.office-document :global(iframe) { position: absolute; inset: 0; }
	.hidden { visibility: hidden; height: 0; min-height: 0; flex: none; }
	.office-status { margin: 0; padding: 24px 16px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
	.office-sheets { display: flex; gap: 4px; flex: none; overflow-x: auto; padding: 8px; border-bottom: 1px solid var(--line); }
	.office-sheets button { flex: none; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.office-sheets button[aria-pressed='true'] { color: var(--accent); border-color: var(--accent); background: var(--accent-tint); }
	.office-grid { flex: 1; min-height: 0; overflow: auto; }
	table { border-collapse: separate; border-spacing: 0; font-size: 12px; min-width: 100%; }
	th, td { padding: 6px 10px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); vertical-align: top; }
	td { min-width: 100px; max-width: 360px; white-space: pre-wrap; overflow-wrap: anywhere; }
	th { background: var(--bg); color: var(--muted); font-weight: 500; text-align: center; font-variant-numeric: tabular-nums; }
	thead th { position: sticky; top: 0; z-index: 2; }
	tbody th { position: sticky; left: 0; z-index: 1; }
	.office-notice { margin: 0; padding: 7px 10px; flex: none; font-size: 11px; line-height: 1.5; color: var(--muted); border-top: 1px solid var(--line-subtle); }
</style>
