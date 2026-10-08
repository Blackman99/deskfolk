<!--
	PDF 预览（#27）：用 pdf.js 自己画，不再交给系统查看器的 iframe，这样才能在页面上批注。连续滚动、缩放
	（适合宽度 / 适合页面 / 百分比 / ±、⌘+ ⌘− ⌘0、触控板捏合）、跳页、查找（⌘F，文字层里高亮，Esc 关）、
	文字可选可复制、页内链接、深色下白纸暗底；页面按需画（IntersectionObserver，占位按页尺寸），画过的页
	按数量和像素回收。批注：批注模式下在页上拖框（点一下是小框），框里压到的文字作引文；待写意见的框能挪、
	能拖角改大小，Esc 取消；已有批注在各自页上按顺序编号，三种状态三种样子，陈旧的虚线，页已不在的不画。
-->
<script lang="ts" module>
	import type { PdfRegionAnchor } from '@real-bot/protocol';
	import type { EncodedCrop } from '../annotations/region-box.ts';

	/** Everything this viewer says; the preview passes it in from `copy.ts`. */
	export type PdfViewerLabels = {
		/** While pdf.js reads the file. */
		loading: string;
		/** The file could not be opened for a reason other than the two below. */
		failed: string;
		/** pdf.js says the file is not a readable PDF. */
		broken: string;
		/** The file is encrypted: asks for its password. */
		password: string;
		passwordWrong: string;
		passwordField: string;
		passwordOpen: string;
		zoomIn: string;
		zoomOut: string;
		/** The zoom menu's name, for a screen reader. */
		zoom: string;
		fitWidth: string;
		fitPage: string;
		/** The page-number box's name. */
		pageNumber: string;
		/** After the page-number box: how many pages there are. */
		pageCount: (total: number) => string;
		find: string;
		findPlaceholder: string;
		findPrev: string;
		findNext: string;
		findClose: string;
		/** Which match is selected, of how many. */
		findCount: (current: number, total: number) => string;
		findNone: string;
		findSearching: string;
		/** A link to another place in the document. */
		goTo: string;
		/** Hover text on a page while annotate mode is on. */
		region: string;
		/** A drawn annotation's badge, for a screen reader: its number and its remark. */
		mark: (n: number, remark: string) => string;
		/** Hover text on the box waiting for its remark. */
		pending: string;
		/** Hover text on that box's corner handles. */
		resize: string;
		/** Added under the remark on a mark whose file has changed since. */
		stale: string;
	};

	/** What a finished pick hands the preview: the anchor, and how to cut its crop when saving. */
	export type PdfRegionDraft = { anchor: PdfRegionAnchor; crop?: () => Promise<EncodedCrop | null> };
</script>

