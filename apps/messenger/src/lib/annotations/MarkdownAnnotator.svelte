<!--
	Markdown 渲染态划词（#25）：预览里渲染好的 Markdown，加上它的批注。批注模式下划一段字，选区末尾浮出「批注」，
	点它得到一个 `text_range` 锚点——行列是源文的（Bot 看到的是源文行号），带 `view: "rendered"`。
	已有的批注用 CSS Custom Highlight API 画在字上（不改渲染出来的 DOM），三种状态三种样子，陈旧的是虚线；
	每条在开头挂一个编号，悬停看意见，点它（或点那段字）交给 `onPick`。
-->
<script lang="ts" module>
	import type { TextRangeAnchor } from '@real-bot/protocol';
	import type { RenderMarkdownOptions } from '../markdown.ts';
	import type { EncodedCrop } from './region-box.ts';

	/** Everything this surface says; the preview passes it in from `copy.ts`. */
	export type MarkdownAnnotatorLabels = {
		/** The button that floats by a selection in annotate mode. */
		annotate: string;
		/** A drawn annotation's number badge for a screen reader: its number and its remark. */
		mark: (n: number, remark: string) => string;
		/** Added under the remark on a mark whose file has changed since. */
		stale: string;
	};

	/** What a finished pick hands the preview. Text has nothing to crop. */
	export type MarkdownRangeDraft = { anchor: TextRangeAnchor; crop?: () => Promise<EncodedCrop | null> };

	/** One options object for every instance, so the render cache keys it once. */
	const SOURCE_LINES: RenderMarkdownOptions = { sourceLines: true };
</script>

