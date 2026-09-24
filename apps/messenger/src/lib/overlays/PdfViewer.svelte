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
	import { tick, untrack } from 'svelte';
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
		FIND_MATCH_MAX,
		PAGE_GAP,
		PDF_TO_CSS_UNITS,
		ZOOM_PRESETS,
		anchorFromBox,
		boxOfAnchor,
		clampZoom,
		currentPageAt,
		findInText,
		fitBasis,
		findPattern,
		firstMatchFrom,
		grabbedPoint,
		handleCorner,
		highlightPieces,
		matchSegments,
		nudgeBox,
		outputScaleFor,
		pageLayout,
		pageTextIndex,
		parsePageNumber,
		parseZoomMenuValue,
		pdfMarks,
		pickEvictions,
		quoteInBox,
		renderOrder,
		resolveZoom,
		scrollTopForPage,
		scrollTopForPoint,
		stepMatch,
		zoomIn,
		zoomMenuValue,
		zoomOut,
		zoomPercent,
		type PageLayout,
		type PageText,
		type PdfLinkTarget,
		type PdfMark,
		type PdfMatch,
		type ZoomMode,
	} from '../annotations/pdf-region.ts';
	import { openPdf, PdfOpenError, type PdfDocument, type PdfPageSize, type PdfTask, type PdfTextLayer } from './pdfjs.ts';

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

	const HANDLES: Handle[] = ['nw', 'ne', 'sw', 'se'];
	const FLASH_MS = 1400;
	const PEEK_DELAY_MS = 500;
	const PEEK_SHOW_MS = 3000;
	/** A crop is cut from the page drawn at twice its 100% size. */
	const CROP_SCALE = 2;
	/** Rendering waits this long after a zoom, so a pinch does not draw every step of the way. */
	const ZOOM_SETTLE_MS = 120;

	type Status = 'loading' | 'password' | 'ready' | 'broken' | 'failed';
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
	/** One drawn page: its canvas and text layer, at which zoom, and when it was last on screen. */
	type Drawn = {
		page: number;
		zoom: number;
		pixels: number;
		lastUsed: number;
		canvas: HTMLCanvasElement | null;
		text: PdfTextLayer | null;
		textZoom: number;
		failedZoom: number | null;
	};

	let rootEl = $state<HTMLDivElement | undefined>(undefined);
	let scroller = $state<HTMLDivElement | undefined>(undefined);
	let findInput = $state<HTMLInputElement | undefined>(undefined);

	let status = $state<Status>('loading');
	let passwordWrong = $state(false);
	let password = $state('');
	let submitPassword: ((value: string) => void) | null = null;

	let doc: PdfDocument | null = null;
	/** Bumped per opened document: late answers from the previous one are dropped. */
	let docGen = 0;
	let numPages = $state(0);
	let sizes = $state.raw<PdfPageSize[]>([]);
	let zoomMode = $state.raw<ZoomMode>({ kind: 'fit-width' });
	let box = $state.raw({ width: 0, height: 0 });
	let currentPage = $state(1);
	let pageInput = $state('1');
	let pageInputFocused = false;
	let links = $state.raw<Record<number, PdfLinkTarget[]>>({});
	/** Where the reader is, so a zoom keeps the same spot on screen. */
	let anchor: { page: number; frac: number; xFrac: number } | null = null;

	let findOpen = $state(false);
	let findQuery = $state('');
	let matches = $state.raw<PdfMatch[]>([]);
	let matchIndex = $state(-1);
	let findBusy = $state(false);
	let findGen = 0;
	let findTimer: ReturnType<typeof setTimeout> | null = null;

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

	const drawn = new Map<number, Drawn>();
	const near = new Set<number>();
	const pageTexts = new Map<number, Promise<PageText>>();
	/** Text-layer spans that carry find highlights, per page, to put back. */
	const painted = new Map<number, Set<number>>();
	let useClock = 0;
	let pumping = false;
	let pumpAgain = false;
	let pumpTimer: ReturnType<typeof setTimeout> | null = null;
	let inflight: { page: number; zoom: number; task: PdfTask; cancelled: boolean } | null = null;
	let shownZoom = 0;
	/** The layout the scroll position was last read against; a new one (zoom, measured pages) re-anchors it. */
	let shownLayout: PageLayout | null = null;

	let pageNumbers = $derived(Array.from({ length: numPages }, (_, i) => i + 1));
	let basis = $derived(fitBasis(sizes));
	let zoom = $derived.by(() => {
		if (!basis) return 1;
		// Nothing to fit into before the scroller is measured (and never in a test document).
		if (zoomMode.kind !== 'scale' && box.width <= 0) return 1;
		return resolveZoom(zoomMode, basis, box);
	});
	let layout = $derived(pageLayout(sizes, zoom));
	let marks = $derived(pdfMarks(annotations, numPages));
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
	let customZoom = $derived(
		zoomMode.kind === 'scale' && !(ZOOM_PRESETS as readonly number[]).includes(zoomMode.value) ? zoomMode.value : null
	);
	let findStatus = $derived.by(() => {
		if (!findQuery.trim()) return '';
		if (matches.length > 0) return labels.findCount(Math.max(0, matchIndex) + 1, matches.length);
		return findBusy ? labels.findSearching : labels.findNone;
	});

	function pageEl(n: number): HTMLElement | null {
		return scroller?.querySelector<HTMLElement>(`.pdf-page[data-page="${n}"]`) ?? null;
	}

	// ── Opening ────────────────────────────────────────────────────────────────────────────────

	$effect(() => {
		const blob = data;
		const gen = ++docGen;
		untrack(() => resetDocument());
		const opened = openPdf(blob, {
			onPassword: (submit, wrong) => {
				if (gen !== docGen) return;
				submitPassword = submit;
				passwordWrong = wrong;
				password = '';
				status = 'password';
			},
		});
		opened.promise
			.then(async (next) => {
				if (gen !== docGen) {
					next.destroy();
					return;
				}
				doc = next;
				const first = await next.page(1);
				if (gen !== docGen) return;
				sizes = Array.from({ length: next.numPages }, () => first.size);
				numPages = next.numPages;
				status = 'ready';
				void measurePages(next, gen);
			})
			.catch((error: unknown) => {
				if (gen !== docGen) return;
				if (error instanceof PdfOpenError && error.kind === 'cancelled') return;
				status = error instanceof PdfOpenError && error.kind === 'broken' ? 'broken' : 'failed';
			});
		return () => {
			opened.cancel();
			untrack(() => resetDocument());
		};
	});

	/** Every page's own size, in the background: pages start as the first page's size. */
	async function measurePages(source: PdfDocument, gen: number): Promise<void> {
		let next = sizes;
		let changed = false;
		for (let n = 2; n <= source.numPages; n += 1) {
			let size: PdfPageSize;
			try {
				size = (await source.page(n)).size;
			} catch {
				continue;
			}
			if (gen !== docGen) return;
			const was = next[n - 1];
			if (!was || was.width !== size.width || was.height !== size.height || was.userUnit !== size.userUnit) {
				if (!changed) next = [...next];
				next[n - 1] = size;
				changed = true;
			}
			if (changed && (n % 50 === 0 || n === source.numPages)) {
				sizes = next;
				changed = false;
			}
		}
		if (changed && gen === docGen) sizes = next;
	}

	function resetDocument(): void {
		for (const n of [...drawn.keys()]) releasePage(n);
		if (inflight) inflight.task.cancel();
		inflight = null;
		doc?.destroy();
		doc = null;
		near.clear();
		pageTexts.clear();
		painted.clear();
		findGen += 1;
		if (findTimer) clearTimeout(findTimer);
		if (pumpTimer) clearTimeout(pumpTimer);
		submitPassword = null;
		status = 'loading';
		passwordWrong = false;
		numPages = 0;
		sizes = [];
		links = {};
		// A find bar left open over the next file would show the last file's query with no search run.
		findOpen = false;
		matches = [];
		matchIndex = -1;
		findBusy = false;
		currentPage = 1;
		pageInput = '1';
		anchor = null;
		shownZoom = 0;
		shownLayout = null;
		endGesture();
		localPending = null;
		revealedId = null;
	}

	function sendPassword(ev: SubmitEvent): void {
		ev.preventDefault();
		const submit = submitPassword;
		const typed = password;
		if (!submit || !typed) return;
		submitPassword = null;
		// Handed to pdf.js and not kept here: a wrong one asks again with an empty field.
		password = '';
		status = 'loading';
		submit(typed);
	}

	// ── Layout, scrolling, zoom ────────────────────────────────────────────────────────────────

	$effect(() => {
		const el = scroller;
		if (!el) return;
		const measure = () => {
			if (el.clientWidth !== box.width || el.clientHeight !== box.height) box = { width: el.clientWidth, height: el.clientHeight };
		};
		measure();
		if (typeof ResizeObserver !== 'function') return;
		// Measured on the next frame, not inside the observer's callback: a fit-width zoom resizes
		// the pages, which can bring in a scrollbar and resize the scroller again in the same frame
		// ("ResizeObserver loop completed with undelivered notifications"). `scrollbar-gutter` in the
		// stylesheet keeps that from flip-flopping where it is supported.
		let frame = 0;
		const observer = new ResizeObserver(() => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				measure();
			});
		});
		observer.observe(el);
		return () => {
			observer.disconnect();
			if (frame) cancelAnimationFrame(frame);
		};
	});

	/**
	 * Pinch on a trackpad zooms the pages, not the app: Chromium and Firefox send it as Ctrl +
	 * wheel (as is Ctrl/⌘ + a mouse wheel), WebKit — the desktop window — as `gesture*` events
	 * carrying a scale since the pinch began.
	 */
	$effect(() => {
		const el = scroller;
		if (!el) return;
		let pendingFactor = 1;
		let frame = 0;
		/** The zoom a WebKit pinch started from, 0 when none is under way. */
		let pinchBase = 0;
		let pinchTo = 0;
		const apply = (next: number) => {
			const value = clampZoom(Math.round(next * 100) / 100);
			if (value !== zoom) zoomMode = { kind: 'scale', value };
		};
		const onWheel = (ev: WheelEvent) => {
			if (!(ev.ctrlKey || ev.metaKey) || status !== 'ready') return;
			ev.preventDefault();
			// A WebKit pinch may send both; its gesture events already carry the zoom.
			if (pinchBase) return;
			pendingFactor *= Math.exp(-ev.deltaY / 300);
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				const factor = pendingFactor;
				pendingFactor = 1;
				apply(zoom * factor);
			});
		};
		const onPinchStart = (ev: Event) => {
			if (status !== 'ready') return;
			ev.preventDefault();
			pinchBase = zoom;
		};
		const onPinchChange = (ev: Event) => {
			if (!pinchBase) return;
			ev.preventDefault();
			const scale = (ev as Event & { scale?: unknown }).scale;
			if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return;
			pinchTo = pinchBase * scale;
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				if (pinchTo) apply(pinchTo);
			});
		};
		const onPinchEnd = (ev: Event) => {
			if (!pinchBase) return;
			ev.preventDefault();
			if (pinchTo) apply(pinchTo);
			pinchBase = 0;
			pinchTo = 0;
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		el.addEventListener('gesturestart', onPinchStart, { passive: false });
		el.addEventListener('gesturechange', onPinchChange, { passive: false });
		el.addEventListener('gestureend', onPinchEnd, { passive: false });
		return () => {
			el.removeEventListener('wheel', onWheel);
			el.removeEventListener('gesturestart', onPinchStart);
			el.removeEventListener('gesturechange', onPinchChange);
			el.removeEventListener('gestureend', onPinchEnd);
			if (frame) cancelAnimationFrame(frame);
		};
	});

	$effect(() => {
		const z = zoom;
		const l = layout;
		if (status !== 'ready') return;
		untrack(() => {
			const changed = shownZoom !== 0 && z !== shownZoom;
			// Any new layout — a zoom, or pages measured after the first one's size was assumed for
			// them — keeps the page and spot that were on screen where they were.
			if (shownLayout !== null && l !== shownLayout && scroller) restoreAnchor(scroller, l);
			shownLayout = l;
			shownZoom = z;
			if (changed && inflight && inflight.zoom !== z) {
				inflight.cancelled = true;
				inflight.task.cancel();
			}
			schedulePump(changed ? ZOOM_SETTLE_MS : 0);
		});
	});

	function restoreAnchor(el: HTMLElement, l: PageLayout): void {
		const at = anchor;
		if (!at) return;
		const i = at.page - 1;
		if (i < 0 || i >= l.tops.length) return;
		el.scrollTop = Math.max(0, l.tops[i]! + at.frac * l.heights[i]!);
		el.scrollLeft = Math.max(0, at.xFrac * el.scrollWidth - el.clientWidth / 2);
	}

	function onScroll(): void {
		const el = scroller;
		if (!el || layout.tops.length === 0) return;
		let page = currentPageAt(layout, el.scrollTop, el.clientHeight);
		// At the very bottom the last page is the current one, however little of it shows.
		if (el.scrollHeight > el.clientHeight + 1 && el.scrollTop >= el.scrollHeight - el.clientHeight - 1) page = numPages;
		if (page !== currentPage) {
			currentPage = page;
			if (!pageInputFocused) pageInput = String(page);
		}
		const i = page - 1;
		anchor = {
			page,
			frac: (el.scrollTop - layout.tops[i]!) / Math.max(1, layout.heights[i]!),
			xFrac: (el.scrollLeft + el.clientWidth / 2) / Math.max(1, el.scrollWidth),
		};
	}

	function jumpTo(page: number): void {
		const el = scroller;
		if (!el || layout.tops.length === 0) return;
		const n = Math.min(Math.max(1, page), numPages);
		el.scrollTop = scrollTopForPage(layout, n);
		currentPage = n;
		pageInput = String(n);
		anchor = { page: n, frac: -PAGE_GAP / Math.max(1, layout.heights[n - 1]!), xFrac: anchor?.xFrac ?? 0.5 };
	}

	function commitPageInput(): void {
		const n = parsePageNumber(pageInput, numPages);
		if (n === null) pageInput = String(currentPage);
		else jumpTo(n);
	}

	function onPageKey(ev: KeyboardEvent): void {
		if (ev.key !== 'Enter') return;
		ev.preventDefault();
		commitPageInput();
		// Typing is done: scrolling updates the box again, focused or not.
		pageInputFocused = false;
	}

	function setZoom(next: number): void {
		zoomMode = { kind: 'scale', value: clampZoom(next) };
	}

	function onZoomMenu(ev: Event): void {
		const mode = parseZoomMenuValue((ev.currentTarget as HTMLSelectElement).value);
		if (mode) zoomMode = mode;
	}

	function focusScroller(): void {
		try {
			scroller?.focus({ preventScroll: true });
		} catch {
			// Nothing to focus in a detached tree.
		}
	}

	// ── Drawing pages ──────────────────────────────────────────────────────────────────────────

	$effect(() => {
		const root = scroller;
		const count = numPages;
		if (!root || count === 0 || status !== 'ready') return;
		// Before (or without) the observer's first report: the pages around the current one.
		untrack(() => {
			for (let n = Math.max(1, currentPage - 1); n <= Math.min(count, currentPage + 2); n += 1) near.add(n);
		});
		let observer: IntersectionObserver | null = null;
		if (typeof IntersectionObserver === 'function') {
			observer = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						const n = Number((entry.target as HTMLElement).dataset.page);
						if (!Number.isInteger(n)) continue;
						if (entry.isIntersecting) {
							near.add(n);
							const d = drawn.get(n);
							if (d) d.lastUsed = ++useClock;
						} else near.delete(n);
					}
					schedulePump(0);
				},
				{ root, rootMargin: '100% 0px 100% 0px' }
			);
			for (const el of root.querySelectorAll('.pdf-page')) observer.observe(el);
		}
		schedulePump(0);
		return () => observer?.disconnect();
	});

	function schedulePump(delay: number): void {
		if (pumpTimer) clearTimeout(pumpTimer);
		pumpTimer = null;
		if (delay <= 0) {
			void pump();
			return;
		}
		pumpTimer = setTimeout(() => {
			pumpTimer = null;
			void pump();
		}, delay);
	}

	/** Draw the near pages that are not drawn at this zoom, nearest first, one at a time; then let go of far ones. */
	async function pump(): Promise<void> {
		if (pumping) {
			pumpAgain = true;
			return;
		}
		pumping = true;
		try {
			do {
				pumpAgain = false;
				for (;;) {
					const source = doc;
					if (!source || status !== 'ready') break;
					const z = zoom;
					const next = renderOrder(near, currentPage).find((n) => {
						if (n < 1 || n > numPages) return false;
						const d = drawn.get(n);
						return !d || ((d.zoom !== z || !d.canvas) && d.failedZoom !== z);
					});
					if (next === undefined) break;
					await drawPage(source, next, z);
				}
				evictFar();
			} while (pumpAgain);
		} finally {
			pumping = false;
		}
	}

	async function drawPage(source: PdfDocument, n: number, z: number): Promise<void> {
		const gen = docGen;
		const el = pageEl(n);
		if (!el) {
			near.delete(n);
			return;
		}
		let entry = drawn.get(n);
		if (!entry) {
			entry = { page: n, zoom: 0, pixels: 0, lastUsed: ++useClock, canvas: null, text: null, textZoom: 0, failedZoom: null };
			drawn.set(n, entry);
		}
		let page;
		try {
			page = await source.page(n);
		} catch {
			entry.failedZoom = z;
			return;
		}
		if (gen !== docGen || drawn.get(n) !== entry) return;
		const width = Math.max(1, Math.floor(page.size.width * z));
		const height = Math.max(1, Math.floor(page.size.height * z));
		const canvas = document.createElement('canvas');
		canvas.setAttribute('aria-hidden', 'true');
		const task = page.render(canvas, z, outputScaleFor(width, height, window.devicePixelRatio || 1));
		const flight = { page: n, zoom: z, task, cancelled: false };
		inflight = flight;
		try {
			await task.promise;
		} catch {
			canvas.width = 0;
			canvas.height = 0;
			if (!flight.cancelled && drawn.get(n) === entry) entry.failedZoom = z;
			return;
		} finally {
			if (inflight === flight) inflight = null;
		}
		if (gen !== docGen || drawn.get(n) !== entry || flight.cancelled) {
			canvas.width = 0;
			canvas.height = 0;
			return;
		}
		const old = entry.canvas;
		el.querySelector('.pdf-canvas')?.replaceChildren(canvas);
		if (old && old !== canvas) {
			old.width = 0;
			old.height = 0;
		}
		entry.canvas = canvas;
		entry.zoom = z;
		entry.failedZoom = null;
		entry.pixels = canvas.width * canvas.height;
		entry.lastUsed = ++useClock;
		const textEl = el.querySelector<HTMLElement>('.pdf-text');
		if (!entry.text && textEl) {
			textEl.replaceChildren();
			const layer = page.renderText(textEl, z);
			entry.text = layer;
			entry.textZoom = z;
			const owner = entry;
			layer.promise.then(
				() => {
					if (owner.text === layer) void paintPage(n);
				},
				() => {}
			);
		} else if (entry.text && entry.textZoom !== z) {
			try {
				entry.text.update(z);
			} catch {
				// A layer that never finished has nothing to move.
			}
			entry.textZoom = z;
		}
		if (!(n in links)) {
			page.links().then(
				(found) => {
					if (gen === docGen && !(n in links)) links = { ...links, [n]: found };
				},
				() => {}
			);
		}
	}

	function evictFar(): void {
		const rows = [...drawn.values()].filter((d) => d.canvas).map((d) => ({ page: d.page, pixels: d.pixels, lastUsed: d.lastUsed }));
		for (const n of pickEvictions(rows, near)) releasePage(n);
	}

	function releasePage(n: number): void {
		const entry = drawn.get(n);
		if (!entry) return;
		drawn.delete(n);
		if (inflight?.page === n) {
			inflight.cancelled = true;
			inflight.task.cancel();
		}
		entry.text?.cancel();
		if (entry.canvas) {
			entry.canvas.width = 0;
			entry.canvas.height = 0;
		}
		painted.delete(n);
		const el = pageEl(n);
		el?.querySelector('.pdf-canvas')?.replaceChildren();
		el?.querySelector('.pdf-text')?.replaceChildren();
		doc?.page(n).then(
			(page) => page.release(),
			() => {}
		);
	}

	function onTextDown(ev: PointerEvent): void {
		// pdf.js's trick: while selecting, the end-of-content block covers the page so a drag
		// through blank space does not jump the selection to the end of the layer.
		(ev.currentTarget as HTMLElement).classList.add('is-selecting');
		const done = () => {
			scroller?.querySelectorAll('.pdf-text.is-selecting').forEach((el) => el.classList.remove('is-selecting'));
			window.removeEventListener('pointerup', done);
			window.removeEventListener('pointercancel', done);
		};
		window.addEventListener('pointerup', done);
		window.addEventListener('pointercancel', done);
	}

	async function followLink(dest: unknown): Promise<void> {
		const target = await doc?.destinationPage(dest);
		if (target) jumpTo(target);
	}

	// ── Find ───────────────────────────────────────────────────────────────────────────────────

	function textOf(n: number): Promise<PageText> {
		let found = pageTexts.get(n);
		if (!found) {
			const source = doc;
			if (!source) return Promise.reject(new Error('no document'));
			found = source
				.page(n)
				.then((page) => page.textItems())
				.then(pageTextIndex);
			found.catch(() => pageTexts.delete(n));
			pageTexts.set(n, found);
		}
		return found;
	}

	/** Open the find bar (⌘F), seeded with the text selected in the viewer. */
	export function openFind(): void {
		if (status !== 'ready') return;
		const selection = typeof window !== 'undefined' ? window.getSelection?.() : null;
		const picked = selection && rootEl && selection.anchorNode && rootEl.contains(selection.anchorNode) ? selection.toString().trim() : '';
		if (picked && !picked.includes('\n') && picked.length <= 200 && picked !== findQuery) {
			findQuery = picked;
			queueFind(0);
		} else if (!findOpen && findQuery.trim()) {
			// Closing dropped the matches, not the query: search it again rather than say "no match".
			queueFind(0);
		}
		findOpen = true;
		void tick().then(() => {
			findInput?.focus();
			findInput?.select();
		});
	}

	/** Close the find bar; false when it was not open (so Escape can go on to close the pane). */
	export function closeFind(): boolean {
		if (!findOpen) return false;
		findOpen = false;
		findGen += 1;
		if (findTimer) clearTimeout(findTimer);
		findBusy = false;
		matches = [];
		matchIndex = -1;
		paintAll();
		focusScroller();
		return true;
	}

	export function isFindOpen(): boolean {
		return findOpen;
	}

	function queueFind(delay = 150): void {
		if (findTimer) clearTimeout(findTimer);
		// While the typing settles, say "searching", not "no match".
		findBusy = findQuery.trim() !== '';
		findTimer = setTimeout(() => {
			findTimer = null;
			void runFind(findQuery);
		}, delay);
	}

	async function runFind(query: string): Promise<void> {
		const gen = ++findGen;
		const pattern = findPattern(query);
		matches = [];
		matchIndex = -1;
		paintAll();
		if (!pattern || !doc || status !== 'ready') {
			findBusy = false;
			return;
		}
		findBusy = true;
		const start = currentPage;
		const found: PdfMatch[] = [];
		let chosen = false;
		const total = numPages;
		for (let n = 1; n <= total; n += 1) {
			let text: PageText | null = null;
			try {
				text = await textOf(n);
			} catch {
				text = null;
			}
			if (gen !== findGen) return;
			if (text) for (const m of findInText(text.text, pattern, FIND_MATCH_MAX - found.length)) found.push({ page: n, ...m });
			const full = found.length >= FIND_MATCH_MAX;
			if (n % 10 === 0 || n === total || full) {
				matches = [...found];
				if (!chosen && n >= start && found.some((m) => m.page >= start)) {
					chosen = true;
					selectMatch(firstMatchFrom(found, start));
				} else paintAll();
			}
			if (full) break;
		}
		if (gen !== findGen) return;
		if (!chosen && found.length > 0) selectMatch(0);
		findBusy = false;
	}

	function selectMatch(i: number): void {
		matchIndex = i;
		paintAll();
		const m = matches[i];
		if (m) void revealMatch(m);
	}

	function stepFind(direction: 1 | -1): void {
		if (matches.length === 0) {
			if (findQuery.trim()) queueFind(0);
			return;
		}
		selectMatch(stepMatch(matchIndex, matches.length, direction));
	}

	async function revealMatch(m: PdfMatch): Promise<void> {
		const source = doc;
		const el = scroller;
		if (!source || !el) return;
		let rect: NormBox | null = null;
		/** Where along its first run the match starts and ends, 0–1. */
		let from = 0;
		let to = 1;
		try {
			const [text, page] = await Promise.all([textOf(m.page), source.page(m.page)]);
			const first = matchSegments(text, m)[0];
			const runs = await page.textRuns();
			rect = first ? (runs[first.item]?.rect ?? null) : null;
			if (first) {
				const length = Math.max(1, text.lengths[first.item]!);
				from = first.start / length;
				to = first.end / length;
			}
		} catch {
			rect = null;
		}
		if (matches[matchIndex] !== m) return;
		const i = m.page - 1;
		const top = layout.tops[i]! + (rect?.y ?? 0) * layout.heights[i]!;
		const bottom = top + (rect?.h ?? 0) * layout.heights[i]!;
		if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) {
			el.scrollTop = scrollTopForPoint(layout, m.page, rect?.y ?? 0, el.clientHeight);
		}
		const pageNode = pageEl(m.page);
		if (rect && pageNode && layout.widths[i]! > el.clientWidth) {
			const x0 = pageNode.offsetLeft + (rect.x + rect.w * from) * layout.widths[i]!;
			const x1 = pageNode.offsetLeft + (rect.x + rect.w * to) * layout.widths[i]!;
			// The whole match in view, moving no further than that, with a little room around it.
			if (x0 < el.scrollLeft) el.scrollLeft = Math.max(0, x0 - 48);
			else if (x1 > el.scrollLeft + el.clientWidth - 24) {
				el.scrollLeft = Math.max(0, Math.min(x0 - 48, x1 - el.clientWidth + 48));
			}
		}
		onScroll();
	}

	function paintAll(): void {
		for (const n of drawn.keys()) void paintPage(n);
	}

	/** Put the find highlights for one page into its text layer's spans, taking the old ones out. */
	async function paintPage(n: number): Promise<void> {
		const entry = drawn.get(n);
		const layer = entry?.text;
		if (!layer) return;
		const hasOld = (painted.get(n)?.size ?? 0) > 0;
		const onPage = findOpen && matches.some((m) => m.page === n);
		if (!hasOld && !onPage) return;
		let index: PageText;
		try {
			index = await textOf(n);
		} catch {
			return;
		}
		if (drawn.get(n)?.text !== layer) return;
		const divs = layer.divs();
		const str = (i: number) => index.text.slice(index.starts[i]!, index.starts[i]! + index.lengths[i]!);
		for (const i of painted.get(n) ?? []) {
			const div = divs[i];
			if (div) div.textContent = str(i);
		}
		painted.delete(n);
		if (!findOpen) return;
		const ranges = new Map<number, Array<{ start: number; end: number; selected: boolean }>>();
		matches.forEach((m, mi) => {
			if (m.page !== n) return;
			for (const seg of matchSegments(index, m)) {
				const list = ranges.get(seg.item) ?? [];
				list.push({ start: seg.start, end: seg.end, selected: mi === matchIndex });
				ranges.set(seg.item, list);
			}
		});
		const touched = new Set<number>();
		for (const [i, list] of ranges) {
			const div = divs[i];
			if (!div) continue;
			div.replaceChildren(
				...highlightPieces(str(i), list).map((piece) => {
					if (!piece.mark) return document.createTextNode(piece.text);
					const span = document.createElement('span');
					span.className = piece.mark === 'selected' ? 'pdf-hl is-selected' : 'pdf-hl';
					span.textContent = piece.text;
					return span;
				})
			);
			touched.add(i);
		}
		if (touched.size) painted.set(n, touched);
	}

	function onFindKey(ev: KeyboardEvent): void {
		if (ev.key === 'Enter') {
			ev.preventDefault();
			stepFind(ev.shiftKey ? -1 : 1);
		}
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
		const ready = status === 'ready' && sizes.length > 0;
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
		const top = layout.tops[i]! + mark.box.y * layout.heights[i]!;
		const bottom = top + mark.box.h * layout.heights[i]!;
		if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) {
			el.scrollTop = scrollTopForPoint(layout, mark.page, mark.box.y, el.clientHeight);
		}
		const node = pageEl(mark.page);
		if (node && layout.widths[i]! > el.clientWidth) {
			const x = node.offsetLeft + (mark.box.x + mark.box.w / 2) * layout.widths[i]!;
			el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
		}
		// Read the new spot now, not on the scroll event: pages measured meanwhile re-anchor to it.
		onScroll();
		flashId = id;
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flashId = null), FLASH_MS);
	}

	/** The crop for an anchor: its page drawn at 2×, the box cut out with a 10% margin. */
	export async function cropAnchor(target: PdfRegionAnchor): Promise<EncodedCrop | null> {
		const source = doc;
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
		const source = doc;
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
		const gen = docGen;
		const quote = await quoteFor(n, region);
		// Another file, or annotate mode switched off, while the quote was read.
		if (gen !== docGen || !choosing) return;
		const anchorNow = anchorFromBox(n, region, quote);
		if (!anchorNow) return;
		const ref = { anchor: anchorNow };
		draftRef = ref;
		// The crop reads the box as it is when the remark is saved, after any moving — even when
		// the preview has already let go of `pending` by then. Nothing once another file is open.
		onDraft({ anchor: anchorNow, crop: () => (gen === docGen ? cropAnchor(pending ?? ref.anchor) : Promise.resolve(null)) });
	}

	async function emitPendingChange(n: number, region: NormBox): Promise<void> {
		localPending = { page: n, box: region };
		const gen = docGen;
		const quote = await quoteFor(n, region);
		if (gen !== docGen) return;
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
		focusScroller();
		beginGesture(ev, { kind: 'new', page: n, pointerId: ev.pointerId, overlay, from: { x: ev.clientX, y: ev.clientY }, start, box: { ...start, w: 0, h: 0 } });
	}

	function onPendingDown(ev: PointerEvent, n: number, region: NormBox, handle: Handle | null): void {
		if (gesture || ev.button !== 0) return;
		const overlay = (ev.currentTarget as HTMLElement).closest<HTMLElement>('.pdf-marks');
		if (!overlay) return;
		ev.preventDefault();
		ev.stopPropagation();
		focusScroller();
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
			const size = sizes[g.page - 1];
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
		return closeFind() || escapeAnnotation();
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
		if (!mod || status !== 'ready') return;
		const key = ev.key.toLowerCase();
		let used = true;
		if (key === 'f' && !ev.shiftKey) openFind();
		else if (key === '=' || key === '+') setZoom(zoomIn(zoom));
		else if (key === '-' || key === '_') setZoom(zoomOut(zoom));
		else if (key === '0') zoomMode = { kind: 'fit-width' };
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
		if (findTimer) clearTimeout(findTimer);
		if (pumpTimer) clearTimeout(pumpTimer);
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
	{#if status === 'ready'}
		<div class="pdf-toolbar" data-annotator-bar>
			<button type="button" class="pdf-tool" title={labels.zoomOut} aria-label={labels.zoomOut} onclick={() => setZoom(zoomOut(zoom))} data-pdf-zoom-out>−</button>
			<select class="pdf-zoom" aria-label={labels.zoom} value={zoomMenuValue(zoomMode)} onchange={onZoomMenu} data-pdf-zoom>
				<option value="fit-width">{zoomMode.kind === 'fit-width' ? `${labels.fitWidth} · ${zoomPercent(zoom)}` : labels.fitWidth}</option>
				<option value="fit-page">{zoomMode.kind === 'fit-page' ? `${labels.fitPage} · ${zoomPercent(zoom)}` : labels.fitPage}</option>
				{#each ZOOM_PRESETS as preset (preset)}
					<option value={String(preset)}>{zoomPercent(preset)}</option>
				{/each}
				{#if customZoom !== null}
					<option value={String(customZoom)}>{zoomPercent(customZoom)}</option>
				{/if}
			</select>
			<button type="button" class="pdf-tool" title={labels.zoomIn} aria-label={labels.zoomIn} onclick={() => setZoom(zoomIn(zoom))} data-pdf-zoom-in>+</button>
			<span class="pdf-sep" aria-hidden="true"></span>
			<input
				class="pdf-page-input"
				type="text"
				inputmode="numeric"
				aria-label={labels.pageNumber}
				bind:value={pageInput}
				oninput={() => (pageInputFocused = true)}
				onkeydown={onPageKey}
				onfocus={(ev) => {
					pageInputFocused = true;
					(ev.currentTarget as HTMLInputElement).select();
				}}
				onblur={() => {
					pageInputFocused = false;
					commitPageInput();
				}}
				data-pdf-page-input
			/>
			<span class="pdf-page-total text-12">{labels.pageCount(numPages)}</span>
			<span class="flex-1"></span>
			<button
				type="button"
				class="pdf-tool"
				class:is-on={findOpen}
				title={labels.find}
				aria-label={labels.find}
				aria-pressed={findOpen}
				onclick={() => (findOpen ? closeFind() : openFind())}
				data-pdf-find-toggle
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
					<circle cx="11" cy="11" r="7"></circle>
					<line x1="20" y1="20" x2="16.2" y2="16.2"></line>
				</svg>
			</button>
		</div>
		{#if findOpen}
			<div class="pdf-find" role="search">
				<input
					class="pdf-find-input"
					type="search"
					placeholder={labels.findPlaceholder}
					aria-label={labels.find}
					bind:this={findInput}
					bind:value={findQuery}
					oninput={() => queueFind()}
					onkeydown={onFindKey}
					data-pdf-find-input
				/>
				<span class="pdf-find-count text-12" aria-live="polite">{findStatus}</span>
				<button type="button" class="pdf-tool" title={labels.findPrev} aria-label={labels.findPrev} disabled={matches.length === 0} onclick={() => stepFind(-1)}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 15 12 9 18 15"></polyline></svg>
				</button>
				<button type="button" class="pdf-tool" title={labels.findNext} aria-label={labels.findNext} disabled={matches.length === 0} onclick={() => stepFind(1)}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
				</button>
				<button type="button" class="pdf-tool" title={labels.findClose} aria-label={labels.findClose} onclick={() => closeFind()}>✕</button>
			</div>
		{/if}
	{/if}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div class="pdf-scroll" bind:this={scroller} tabindex="0" onscroll={onScroll} data-pdf-scroll>
		{#if status === 'loading'}
			<p class="pdf-status" role="status">{labels.loading}</p>
		{:else if status === 'password'}
			<form class="pdf-password" onsubmit={sendPassword} data-pdf-password>
				<p class="pdf-status" class:is-error={passwordWrong}>{passwordWrong ? labels.passwordWrong : labels.password}</p>
				<div class="flex gap-6 items-center">
					<input class="pdf-password-input" type="password" autocomplete="off" aria-label={labels.passwordField} placeholder={labels.passwordField} bind:value={password} />
					<button type="submit" class="pdf-tool pdf-password-open" disabled={!password}>{labels.passwordOpen}</button>
				</div>
			</form>
		{:else if status === 'broken' || status === 'failed'}
			<p class="pdf-status is-error" role="alert" data-pdf-error={status}>{status === 'broken' ? labels.broken : labels.failed}</p>
		{:else}
			<div class="pdf-pages">
				{#each pageNumbers as n (n)}
					{@const size = sizes[n - 1]}
					<div
						class="pdf-page"
						data-page={n}
						style="width:{layout.widths[n - 1]}px;height:{layout.heights[n - 1]}px;--scale-factor:{zoom * PDF_TO_CSS_UNITS};--user-unit:{size?.userUnit ?? 1}"
					>
						<div class="pdf-canvas"></div>
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="pdf-text" onpointerdown={onTextDown}></div>
						{#if links[n]?.length}
							<div class="pdf-links">
								{#each links[n] ?? [] as link, i (i)}
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
										<button type="button" class="pdf-link" title={labels.goTo} aria-label={labels.goTo} style={toPercentStyle(link.rect)} onclick={() => void followLink(link.dest)}></button>
									{/if}
								{/each}
							</div>
						{/if}
						<div
							class="pdf-marks"
							class:is-active={choosing}
							data-page={n}
							title={choosing ? labels.region : undefined}
							onpointerdown={(ev) => onOverlayDown(ev, n)}
							role="presentation"
						>
							{#each marksByPage.get(n) ?? [] as mark (mark.id)}
								<div
									class="pdf-mark is-{mark.status}"
									class:is-stale={mark.stale}
									class:is-flash={flashId === mark.id}
									style={toPercentStyle(mark.box)}
									data-annotation-id={mark.id}
								>
									<button
										type="button"
										class="pdf-mark-badge"
										title={mark.stale ? `${mark.body}\n${labels.stale}` : mark.body}
										aria-label={labels.mark(mark.n, mark.body)}
										onpointerdown={(ev) => onBadgeDown(ev, mark.id)}
										onpointerup={onBadgeUp}
										onpointercancel={onBadgeUp}
										onclick={() => onBadgeClick(mark.id)}
									>{mark.n}</button>
									{#if peekId === mark.id}
										<span class="pdf-mark-peek text-12" role="tooltip">{mark.body}{mark.stale ? ` · ${labels.stale}` : ''}</span>
									{/if}
								</div>
							{/each}
							{#if gesture?.kind === 'new' && gesture.page === n}
								<div class="pdf-mark is-drawing" style={toPercentStyle(gesture.box)}></div>
							{/if}
							{#if pendingShown && pendingShown.page === n}
								{@const region = pendingShown.box}
								<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
								<div
									class="pdf-mark is-pending"
									style={toPercentStyle(region)}
									title={labels.pending}
									aria-label={labels.pending}
									role="group"
									tabindex="0"
									onpointerdown={(ev) => onPendingDown(ev, n, region, null)}
									onkeydown={(ev) => onPendingKey(ev, n, region)}
									data-pdf-pending
								>
									{#each HANDLES as handle (handle)}
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<span
											class="pdf-handle is-{handle}"
											title={labels.resize}
											onpointerdown={(ev) => onPendingDown(ev, n, region, handle)}
										></span>
									{/each}
								</div>
							{/if}
						</div>
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

	.pdf-zoom,
	.pdf-page-input,
	.pdf-find-input,
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
	.pdf-password-input {
		width: 200px;
		max-width: 60vw;
	}
	.pdf-zoom:focus-visible,
	.pdf-page-input:focus-visible,
	.pdf-find-input:focus-visible,
	.pdf-password-input:focus-visible {
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
		border-radius: 3px;
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

	.pdf-marks {
		position: absolute;
		inset: 0;
		z-index: 3;
		pointer-events: none;
	}
	.pdf-marks.is-active {
		pointer-events: auto;
		cursor: crosshair;
		touch-action: none;
	}

	/* Open: accent, solid. Draft: dotted and lighter. Resolved: grey. Stale: dashed. */
	.pdf-mark {
		position: absolute;
		box-sizing: border-box;
		border: 2px solid var(--accent);
		border-radius: 2px;
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		pointer-events: none;
	}
	.pdf-mark.is-draft {
		border-style: dotted;
		background: color-mix(in srgb, var(--accent) 6%, transparent);
	}
	.pdf-mark.is-resolved {
		border-color: color-mix(in srgb, var(--muted) 70%, transparent);
		background: color-mix(in srgb, var(--muted) 10%, transparent);
	}
	.pdf-mark.is-stale {
		border-style: dashed;
	}
	.pdf-mark.is-flash {
		animation: pdf-mark-flash 1.4s ease-out;
	}
	.pdf-mark.is-drawing {
		border-style: dashed;
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}
	.pdf-mark.is-pending {
		border-width: 2px;
		background: var(--accent-glow);
		box-shadow: 0 0 0 1px var(--pdf-paper);
		pointer-events: auto;
		cursor: move;
		touch-action: none;
	}
	.pdf-mark.is-pending:focus-visible {
		outline: 2px solid var(--accent-border);
		outline-offset: 2px;
	}

	.pdf-mark-badge {
		position: absolute;
		left: 0;
		top: 0;
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border: 0;
		border-radius: 999px;
		background: var(--accent);
		color: var(--you-text);
		font: inherit;
		font-size: 11px;
		font-weight: 600;
		line-height: 18px;
		text-align: center;
		transform: translate(-60%, -60%);
		box-shadow: var(--shadow-md);
		pointer-events: auto;
		cursor: pointer;
	}
	.pdf-mark.is-draft .pdf-mark-badge {
		background: var(--pane);
		color: var(--accent);
		box-shadow: inset 0 0 0 2px var(--accent), var(--shadow-md);
	}
	.pdf-mark.is-resolved .pdf-mark-badge {
		background: var(--muted);
	}

	.pdf-mark-peek {
		position: absolute;
		left: 0;
		top: calc(100% + 6px);
		z-index: 5;
		max-width: 240px;
		padding: 4px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-md);
		white-space: pre-wrap;
		pointer-events: none;
	}

	.pdf-handle {
		position: absolute;
		width: 10px;
		height: 10px;
		border: 2px solid var(--accent);
		border-radius: 2px;
		background: var(--pdf-paper);
		box-sizing: border-box;
	}
	.pdf-handle::before {
		content: '';
		position: absolute;
		inset: -8px;
	}
	.pdf-handle.is-nw {
		left: -6px;
		top: -6px;
		cursor: nwse-resize;
	}
	.pdf-handle.is-ne {
		right: -6px;
		top: -6px;
		cursor: nesw-resize;
	}
	.pdf-handle.is-sw {
		left: -6px;
		bottom: -6px;
		cursor: nesw-resize;
	}
	.pdf-handle.is-se {
		right: -6px;
		bottom: -6px;
		cursor: nwse-resize;
	}

	@keyframes pdf-mark-flash {
		0%,
		40% {
			box-shadow: 0 0 0 6px var(--accent-glow);
			background: color-mix(in srgb, var(--accent) 32%, transparent);
		}
		100% {
			box-shadow: 0 0 0 0 transparent;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.pdf-mark.is-flash {
			animation: none;
			background: color-mix(in srgb, var(--accent) 28%, transparent);
		}
	}

	@media (max-width: 680px) {
		.pdf-tool,
		.pdf-zoom,
		.pdf-page-input,
		.pdf-find-input,
		.pdf-password-input {
			min-height: 40px;
		}
		.pdf-tool {
			min-width: 40px;
		}
		.pdf-page-input {
			width: 52px;
		}
		.pdf-mark-badge::before {
			content: '';
			position: absolute;
			inset: -11px;
		}
		.pdf-handle {
			width: 14px;
			height: 14px;
		}
		.pdf-handle::before {
			inset: -13px;
		}
		.pdf-handle.is-nw,
		.pdf-handle.is-sw {
			left: -8px;
		}
		.pdf-handle.is-ne,
		.pdf-handle.is-se {
			right: -8px;
		}
		.pdf-handle.is-nw,
		.pdf-handle.is-ne {
			top: -8px;
		}
		.pdf-handle.is-sw,
		.pdf-handle.is-se {
			bottom: -8px;
		}
	}
</style>