<script lang="ts">
	import type { Annotation } from '@real-bot/protocol';
	import { untrack } from 'svelte';
	import { openExternalLink } from '../open-link.ts';
	import {
		boxBetween,
		clickBox,
		cropDrawable,
		cropRect,
		isClick,
		isUsableBox,
		moveBox,
		resizeBox,
		toNorm,
		toPercentStyle,
		type DrawnRect,
		type Handle,
		type NormBox,
		type NormPoint,
	} from '../annotations/region-box.ts';
	import {
		PDF_TO_CSS_UNITS,
		anchorFromBox,
		boxOfAnchor,
		grabbedPoint,
		handleCorner,
		nudgeBox,
		pdfMarks,
		quoteInBox,
		scrollTopForPoint,
		zoomIn,
		zoomOut,
		type PdfMark,
	} from '../annotations/pdf-region.ts';
	import { PdfPages } from './pdf-pages.svelte.ts';
	import { PdfFind } from './pdf-find.svelte.ts';
	import PdfToolbar from './PdfToolbar.svelte';
	import PdfPageMarks from './PdfPageMarks.svelte';

	interface Props {
		/** The PDF's bytes. A new blob opens a new document. */
		data: Blob;
		/** Dark keeps the pages white-ish on a dark gutter. */
		theme: 'light' | 'dark';
		labels: PdfViewerLabels;
		/** This file's pdf_region rows, in display order: drawn numbered 1..n. */
		annotations: Annotation[];
		/** Scroll to this one and flash it. */
		focusId: string | null;
		/** Bumped on every request to go to `focusId`, so the one already focused is revealed again. */
		focusSeq?: number;
		/** Annotate mode: a drag or a click on a page makes a box. */
		active: boolean;
		/** Whether a new box may be made at all; existing ones are drawn either way. */
		enabled: boolean;
		/** A box was chosen; the preview opens the composer and calls `crop()` on save. */
		onDraft: (draft: PdfRegionDraft) => void;
		/** A click on an existing mark. */
		onPick: (id: string) => void;
		/** The anchor awaiting its remark: drawn with handles, movable and resizable. */
		pending?: PdfRegionAnchor | null;
		onPendingChange?: (anchor: PdfRegionAnchor) => void;
		/** Escape while choosing, or with a box pending. */
		onCancel?: () => void;
	}

	let {
		data,
		theme,
		labels,
		annotations,
		focusId,
		focusSeq = 0,
		active,
		enabled,
		onDraft,
		onPick,
		pending = null,
		onPendingChange,
		onCancel,
	}: Props = $props();

	const pages = new PdfPages({
		data: () => data,
		scroller: () => scroller,
		onTextReady: (n) => void find.paintPage(n),
		onReset: () => {
			find.reset();
			endGesture();
			localPending = null;
			revealedId = null;
		}
	});
	const find = new PdfFind({
		pages,
		labels: () => labels,
		rootEl: () => rootEl,
		scroller: () => scroller
	});

	const FLASH_MS = 1400;
	const PEEK_DELAY_MS = 500;
	const PEEK_SHOW_MS = 3000;
	/** A crop is cut from the page drawn at twice its 100% size. */
	const CROP_SCALE = 2;

	/**
	 * A drag on one page's overlay. `overlay` is measured again on every move, so a page that
	 * scrolls under the pointer mid-drag keeps the box under it; `from` is the screen point it
	 * started at, to tell a click from a drag.
	 */
	type GestureBase = { page: number; pointerId: number; overlay: HTMLElement; from: { x: number; y: number } };
	type Gesture =
		| (GestureBase & { kind: 'new'; start: NormPoint; box: NormBox })
		| (GestureBase & { kind: 'move'; start: NormPoint; origin: NormBox; box: NormBox })
		| (GestureBase & { kind: 'resize'; handle: Handle; grab: NormPoint; origin: NormBox; box: NormBox });

	let rootEl = $state<HTMLDivElement | undefined>(undefined);
	let scroller = $state<HTMLDivElement | undefined>(undefined);

	let gesture = $state.raw<Gesture | null>(null);
	/** The pending box as this component last drew it, until the `pending` prop catches up. */
	let localPending = $state.raw<{ page: number; box: NormBox } | null>(null);
	let flashId = $state<string | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | null = null;
	let peekId = $state<string | null>(null);
	let peekTimer: ReturnType<typeof setTimeout> | null = null;
	let peekHold: ReturnType<typeof setTimeout> | null = null;
	let peeked = false;
	let revealedId: string | null = null;
	/** The request `revealedId` answered: the same id asked for again is revealed again. */
	let revealedSeq = 0;

	let marks = $derived(pdfMarks(annotations, pages.numPages));
	let marksByPage = $derived.by(() => {
		const byPage = new Map<number, PdfMark[]>();
		for (const mark of marks) {
			const list = byPage.get(mark.page);
			if (list) list.push(mark);
			else byPage.set(mark.page, [mark]);
		}
		return byPage;
	});
	let pendingShown = $derived.by((): { page: number; box: NormBox } | null => {
		const g = gesture;
		if (g && (g.kind === 'move' || g.kind === 'resize')) return { page: g.page, box: g.box };
		if (localPending) return localPending;
		return pending ? { page: pending.page, box: boxOfAnchor(pending) } : null;
	});
	let choosing = $derived(active && enabled && !pending);

	/** Open the find bar (⌘F), seeded with the text selected in the viewer. */
	export function openFind(): void {
		find.openFind();
	}

	/** Close the find bar; false when it was not open (so Escape can go on to close the pane). */
	export function closeFind(): boolean {
		return find.closeFind();
	}

	export function isFindOpen(): boolean {
		return find.isFindOpen();
	}

	// ── Annotations ────────────────────────────────────────────────────────────────────────────

	$effect(() => {
		// The preview took the new anchor: stop drawing our own copy of it.
		void pending;
		untrack(() => {
			localPending = null;
		});
	});

	$effect(() => {
		const id = focusId;
		const seq = focusSeq;
		const ready = pages.status === 'ready' && pages.sizes.length > 0;
		// Waits for the row too: the focus can arrive before the rows that hold it (a list click that
		// opens the file), and a focus spent on nothing would never scroll once they came.
		const drawnMark = id ? marks.some((m) => m.id === id) : false;
		if (!id) {
			revealedId = null;
			return;
		}
		// The marks and the layout are read above, so a snapshot runs this again: only a new request reveals.
		if (!ready || !drawnMark || (id === revealedId && seq === revealedSeq)) return;
		revealedId = id;
		revealedSeq = seq;
		untrack(() => revealAnnotation(id));
	});

	/** Scroll to one annotation and flash it. Does nothing for a row that is not drawn. */
	export function revealAnnotation(id: string): void {
		const mark = marks.find((m) => m.id === id);
		const el = scroller;
		if (!mark || !el) return;
		const i = mark.page - 1;
		const top = pages.layout.tops[i]! + mark.box.y * pages.layout.heights[i]!;
		const bottom = top + mark.box.h * pages.layout.heights[i]!;
		if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) {
			el.scrollTop = scrollTopForPoint(pages.layout, mark.page, mark.box.y, el.clientHeight);
		}
		const node = pages.pageEl(mark.page);
		if (node && pages.layout.widths[i]! > el.clientWidth) {
			const x = node.offsetLeft + (mark.box.x + mark.box.w / 2) * pages.layout.widths[i]!;
			el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
		}
		// Read the new spot now, not on the scroll event: pages measured meanwhile re-anchor to it.
		pages.onScroll();
		flashId = id;
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flashId = null), FLASH_MS);
	}

	/** The crop for an anchor: its page drawn at 2×, the box cut out with a 10% margin. */
	export async function cropAnchor(target: PdfRegionAnchor): Promise<EncodedCrop | null> {
		const source = pages.doc;
		if (!source) return null;
		try {
			const page = await source.page(target.page);
			const canvas = await page.snapshot(CROP_SCALE);
			if (!canvas) return null;
			try {
				return await cropDrawable(canvas, cropRect(boxOfAnchor(target), { width: canvas.width, height: canvas.height }));
			} finally {
				canvas.width = 0;
				canvas.height = 0;
			}
		} catch {
			return null;
		}
	}

	async function quoteFor(n: number, region: NormBox): Promise<string> {
		const source = pages.doc;
		if (!source) return '';
		try {
			return quoteInBox(await (await source.page(n)).textRuns(), region);
		} catch {
			return '';
		}
	}

	/** The draft handed over last, and where its box is now: its crop follows the box however it moved. */
	let draftRef: { anchor: PdfRegionAnchor } | null = null;

	async function emitDraft(n: number, region: NormBox): Promise<void> {
		const gen = pages.docGen;
		const quote = await quoteFor(n, region);
		// Another file, or annotate mode switched off, while the quote was read.
		if (gen !== pages.docGen || !choosing) return;
		const anchorNow = anchorFromBox(n, region, quote);
		if (!anchorNow) return;
		const ref = { anchor: anchorNow };
		draftRef = ref;
		// The crop reads the box as it is when the remark is saved, after any moving — even when
		// the preview has already let go of `pending` by then. Nothing once another file is open.
		onDraft({ anchor: anchorNow, crop: () => (gen === pages.docGen ? cropAnchor(pending ?? ref.anchor) : Promise.resolve(null)) });
	}

	async function emitPendingChange(n: number, region: NormBox): Promise<void> {
		localPending = { page: n, box: region };
		const gen = pages.docGen;
		const quote = await quoteFor(n, region);
		if (gen !== pages.docGen) return;
		const next = anchorFromBox(n, region, quote);
		if (!next) return;
		if (draftRef) draftRef.anchor = next;
		onPendingChange?.(next);
	}

	function overlayRect(el: Element): DrawnRect {
		const r = el.getBoundingClientRect();
		return { left: r.left, top: r.top, width: r.width, height: r.height };
	}

	/**
	 * The pressed element keeps the pointer (so the text layer and links under a drag stay quiet);
	 * the window hears the moves and the release, which it does with or without that capture —
	 * a release outside the window, or a browser that will not capture, cannot strand a drag.
	 */
	function beginGesture(ev: PointerEvent, next: Gesture): void {
		gesture = next;
		try {
			(ev.currentTarget as HTMLElement | null)?.setPointerCapture?.(ev.pointerId);
		} catch {
			// Synthetic pointers (tests) have nothing to capture; the window listeners carry the drag.
		}
		listenGesture(true);
	}

	function listenGesture(on: boolean): void {
		if (typeof window === 'undefined') return;
		if (on) {
			window.addEventListener('pointermove', onGestureMove);
			window.addEventListener('pointerup', onGestureUp);
			window.addEventListener('pointercancel', onGestureCancel);
		} else {
			window.removeEventListener('pointermove', onGestureMove);
			window.removeEventListener('pointerup', onGestureUp);
			window.removeEventListener('pointercancel', onGestureCancel);
		}
	}

	function endGesture(): Gesture | null {
		const g = gesture;
		gesture = null;
		listenGesture(false);
		return g;
	}

	function onOverlayDown(ev: PointerEvent, n: number): void {
		if (!choosing || gesture || ev.button !== 0) return;
		const overlay = ev.currentTarget as HTMLElement;
		const start = toNorm(ev.clientX, ev.clientY, overlayRect(overlay));
		ev.preventDefault();
		pages.focusScroller();
		beginGesture(ev, { kind: 'new', page: n, pointerId: ev.pointerId, overlay, from: { x: ev.clientX, y: ev.clientY }, start, box: { ...start, w: 0, h: 0 } });
	}

	function onPendingDown(ev: PointerEvent, n: number, region: NormBox, handle: Handle | null): void {
		if (gesture || ev.button !== 0) return;
		const overlay = (ev.currentTarget as HTMLElement).closest<HTMLElement>('.pdf-marks');
		if (!overlay) return;
		ev.preventDefault();
		ev.stopPropagation();
		pages.focusScroller();
		const at = toNorm(ev.clientX, ev.clientY, overlayRect(overlay));
		const base = { page: n, pointerId: ev.pointerId, overlay, from: { x: ev.clientX, y: ev.clientY }, origin: region, box: region };
		if (handle) {
			const corner = handleCorner(region, handle);
			beginGesture(ev, { ...base, kind: 'resize', handle, grab: { x: corner.x - at.x, y: corner.y - at.y } });
		} else beginGesture(ev, { ...base, kind: 'move', start: at });
	}

	/** Where the gesture's box is with the pointer at a screen point. */
	function gestureBox(g: Gesture, clientX: number, clientY: number): NormBox {
		const at = toNorm(clientX, clientY, overlayRect(g.overlay));
		if (g.kind === 'new') return boxBetween(g.start, at);
		if (g.kind === 'move') return moveBox(g.origin, at.x - g.start.x, at.y - g.start.y);
		return resizeBox(g.origin, g.handle, grabbedPoint(at, g.grab));
	}

	function onGestureMove(ev: PointerEvent): void {
		const g = gesture;
		if (!g || ev.pointerId !== g.pointerId) return;
		gesture = { ...g, box: gestureBox(g, ev.clientX, ev.clientY) };
	}

	function onGestureUp(ev: PointerEvent): void {
		const g = gesture;
		if (!g || ev.pointerId !== g.pointerId) return;
		endGesture();
		const click = isClick(g.from, { x: ev.clientX, y: ev.clientY });
		if (g.kind === 'new') {
			// Annotate mode went off (or a box became pending) mid-drag: nothing to hand over.
			if (!choosing) return;
			const dragged = gestureBox(g, ev.clientX, ev.clientY);
			const size = pages.sizes[g.page - 1];
			const region = click || !isUsableBox(dragged) ? (size ? clickBox(g.start, size) : null) : dragged;
			if (region && isUsableBox(region)) void emitDraft(g.page, region);
			return;
		}
		// A press on the box or a handle that did not move leaves it where it was.
		if (click) return;
		const next = gestureBox(g, ev.clientX, ev.clientY);
		const same = next.x === g.origin.x && next.y === g.origin.y && next.w === g.origin.w && next.h === g.origin.h;
		if (!same && isUsableBox(next)) void emitPendingChange(g.page, next);
	}

	function onGestureCancel(ev: PointerEvent): void {
		if (gesture && ev.pointerId === gesture.pointerId) endGesture();
	}

	function onPendingKey(ev: KeyboardEvent, n: number, region: NormBox): void {
		const next = nudgeBox(region, ev.key, ev.shiftKey);
		if (!next) return;
		ev.preventDefault();
		ev.stopPropagation();
		void emitPendingChange(n, next);
	}

	function onBadgeDown(ev: PointerEvent, id: string): void {
		ev.stopPropagation();
		peeked = false;
		if (peekHold) clearTimeout(peekHold);
		if (ev.pointerType !== 'touch') return;
		// A long press shows the remark, since a touch screen has no hover.
		peekHold = setTimeout(() => {
			peeked = true;
			peekId = id;
			if (peekTimer) clearTimeout(peekTimer);
			peekTimer = setTimeout(() => (peekId = null), PEEK_SHOW_MS);
		}, PEEK_DELAY_MS);
	}

	function onBadgeUp(): void {
		if (peekHold) clearTimeout(peekHold);
		peekHold = null;
	}

	function onBadgeClick(id: string): void {
		if (peeked) {
			peeked = false;
			return;
		}
		onPick(id);
	}

	// ── Keys ───────────────────────────────────────────────────────────────────────────────────

	/** Escape for the annotation half: a drag in progress, then the box pending or being chosen. */
	function escapeAnnotation(): boolean {
		if (gesture) {
			endGesture();
			return true;
		}
		if ((pending || localPending || choosing) && onCancel) {
			localPending = null;
			onCancel();
			return true;
		}
		return false;
	}

	/**
	 * Escape, innermost first: the find bar, a drag in progress, then the box being chosen. True
	 * when it was used here, so the pane does not close; the preview can call it from its own handler.
	 */
	export function handleEscape(): boolean {
		return find.closeFind() || escapeAnnotation();
	}

	/** Choosing a spot, or a box waiting for its remark: Escape is ours wherever focus is. */
	let engaged = $derived(choosing || pending !== null || localPending !== null || gesture !== null);

	// Focus is often outside the viewer while annotating (on the preview's annotate switch, say).
	// The document hears Escape before the shell's window listener that closes the pane; inner
	// surfaces (the composer, the viewer's own find bar) handle theirs first and stop it there.
	$effect(() => {
		if (!engaged || typeof document === 'undefined') return;
		const onDocumentKey = (ev: KeyboardEvent): void => {
			if (ev.key !== 'Escape' || ev.defaultPrevented || ev.isComposing) return;
			if (!escapeAnnotation()) return;
			ev.preventDefault();
			ev.stopPropagation();
		};
		document.addEventListener('keydown', onDocumentKey);
		return () => document.removeEventListener('keydown', onDocumentKey);
	});

	function onKey(ev: KeyboardEvent): void {
		if (ev.key === 'Escape') {
			if (ev.isComposing) return;
			if (handleEscape()) {
				ev.preventDefault();
				ev.stopPropagation();
			}
			return;
		}
		const mod = (ev.metaKey || ev.ctrlKey) && !ev.altKey;
		if (!mod || pages.status !== 'ready') return;
		const key = ev.key.toLowerCase();
		let used = true;
		if (key === 'f' && !ev.shiftKey) find.openFind();
		else if (key === '=' || key === '+') pages.setZoom(zoomIn(pages.zoom));
		else if (key === '-' || key === '_') pages.setZoom(zoomOut(pages.zoom));
		else if (key === '0') pages.zoomMode = { kind: 'fit-width' };
		else used = false;
		if (used) {
			ev.preventDefault();
			ev.stopPropagation();
		}
	}

	$effect(() => () => {
		listenGesture(false);
		if (flashTimer) clearTimeout(flashTimer);
		if (peekTimer) clearTimeout(peekTimer);
		if (peekHold) clearTimeout(peekHold);
		if (find.findTimer) clearTimeout(find.findTimer);
		if (pages.pumpTimer) clearTimeout(pages.pumpTimer);
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="pdf-viewer"
	class:is-choosing={choosing}
	data-pdf-theme={theme}
	style:color-scheme={theme}
	bind:this={rootEl}
	onkeydown={onKey}
>
	{#if pages.status === 'ready'}
		<PdfToolbar {labels} {pages} {find} />
	{/if}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div class="pdf-scroll" bind:this={scroller} tabindex="0" onscroll={pages.onScroll} data-pdf-scroll>
		{#if pages.status === 'loading'}
			<p class="pdf-status" role="status">{labels.loading}</p>
		{:else if pages.status === 'password'}
			<form class="pdf-password" onsubmit={pages.sendPassword} data-pdf-password>
				<p class="pdf-status" class:is-error={pages.passwordWrong}>{pages.passwordWrong ? labels.passwordWrong : labels.password}</p>
				<div class="flex gap-6 items-center">
					<input class="pdf-password-input" type="password" autocomplete="off" aria-label={labels.passwordField} placeholder={labels.passwordField} bind:value={pages.password} />
					<button type="submit" class="pdf-tool pdf-password-open" disabled={!pages.password}>{labels.passwordOpen}</button>
				</div>
			</form>
		{:else if pages.status === 'broken' || pages.status === 'failed'}
			<p class="pdf-status is-error" role="alert" data-pdf-error={pages.status}>{pages.status === 'broken' ? labels.broken : labels.failed}</p>
		{:else}
			<div class="pdf-pages">
				{#each pages.pageNumbers as n (n)}
					{@const size = pages.sizes[n - 1]}
					<div
						class="pdf-page"
						data-page={n}
						style="width:{pages.layout.widths[n - 1]}px;height:{pages.layout.heights[n - 1]}px;--scale-factor:{pages.zoom * PDF_TO_CSS_UNITS};--user-unit:{size?.userUnit ?? 1}"
					>
						<div class="pdf-canvas"></div>
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="pdf-text" onpointerdown={pages.onTextDown}></div>
						{#if pages.links[n]?.length}
							<div class="pdf-links">
								{#each pages.links[n] ?? [] as link, i (i)}
									{#if link.url}
										<a
											class="pdf-link"
											href={link.url}
											target="_blank"
											rel="noopener noreferrer"
											title={link.url}
											aria-label={link.url}
											style={toPercentStyle(link.rect)}
											onclick={(ev) => {
												ev.preventDefault();
												void openExternalLink(link.url ?? '');
											}}
										></a>
									{:else}
										<button type="button" class="pdf-link" title={labels.goTo} aria-label={labels.goTo} style={toPercentStyle(link.rect)} onclick={() => void pages.followLink(link.dest)}></button>
									{/if}
								{/each}
							</div>
						{/if}
						<PdfPageMarks {n} {labels} {choosing} marks={marksByPage.get(n) ?? []} {flashId} {peekId} {gesture} {pendingShown} {onOverlayDown} {onPendingDown} {onPendingKey} {onBadgeDown} {onBadgeUp} {onBadgeClick} />
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.pdf-viewer {
		/* Paper, not chrome: a PDF page is white in both themes, as pdf.js paints it. */
		--pdf-paper: #ffffff;
		position: relative;
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		min-height: 280px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--bg);
		overflow: hidden;
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

	.pdf-password-input {
		height: 26px;
		padding: 0 6px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink);
		font: inherit;
		font-size: 12px;
	}

	.pdf-password-input {
		width: 200px;
		max-width: 60vw;
	}

	.pdf-password-input:focus-visible {
		outline: 2px solid var(--accent-border);
		outline-offset: 0;
	}

	.pdf-scroll {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: auto;
		/* A classic scrollbar coming and going would change the width "fit width" fits, and again. */
		scrollbar-gutter: stable;
		outline: none;
	}

	.pdf-scroll:focus-visible {
		box-shadow: inset 0 0 0 2px var(--accent-border);
	}

	.pdf-status {
		margin: 0;
		padding: 24px 16px;
		text-align: center;
		color: var(--muted);
		font-size: 13px;
	}

	.pdf-status.is-error {
		color: var(--danger);
	}

	.pdf-password {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding-bottom: 24px;
	}

	/* The layout model in pdf-region.ts (`pageLayout`) assumes exactly this: 12px around and between pages. */
	.pdf-pages {
		box-sizing: border-box;
		width: max-content;
		min-width: 100%;
		padding: 12px;
	}

	.pdf-page {
		--total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
		--scale-round-x: 1px;
		--scale-round-y: 1px;
		position: relative;
		margin: 0 auto 12px;
		background: var(--pdf-paper);
		box-shadow: var(--shadow-md);
		direction: ltr;
	}

	.pdf-page:last-child {
		margin-bottom: 0;
	}

	.pdf-canvas {
		position: absolute;
		inset: 0;
		overflow: hidden;
	}

	.pdf-canvas :global(canvas) {
		display: block;
		width: 100%;
		height: 100%;
	}

	.pdf-viewer[data-pdf-theme='dark'] .pdf-canvas {
		filter: brightness(0.92);
	}

	/* pdf.js's text layer (web/pdf_viewer.css, `.textLayer`), trimmed to what this viewer uses. */
	.pdf-text {
		position: absolute;
		inset: 0;
		overflow: clip;
		opacity: 1;
		line-height: 1;
		text-align: initial;
		letter-spacing: normal;
		word-spacing: normal;
		-webkit-text-size-adjust: none;
		text-size-adjust: none;
		forced-color-adjust: none;
		transform-origin: 0 0;
		caret-color: CanvasText;
		color-scheme: only light;
		z-index: 1;
		--min-font-size: 1;
		--text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
		--min-font-size-inv: calc(1 / var(--min-font-size));
	}

	.pdf-text:global([data-main-rotation='90']) {
		transform: rotate(90deg) translateY(-100%);
	}

	.pdf-text:global([data-main-rotation='180']) {
		transform: rotate(180deg) translate(-100%, -100%);
	}

	.pdf-text:global([data-main-rotation='270']) {
		transform: rotate(270deg) translateX(-100%);
	}

	.pdf-text :global(span),
	.pdf-text :global(br) {
		color: transparent;
		position: absolute;
		white-space: pre;
		cursor: text;
		transform-origin: 0% 0%;
		-webkit-user-select: text;
		user-select: text;
	}

	.pdf-text > :global(:not(.markedContent)),
	.pdf-text :global(.markedContent span:not(.markedContent)) {
		z-index: 1;
		--font-height: 0;
		font-size: calc(var(--text-scale-factor) * var(--font-height));
		--scale-x: 1;
		--rotate: 0deg;
		transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
	}

	.pdf-text :global(.markedContent) {
		display: contents;
	}

	.pdf-text :global(::selection) {
		background: color-mix(in srgb, var(--accent) 30%, transparent);
		color: transparent;
	}

	.pdf-text :global(br::selection) {
		background: transparent;
	}

	.pdf-text :global(.endOfContent) {
		display: block;
		position: absolute;
		inset: 100% 0 0;
		z-index: 0;
		cursor: default;
		-webkit-user-select: none;
		user-select: none;
	}

	.pdf-text:global(.is-selecting) :global(.endOfContent) {
		top: 0;
	}

	.pdf-text :global(span.pdf-hl) {
		position: static;
		margin: -1px;
		padding: 1px;
		border-radius: var(--radius-xs);
		background-color: color-mix(in srgb, var(--warn) 38%, transparent);
	}

	.pdf-text :global(span.pdf-hl.is-selected) {
		background-color: color-mix(in srgb, var(--accent) 42%, transparent);
	}

	.pdf-links {
		position: absolute;
		inset: 0;
		z-index: 2;
		pointer-events: none;
	}

	.pdf-link {
		position: absolute;
		display: block;
		padding: 0;
		border: 0;
		border-radius: 2px;
		background: transparent;
		pointer-events: auto;
		cursor: pointer;
	}

	.pdf-link:hover,
	.pdf-link:focus-visible {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		outline: 1px solid var(--accent-border);
	}

	.pdf-viewer.is-choosing .pdf-link {
		pointer-events: none;
	}

	@media (max-width: 680px) {
		.pdf-tool, .pdf-password-input {
			min-height: 40px;
		}

		.pdf-tool {
			min-width: 40px;
		}
	}
</style>