<script lang="ts">
	import { validateAnchor, type Annotation } from '@real-bot/protocol';
	import { untrack } from 'svelte';
	import MarkdownBody from '../MarkdownBody.svelte';
	import { projectVisible } from './markdown-lines.ts';
	import {
		HIGHLIGHT_FLASH,
		HIGHLIGHT_PENDING,
		anchorFromRange,
		clampRange,
		createHighlightPainter,
		highlightName,
		mapRendered,
		pointInRects,
		rangesForAnchor,
		rangesForRow,
		rectsOf,
		type RangeLike,
		type RenderedMap,
	} from './markdown-anchor.ts';

	interface Props {
		/** The Markdown file's text, exactly as on disk. */
		source: string;
		/** This file's text-range rows, in display order: drawn numbered 1..n. */
		annotations: Annotation[];
		/** Scroll to this one and flash it. */
		focusId: string | null;
		/** Bumped on every request to go to `focusId`, so the one already focused is revealed again. */
		focusSeq?: number;
		/** Annotate mode: a selection offers the annotate button. */
		active: boolean;
		/** Whether a new annotation may be made at all; existing ones are drawn either way. */
		enabled: boolean;
		labels: MarkdownAnnotatorLabels;
		/** A range was chosen; the preview opens the composer for its remark. */
		onDraft: (draft: MarkdownRangeDraft) => void;
		/** A click on an existing mark. */
		onPick: (id: string) => void;
		/** The anchor awaiting its remark: drawn apart from the saved ones. */
		pending?: TextRangeAnchor | null;
		/** Part of the shared adapter contract; a text range is not moved in place, so never called. */
		onPendingChange?: (anchor: TextRangeAnchor) => void;
		/** Escape while choosing, or with a range pending. */
		onCancel?: () => void;
		/** MarkdownBody's pass-throughs. */
		copyLabel: string;
		copiedLabel: string;
		onOpenArtifact?: (relpath: string) => void;
		loadArtifactImage?: (relpath: string) => Promise<Blob>;
	}

	let {
		source,
		annotations,
		focusId,
		focusSeq = 0,
		active,
		enabled,
		labels,
		onDraft,
		onPick,
		pending = null,
		onCancel,
		copyLabel,
		copiedLabel,
		onOpenArtifact,
		loadArtifactImage,
	}: Props = $props();

	const FLASH_MS = 1400;
	/** Badges that start at the same spot step aside by this much. */
	const BADGE_STEP_PX = 18;

	type Mark = { id: string; n: number; x: number; y: number; status: 'open' | 'draft' | 'resolved'; stale: boolean; body: string };

	let host = $state<HTMLDivElement | undefined>(undefined);
	let bodyHost = $state<HTMLDivElement | undefined>(undefined);
	/** Where the annotate button floats, relative to the host; null when there is nothing to annotate. */
	let button = $state<{ x: number; y: number } | null>(null);
	let marks = $state<Mark[]>([]);
	let flashId = $state<string | null>(null);
	let hoverId = $state<string | null>(null);

	const projection = $derived(projectVisible(source));

	const painter = createHighlightPainter();
	let map: RenderedMap | null = null;
	/** The rendered body changed since `map` was built. */
	let dirty = true;
	let drawn = new Map<string, Range[]>();
	let pendingRanges: Range[] = [];
	/** The anchor the button would make, kept from the moment the selection was read. */
	let candidate: TextRangeAnchor | null = null;
	/** A press on the button is under way: a touch may clear the selection before the click lands. */
	let pressing = false;
	let lastFocus: string | null = null;
	let lastFocusSeq = 0;
	let waitingReveal: string | null = null;
	let pressTimer: ReturnType<typeof setTimeout> | null = null;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	let layoutTimer: ReturnType<typeof setTimeout> | null = null;
	let flashTimer: ReturnType<typeof setTimeout> | null = null;
	let hoverPoint: { x: number; y: number } | null = null;
	let hoverTimer: ReturnType<typeof setTimeout> | null = null;

	const hoverTitle = $derived.by(() => {
		if (!hoverId) return undefined;
		const row = annotations.find((item) => item.id === hoverId);
		return row ? markTitle(row.body, Boolean(row.stale)) : undefined;
	});

	function statusOf(row: Annotation): Mark['status'] {
		return row.status === 'draft' ? 'draft' : row.status === 'resolved' ? 'resolved' : 'open';
	}

	/** What hovering a mark shows: the remark, and a warning when the file has moved on. */
	function markTitle(body: string, stale: boolean): string {
		return stale ? `${body}\n${labels.stale}` : body;
	}

	function mdBody(): HTMLElement | null {
		const el = bodyHost?.querySelector('.md-body');
		return el instanceof HTMLElement ? el : null;
	}

	function currentMap(body: HTMLElement): RenderedMap {
		if (!map || dirty || map.dom.root !== body || map.projection !== projection) {
			map = mapRendered(body, projection);
			dirty = false;
		}
		return map;
	}

	/* ------------------------------------------------------------ drawing */

	function paint(): void {
		const groups = new Map<string, Range[]>();
		for (const row of annotations) {
			const ranges = drawn.get(row.id);
			if (!ranges) continue;
			const name = highlightName(row);
			groups.set(name, [...(groups.get(name) ?? []), ...ranges]);
		}
		if (pendingRanges.length > 0) groups.set(HIGHLIGHT_PENDING, pendingRanges);
		const flashing = flashId ? drawn.get(flashId) : undefined;
		if (flashing) groups.set(HIGHLIGHT_FLASH, flashing);
		painter.paint(groups);
	}

	/** The number badges sit at the start of each mark, in the host's own coordinates. */
	function layout(): void {
		const el = host;
		if (!el) return;
		const origin = el.getBoundingClientRect();
		const taken = new Map<string, number>();
		const next: Mark[] = [];
		annotations.forEach((row, index) => {
			const ranges = drawn.get(row.id);
			if (!ranges) return;
			const rect = rectsOf(ranges)[0];
			const left = rect ? rect.left - origin.left : 0;
			const top = rect ? rect.top - origin.top : 0;
			const key = `${Math.round(left)}:${Math.round(top)}`;
			const seen = taken.get(key) ?? 0;
			taken.set(key, seen + 1);
			next.push({
				id: row.id,
				n: index + 1,
				x: Math.max(12, left + seen * BADGE_STEP_PX),
				y: Math.max(8, top),
				status: statusOf(row),
				stale: Boolean(row.stale),
				body: row.body,
			});
		});
		marks = next;
	}

	/** Rebuild the map if the body changed, find every mark's ranges again, and draw. */
	function refresh(): void {
		const body = mdBody();
		if (!body) return;
		const current = currentMap(body);
		const next = new Map<string, Range[]>();
		for (const row of annotations) {
			if (row.anchor_kind !== 'text_range' || row.stale?.kind === 'missing') continue;
			const ranges = rangesForRow(current, row);
			if (ranges.length > 0) next.set(row.id, ranges);
		}
		drawn = next;
		pendingRanges = pending ? rangesForAnchor(current, pending) : [];
		paint();
		layout();
		revealIfWaiting();
	}

	function scheduleRefresh(): void {
		if (refreshTimer) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			refresh();
		}, 40);
	}

	function scheduleLayout(): void {
		if (layoutTimer) return;
		layoutTimer = setTimeout(() => {
			layoutTimer = null;
			layout();
		}, 30);
	}

	function flash(id: string): void {
		flashId = id;
		paint();
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => {
			flashTimer = null;
			flashId = null;
			paint();
		}, FLASH_MS);
	}

	/** Scroll to the focused mark once it is drawn; a focus set before the rows arrive waits for them. */
	function revealIfWaiting(): void {
		const id = waitingReveal;
		const ranges = id ? drawn.get(id) : undefined;
		if (!id || !ranges || ranges.length === 0) return;
		waitingReveal = null;
		ranges[0]!.startContainer.parentElement?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
		flash(id);
	}

	/** Which drawn mark is under a point on screen; the later one wins where two overlap. */
	function markAt(x: number, y: number): string | null {
		let hit: string | null = null;
		for (const row of annotations) {
			const ranges = drawn.get(row.id);
			if (ranges && pointInRects(rectsOf(ranges), x, y)) hit = row.id;
		}
		return hit;
	}

	/* ------------------------------------------------------------ choosing */

	function hideButton(): void {
		button = null;
		candidate = null;
	}

	/** The boxes of the part of a selection inside the body; none where there is no layout. */
	function boxesOf(part: RangeLike): DOMRect[] {
		const range = document.createRange();
		try {
			range.setStart(part.startContainer, part.startOffset);
			range.setEnd(part.endContainer, part.endOffset);
		} catch {
			return [];
		}
		if (typeof range.getClientRects !== 'function') return [];
		return [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
	}

	/** Read the page's selection: inside this body, in annotate mode, it offers the button. */
	function readSelection(): void {
		if (!active || !enabled) {
			hideButton();
			return;
		}
		const body = mdBody();
		const selection = typeof document === 'undefined' ? null : document.getSelection();
		if (!body || !host || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
			if (!pressing) hideButton();
			return;
		}
		const range = selection.getRangeAt(0);
		const inside = clampRange(range, body);
		const anchor = inside ? anchorFromRange(currentMap(body), inside) : null;
		if (!inside || !anchor) {
			hideButton();
			return;
		}
		candidate = anchor;
		const origin = host.getBoundingClientRect();
		// Float by where the selection ends inside the body, not where a drag past it ended.
		const end = boxesOf(inside).at(-1);
		const width = host.clientWidth || origin.width;
		const x = end ? end.right - origin.left : 0;
		button = {
			x: width > 0 ? Math.min(Math.max(x, 44), Math.max(44, width - 44)) : Math.max(x, 44),
			y: end ? end.bottom - origin.top + 6 : 0,
		};
	}

	/** A touch may clear the selection before its click lands; hold the button for that long. */
	function press(): void {
		pressing = true;
		if (pressTimer) clearTimeout(pressTimer);
		pressTimer = setTimeout(() => {
			pressTimer = null;
			pressing = false;
			readSelection();
		}, 800);
	}

	function annotate(): void {
		pressing = false;
		if (pressTimer) clearTimeout(pressTimer);
		pressTimer = null;
		const anchor = candidate;
		if (!anchor || !active || !enabled) return;
		const check = validateAnchor('text_range', anchor);
		if (!check.ok) return;
		hideButton();
		document.getSelection()?.removeAllRanges();
		onDraft({ anchor: check.anchor as TextRangeAnchor });
	}

	/** Escape cancels the pick before the pane gets it: the document hears it before the shell's window. */
	function onKey(ev: KeyboardEvent): void {
		if (ev.key !== 'Escape' || ev.defaultPrevented || ev.isComposing) return;
		const choosing = button !== null;
		if (!choosing && !pending) return;
		ev.preventDefault();
		ev.stopPropagation();
		if (choosing) {
			hideButton();
			const selection = document.getSelection();
			const body = mdBody();
			if (selection && body && selection.rangeCount > 0 && body.contains(selection.getRangeAt(0).commonAncestorContainer)) selection.removeAllRanges();
		}
		onCancel?.();
	}

	/* ------------------------------------------------------------ pointer on marks */

	function onBodyClick(ev: MouseEvent): void {
		const target = ev.target;
		if (target instanceof Element && target.closest('a, button')) return;
		const selection = document.getSelection();
		if (selection && !selection.isCollapsed && selection.toString().trim()) return;
		const id = markAt(ev.clientX, ev.clientY);
		if (id) onPick(id);
	}

	function onBodyPointerMove(ev: PointerEvent): void {
		if (ev.pointerType && ev.pointerType !== 'mouse') return;
		hoverPoint = { x: ev.clientX, y: ev.clientY };
		if (hoverTimer) return;
		hoverTimer = setTimeout(() => {
			hoverTimer = null;
			const point = hoverPoint;
			hoverId = point ? markAt(point.x, point.y) : null;
		}, 16);
	}

	function onBodyPointerLeave(): void {
		hoverPoint = null;
		hoverId = null;
	}

	/* ------------------------------------------------------------ effects */

	$effect(() => {
		const el = host;
		const wrap = bodyHost;
		if (!el || !wrap) return;
		// Shiki repaints code, tables get wrapped, images arrive: every rewrite detaches old ranges.
		const observer = new MutationObserver(() => {
			dirty = true;
			scheduleRefresh();
		});
		observer.observe(wrap, { childList: true, subtree: true, characterData: true });
		const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => scheduleLayout()) : null;
		resize?.observe(el);
		// An image that finishes loading moves the text under it; a wide table scrolls on its own.
		const onLoad = () => scheduleLayout();
		wrap.addEventListener('load', onLoad, true);
		wrap.addEventListener('scroll', onLoad, true);
		document.addEventListener('selectionchange', readSelection);
		document.addEventListener('keydown', onKey);
		return () => {
			observer.disconnect();
			resize?.disconnect();
			wrap.removeEventListener('load', onLoad, true);
			wrap.removeEventListener('scroll', onLoad, true);
			document.removeEventListener('selectionchange', readSelection);
			document.removeEventListener('keydown', onKey);
			for (const timer of [refreshTimer, layoutTimer, flashTimer, hoverTimer, pressTimer]) if (timer) clearTimeout(timer);
			refreshTimer = layoutTimer = flashTimer = hoverTimer = pressTimer = null;
			painter.clear();
			map = null;
		};
	});

	$effect(() => {
		// Rows, the pending range and the text itself decide what is drawn. A row changed in place
		// (resolved, edited, gone stale) is read field by field, so it repaints too.
		for (const row of annotations) {
			void row.status;
			void row.stale;
			void row.anchor;
			void row.body;
		}
		void pending;
		void projection;
		if (!host || !bodyHost) return;
		untrack(refresh);
	});

	$effect(() => {
		const id = focusId;
		const seq = focusSeq;
		untrack(() => {
			if (id === lastFocus && seq === lastFocusSeq) return;
			lastFocus = id;
			lastFocusSeq = seq;
			waitingReveal = id;
			revealIfWaiting();
		});
	});

	$effect(() => {
		const on = active && enabled;
		untrack(() => (on ? readSelection() : hideButton()));
	});
</script>

<div class="md-annotator relative min-w-0" class:is-choosing={active && enabled} bind:this={host} data-markdown-annotator>
	<!-- The numbered marks are the keyboard's way in; a click on the text is the pointer's shortcut. -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="md-annot-body"
		class:is-over-mark={hoverId !== null}
		title={hoverTitle}
		bind:this={bodyHost}
		onclick={onBodyClick}
		onpointermove={onBodyPointerMove}
		onpointerleave={onBodyPointerLeave}
	>
		<MarkdownBody {source} options={SOURCE_LINES} {copyLabel} {copiedLabel} {onOpenArtifact} {loadArtifactImage} />
	</div>
	<div class="md-annot-layer absolute inset-0" data-annotator-chrome>
		{#each marks as mark (mark.id)}
			<button
				type="button"
				class="md-annot-mark absolute"
				class:is-draft={mark.status === 'draft'}
				class:is-resolved={mark.status === 'resolved'}
				class:is-stale={mark.stale}
				class:is-flash={flashId === mark.id}
				style:left="{mark.x}px"
				style:top="{mark.y}px"
				title={markTitle(mark.body, mark.stale)}
				aria-label={labels.mark(mark.n, markTitle(mark.body, mark.stale))}
				data-annotation-id={mark.id}
				onclick={() => onPick(mark.id)}
			>{mark.n}</button>
		{/each}
		{#if button}
			<button
				type="button"
				class="md-annotate-btn absolute"
				style:left="{button.x}px"
				style:top="{button.y}px"
				data-annotate-button
				onpointerdown={(ev) => {
					press();
					ev.preventDefault();
				}}
				ontouchstart={press}
				onmousedown={(ev) => ev.preventDefault()}
				onclick={annotate}
			>{labels.annotate}</button>
		{/if}
	</div>
</div>

<style>
	.md-annotator.is-choosing .md-annot-body {
		cursor: text;
	}

	.md-annotator .md-annot-body.is-over-mark {
		cursor: pointer;
	}

	.md-annot-layer {
		pointer-events: none;
		user-select: none;
		z-index: 2;
	}

	/* A mark's number, at the start of its text: accent for open, dotted for a draft, grey once resolved. */
	.md-annot-mark {
		pointer-events: auto;
		min-width: 16px;
		height: 16px;
		padding: 0 4px;
		transform: translate(-70%, -70%);
		border: 1px solid var(--accent);
		border-radius: 999px;
		background: var(--accent-tint);
		color: var(--accent);
		font-family: var(--mono);
		font-size: 10px;
		font-weight: 700;
		line-height: 14px;
		text-align: center;
		cursor: pointer;
		box-shadow: var(--shadow-md);
	}
	.md-annot-mark::before {
		content: '';
		position: absolute;
		inset: -5px;
	}
	.md-annot-mark:hover,
	.md-annot-mark:focus-visible {
		border-color: var(--accent);
		background: var(--accent-border);
		outline: none;
	}
	.md-annot-mark.is-draft {
		border-style: dotted;
		background: var(--pane);
	}
	.md-annot-mark.is-resolved {
		border-color: var(--line-hover);
		background: var(--btn-secondary-bg);
		color: var(--muted);
	}
	.md-annot-mark.is-stale {
		border-style: dashed;
	}
	.md-annot-mark.is-flash {
		animation: md-annot-flash 1.4s ease-out;
	}
	@keyframes md-annot-flash {
		0%,
		55% {
			box-shadow: 0 0 0 5px var(--accent-border);
		}
		100% {
			box-shadow: var(--shadow-md);
		}
	}

	.md-annotate-btn {
		pointer-events: auto;
		transform: translateX(-50%);
		padding: 2px 12px;
		border: 1px solid var(--accent-border);
		border-radius: 999px;
		background: var(--pane);
		color: var(--accent);
		font-size: 12px;
		font-weight: 600;
		line-height: 20px;
		white-space: nowrap;
		cursor: pointer;
		box-shadow: var(--shadow-md);
	}
	.md-annotate-btn:hover {
		border-color: var(--accent);
		background: var(--accent-tint);
	}

	/*
	 * The marks themselves are CSS highlights over the rendered text, so the DOM stays as rendered.
	 * Only colour and text decoration apply to ::highlight(); dashed underlines say "stale".
	 */
	:global(::highlight(rb-md-annot-open)),
	:global(::highlight(rb-md-annot-open-stale)) {
		background-color: color-mix(in srgb, var(--accent) 22%, transparent);
		text-decoration-line: underline;
		text-decoration-style: solid;
		text-decoration-color: color-mix(in srgb, var(--accent) 70%, transparent);
	}
	:global(::highlight(rb-md-annot-draft)),
	:global(::highlight(rb-md-annot-draft-stale)) {
		background-color: color-mix(in srgb, var(--accent) 12%, transparent);
		text-decoration-line: underline;
		text-decoration-style: dotted;
		text-decoration-color: var(--accent);
	}
	:global(::highlight(rb-md-annot-resolved)),
	:global(::highlight(rb-md-annot-resolved-stale)) {
		background-color: color-mix(in srgb, var(--muted) 16%, transparent);
		text-decoration-line: underline;
		text-decoration-style: solid;
		text-decoration-color: color-mix(in srgb, var(--muted) 60%, transparent);
	}
	:global(::highlight(rb-md-annot-open-stale)),
	:global(::highlight(rb-md-annot-draft-stale)),
	:global(::highlight(rb-md-annot-resolved-stale)) {
		text-decoration-style: dashed;
	}
	:global(::highlight(rb-md-annot-pending)) {
		background-color: color-mix(in srgb, var(--accent) 32%, transparent);
		text-decoration-line: underline;
		text-decoration-style: dashed;
		text-decoration-color: var(--accent);
	}
	:global(::highlight(rb-md-annot-flash)) {
		background-color: color-mix(in srgb, var(--accent) 45%, transparent);
	}

	@media (max-width: 680px) {
		.md-annot-mark {
			min-width: 22px;
			height: 22px;
			font-size: 11px;
			line-height: 20px;
		}
		/* 22px drawn, 40px to the finger. */
		.md-annot-mark::before {
			inset: -9px;
		}
		.md-annotate-btn {
			min-height: 40px;
			padding: 4px 16px;
			line-height: 30px;
		}
	}
</style>
