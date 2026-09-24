<!--
	图片框选（#26）：预览里的那张图，加上它的批注框。批注模式下在图上拖出一个框（点一下是一个小框），
	等写意见时这个框还能挪、能拖角改大小，Esc 取消；已有的批注按顺序编号，三种状态三种样子，陈旧的是虚线。
	框按图的百分比摆在一层与图一样大的覆盖层里，图怎么缩放都跟着走。
-->
<script lang="ts" module>
	import type { ImageRegionAnchor } from '@real-bot/protocol';
	import type { EncodedCrop } from './region-box.ts';

	/** Everything this surface says; the preview passes it in from `copy.ts`. */
	export type ImageAnnotatorLabels = {
		/** Hover text on the image while annotate mode is on. */
		region: string;
		/** A drawn annotation for a screen reader: its number and its remark. */
		mark: (n: number, remark: string) => string;
		/** Hover text on the box that is waiting for its remark. */
		pending: string;
		/** Hover text on that box's corner handles. */
		resize: string;
		/** Added under the remark on a mark whose image has changed since. */
		stale: string;
	};

	/** What a finished pick hands the preview: the anchor, and how to cut its crop when saving. */
	export type ImageRegionDraft = { anchor: ImageRegionAnchor; crop?: () => Promise<EncodedCrop | null> };
</script>

<script lang="ts">
	import { validateAnchor, type Annotation } from '@real-bot/protocol';
	import { onDestroy, tick, untrack } from 'svelte';
	import { boxBetween, isClick, moveBox, toNorm, toPercentStyle, type DrawnRect, type Handle, type NormBox, type NormPoint, type Size } from './region-box.ts';
	import {
		anchorBox,
		anchorFromBox,
		cropImageRegion,
		finishNewBox,
		handleCorner,
		isCompactBox,
		markClass,
		regionMarks,
		resizeByGrab,
		resolveNaturalSize,
		thickenSliver,
		toNormFree,
		type CropDeps,
		type RegionMark,
	} from './image-region.ts';

	interface Props {
		/** The image's blob URL. */
		src: string;
		alt: string;
		isSvg: boolean;
		/** The SVG's source, for its size when it declares none; optional. */
		svgText?: string | null;
		/** This file's image-region rows, in display order: drawn numbered 1..n. */
		annotations: Annotation[];
		/** Scroll to this one and flash it. */
		focusId: string | null;
		/** Bumped on every request to go to `focusId`, so the one already focused is revealed again. */
		focusSeq?: number;
		/** Annotate mode: a drag or a click on the image makes a box. */
		active: boolean;
		/** Whether a new box may be made at all; existing ones are drawn either way. */
		enabled: boolean;
		labels: ImageAnnotatorLabels;
		/** A box was chosen; the preview opens the composer and calls `crop()` on save. */
		onDraft: (draft: ImageRegionDraft) => void;
		/** A click on an existing mark. */
		onPick: (id: string) => void;
		/** The anchor awaiting its remark: drawn with handles, movable and resizable whatever `active` and `enabled` say. */
		pending?: ImageRegionAnchor | null;
		onPendingChange?: (anchor: ImageRegionAnchor) => void;
		/** Escape while choosing, or with a box pending. */
		onCancel?: () => void;
		/** Test seam: a canvas and decoder for the crop. */
		cropDeps?: CropDeps;
		/**
		 * Outside annotate mode, and with no box waiting, a click on the picture (or Enter on it)
		 * enlarges it; left out, the picture is only a picture.
		 */
		onOpen?: (img: HTMLImageElement) => void;
		/** The enlarge button's name. */
		openLabel?: string;
	}

	let {
		src,
		alt,
		isSvg,
		svgText = null,
		annotations,
		focusId,
		focusSeq = 0,
		active,
		enabled,
		labels,
		onDraft,
		onPick,
		pending,
		onPendingChange,
		onCancel,
		cropDeps,
		onOpen,
		openLabel,
	}: Props = $props();

	const HANDLES: Handle[] = ['nw', 'ne', 'sw', 'se'];
	const COMPACT_HANDLES: Handle[] = ['se'];
	const FLASH_MS = 1400;
	const PEEK_DELAY_MS = 500;
	const PEEK_SHOW_MS = 3000;

	type Point = { x: number; y: number };
	type Gesture =
		| { kind: 'new'; pointerId: number; from: Point; start: NormPoint }
		| { kind: 'move'; pointerId: number; from: Point; box: NormBox }
		/** `grab` is the corner minus where the handle was pressed, so the corner does not jump. */
		| { kind: 'resize'; pointerId: number; handle: Handle; box: NormBox; grab: NormPoint };

	let rootEl = $state<HTMLDivElement | undefined>(undefined);
	let imgEl = $state<HTMLImageElement | undefined>(undefined);
	/** What the image said when it loaded; its natural size is worked out from this. */
	let loaded = $state<{ naturalWidth: number; naturalHeight: number; drawn: Size } | null>(null);
	/** Where the image sits inside the root, so the layer covers exactly it. */
	let layer = $state<DrawnRect | null>(null);
	/** The box being dragged out. */
	let liveBox = $state<NormBox | null>(null);
	/** The pending box as this component last drew it, until the `pending` prop catches up. */
	let localPending = $state<NormBox | null>(null);
	let dragging = $state(false);
	/** Whether the pending box had one handle when the gesture began: kept until it ends. */
	let compactAtStart = $state(false);
	let flashId = $state<string | null>(null);
	let peekId = $state<string | null>(null);

	let gesture: Gesture | null = null;
	/** Each onDraft starts a session; its crop reads the box as it is when the remark is saved. */
	let draftSession = 0;
	let latest: ImageRegionAnchor | null = null;
	let seenPending: ImageRegionAnchor | null | undefined = undefined;
	let seenSrc: string | undefined = undefined;
	let peekTimer: ReturnType<typeof setTimeout> | null = null;
	let peekHide: ReturnType<typeof setTimeout> | null = null;
	let suppressClick: string | null = null;
	let lastMarkPointer = 'mouse';

	const natural = $derived(loaded ? resolveNaturalSize(loaded, { svg: isSvg, svgText, drawn: loaded.drawn }) : null);
	const marks = $derived(regionMarks(annotations));
	const pendingBox = $derived(localPending ?? (pending ? anchorBox(pending) : null));
	const pendingNatural = $derived<Size | null>(pending ? { width: pending.natural_width, height: pending.natural_height } : natural);
	const creating = $derived(active && enabled && !pendingBox && natural !== null);
	const compactNow = $derived(pendingBox !== null && layer !== null && isCompactBox(pendingBox, layer));
	// A handle that vanished mid-drag would lose its pointer, so the layout holds until release.
	const compact = $derived(dragging ? compactAtStart : compactNow);
	const layerStyle = $derived(
		layer ? `left:${layer.left}px;top:${layer.top}px;width:${layer.width}px;height:${layer.height}px` : 'left:0;top:0;width:100%;height:100%',
	);
	/** The image has loaded and the layer sits on it: only then are the boxes where they belong. */
	const shown = $derived(layer !== null && loaded !== null);
	/** A click on the picture enlarges it only when it is not a click for a box. */
	const openable = $derived(Boolean(onOpen) && !active && !pendingBox && !dragging);
	/** Whether Escape is this surface's; a boolean, so a drag does not re-attach the listener on every move. */
	const engaged = $derived((active && enabled) || pendingBox !== null || dragging);

	function markTitle(mark: RegionMark): string {
		return mark.stale ? `${mark.body}\n${labels.stale}` : mark.body;
	}

	function drawnRect(): DrawnRect | null {
		const r = imgEl?.getBoundingClientRect();
		return r && r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
	}

	function measure(): void {
		const img = imgEl;
		const root = rootEl;
		if (!img || !root) return;
		const r = img.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return;
		// Loaded before it was laid out (a hidden pane): an SVG's fallback size needs the drawn shape.
		if (loaded && (loaded.drawn.width <= 0 || loaded.drawn.height <= 0)) loaded = { ...loaded, drawn: { width: r.width, height: r.height } };
		const o = root.getBoundingClientRect();
		const next = { left: r.left - o.left - root.clientLeft, top: r.top - o.top - root.clientTop, width: r.width, height: r.height };
		const prev = layer;
		if (!prev || prev.left !== next.left || prev.top !== next.top || prev.width !== next.width || prev.height !== next.height) layer = next;
	}

	function onImageLoad(): void {
		const img = imgEl;
		if (!img) return;
		const r = img.getBoundingClientRect();
		loaded = { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, drawn: { width: r.width, height: r.height } };
		measure();
	}

	/* ------------------------------------------------------------ gestures */

	/** Moves and the release are heard on the window, so a drag that leaves the image still ends. */
	function listen(on: boolean): void {
		if (typeof window === 'undefined') return;
		if (on) {
			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', onUp);
			window.addEventListener('pointercancel', onAbort);
		} else {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onAbort);
		}
	}

	function begin(ev: PointerEvent, next: Gesture): void {
		ev.preventDefault();
		gesture = next;
		compactAtStart = compactNow;
		dragging = true;
		peekId = null;
		try {
			(ev.currentTarget as Element | null)?.setPointerCapture?.(ev.pointerId);
		} catch {
			// The window listeners carry the drag without a capture.
		}
		listen(true);
	}

	function finish(): Gesture | null {
		const g = gesture;
		gesture = null;
		dragging = false;
		liveBox = null;
		listen(false);
		return g;
	}

	/** Drop a gesture half-way: a new box vanishes, a moved one goes back. */
	function abort(): void {
		const g = finish();
		if (g && g.kind !== 'new') localPending = g.box;
	}

	function onMove(ev: PointerEvent): void {
		const g = gesture;
		if (!g || ev.pointerId !== g.pointerId) return;
		const drawn = drawnRect();
		if (!drawn) return;
		if (g.kind === 'new') {
			if (!liveBox && isClick(g.from, { x: ev.clientX, y: ev.clientY })) return;
			liveBox = boxBetween(g.start, toNorm(ev.clientX, ev.clientY, drawn));
		} else if (g.kind === 'move') {
			localPending = moveBox(g.box, (ev.clientX - g.from.x) / drawn.width, (ev.clientY - g.from.y) / drawn.height);
		} else {
			localPending = resizeByGrab(g.box, g.handle, toNormFree(ev.clientX, ev.clientY, drawn), g.grab);
		}
	}

	function onUp(ev: PointerEvent): void {
		const g = gesture;
		if (!g || ev.pointerId !== g.pointerId) return;
		const moved = localPending;
		finish();
		const drawn = drawnRect();
		if (g.kind === 'new') {
			const size = natural;
			if (!drawn || !size) return;
			const to = { x: ev.clientX, y: ev.clientY };
			propose(finishNewBox({ client: g.from, norm: g.start }, { client: to, norm: toNorm(to.x, to.y, drawn) }, size));
			return;
		}
		const size = pendingNatural;
		if (!size || !moved) return;
		const box = thickenSliver(moved, size);
		localPending = box;
		// Compared as stored: a press that did not move can still differ by float noise, (x + w) - x.
		const anchor = anchorFromBox(box, size);
		const before = anchorFromBox(g.box, size);
		if (anchor.x === before.x && anchor.y === before.y && anchor.w === before.w && anchor.h === before.h) return;
		latest = anchor;
		onPendingChange?.(anchor);
	}

	function onAbort(ev: PointerEvent): void {
		if (gesture && ev.pointerId === gesture.pointerId) abort();
	}

	function propose(box: NormBox): void {
		const size = natural;
		if (!size) return;
		const anchor = anchorFromBox(box, size);
		if (!validateAnchor('image_region', anchor).ok) return;
		localPending = anchorBox(anchor);
		latest = anchor;
		const session = ++draftSession;
		const img = imgEl;
		const at = src;
		const svg = isSvg;
		const deps = cropDeps;
		onDraft({
			anchor,
			crop: () => {
				// The image this box was drawn on, and the box as it stands now.
				if (!img || img.getAttribute('src') !== at) return Promise.resolve(null);
				const current = session === draftSession && latest ? latest : anchor;
				return cropImageRegion(img, current, { svg, ...deps });
			},
		});
	}

	function onLayerDown(ev: PointerEvent): void {
		if (!creating || gesture || ev.button !== 0 || !ev.isPrimary) return;
		if ((ev.target as Element | null)?.closest?.('.img-annot-mark, .img-annot-pending')) return;
		const drawn = drawnRect();
		if (!drawn) return;
		const from = { x: ev.clientX, y: ev.clientY };
		begin(ev, { kind: 'new', pointerId: ev.pointerId, from, start: toNorm(from.x, from.y, drawn) });
	}

	// The box waiting for its remark stays movable and resizable for as long as it is drawn, even
	// when the preview has switched annotate mode or new picks off while the composer is open.
	function onPendingDown(ev: PointerEvent): void {
		ev.stopPropagation();
		const box = pendingBox;
		if (gesture || ev.button !== 0 || !ev.isPrimary || !box) return;
		begin(ev, { kind: 'move', pointerId: ev.pointerId, from: { x: ev.clientX, y: ev.clientY }, box });
	}

	function onHandleDown(ev: PointerEvent, handle: Handle): void {
		ev.stopPropagation();
		const box = pendingBox;
		const drawn = drawnRect();
		if (gesture || ev.button !== 0 || !ev.isPrimary || !box || !drawn) return;
		const at = toNormFree(ev.clientX, ev.clientY, drawn);
		const corner = handleCorner(box, handle);
		begin(ev, { kind: 'resize', pointerId: ev.pointerId, handle, box, grab: { x: corner.x - at.x, y: corner.y - at.y } });
	}

	/* ------------------------------------------------------------ existing marks */

	function clearPeekTimer(): void {
		if (peekTimer) clearTimeout(peekTimer);
		peekTimer = null;
	}

	function onMarkDown(ev: PointerEvent, id: string): void {
		// While annotating, a mark's number still opens it; it does not start a box.
		if (creating) ev.stopPropagation();
		lastMarkPointer = ev.pointerType || 'mouse';
		// A long press that ended in a context menu never sent its click; this press starts afresh.
		suppressClick = null;
		clearPeekTimer();
		if (lastMarkPointer === 'mouse') return;
		// A long press shows the remark, as hover does for a mouse.
		peekTimer = setTimeout(() => {
			peekTimer = null;
			peekId = id;
			suppressClick = id;
			if (peekHide) clearTimeout(peekHide);
			peekHide = setTimeout(() => {
				if (peekId === id) peekId = null;
			}, PEEK_SHOW_MS);
		}, PEEK_DELAY_MS);
	}

	function onMarkMenu(ev: MouseEvent): void {
		if (lastMarkPointer !== 'mouse') ev.preventDefault();
	}

	function onMarkClick(id: string): void {
		if (suppressClick === id) {
			suppressClick = null;
			return;
		}
		peekId = null;
		onPick(id);
	}

	/* ------------------------------------------------------------ effects */

	// A new image: whatever was measured or half-drawn belonged to the old one.
	$effect.pre(() => {
		const next = src;
		untrack(() => {
			if (seenSrc !== undefined && next !== seenSrc) {
				if (gesture) finish();
				loaded = null;
				layer = null;
				localPending = null;
			}
			seenSrc = next;
		});
	});

	// The preview took over the pending box (or dropped it): draw its copy from now on.
	$effect.pre(() => {
		const next = pending;
		untrack(() => {
			if (next === seenPending) return;
			seenPending = next;
			if (gesture && gesture.kind !== 'new') finish();
			localPending = null;
			if (next) latest = next;
		});
	});

	// Leaving annotate mode, or picks turned off, drops a box being dragged out and the local copy of
	// a pending one (the preview draws its own through `pending`). A move or resize already under
	// the finger is left to finish: the pending box stays adjustable.
	$effect.pre(() => {
		const on = active;
		const allowed = enabled;
		untrack(() => {
			if (on && allowed) return;
			if (gesture?.kind === 'new') finish();
			if (!gesture) localPending = null;
		});
	});

	// The layer follows the image through every resize of the image or the pane.
	$effect(() => {
		const img = imgEl;
		const root = rootEl;
		if (!img || !root) return;
		untrack(() => {
			if (!loaded && img.complete && img.naturalWidth > 0) onImageLoad();
			else measure();
		});
		if (typeof ResizeObserver === 'undefined') {
			window.addEventListener('resize', measure);
			return () => window.removeEventListener('resize', measure);
		}
		const observer = new ResizeObserver(() => measure());
		observer.observe(img);
		observer.observe(root);
		return () => observer.disconnect();
	});

	// Escape cancels the pick before the pane gets it: document hears it before the shell's window.
	$effect(() => {
		if (!engaged || typeof document === 'undefined') return;
		const onKey = (ev: KeyboardEvent): void => {
			if (ev.key !== 'Escape' || ev.defaultPrevented || ev.isComposing) return;
			// A box still being dragged out, with nothing pending, is only dropped: one Escape is one
			// step back, and leaving annotate mode is the next one.
			if (gesture?.kind === 'new' && !pending) {
				finish();
				localPending = null;
				ev.preventDefault();
				ev.stopPropagation();
				return;
			}
			const hadLocal = gesture !== null || localPending !== null;
			if (gesture) finish();
			localPending = null;
			if (!onCancel && !hadLocal) return;
			ev.preventDefault();
			ev.stopPropagation();
			onCancel?.();
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	});

	// Held until the image is shown: a flash on a box still hidden (the file just opened) is never seen.
	$effect(() => {
		const id = focusId;
		void focusSeq;
		if (!id || !shown) return;
		untrack(() => (flashId = id));
		void tick().then(() => {
			const node = [...(rootEl?.querySelectorAll<HTMLElement>('[data-annotation-id]') ?? [])].find((el) => el.dataset.annotationId === id);
			node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
		});
		const timer = setTimeout(() => {
			if (flashId === id) flashId = null;
		}, FLASH_MS);
		// Let go before the flash ran out: drop it, or the next focus on the same mark would not flash.
		return () => {
			clearTimeout(timer);
			untrack(() => {
				if (flashId === id) flashId = null;
			});
		};
	});

	onDestroy(() => {
		listen(false);
		clearPeekTimer();
		if (peekHide) clearTimeout(peekHide);
	});
</script>

<div class="img-annot" class:is-creating={creating} bind:this={rootEl} data-image-annotator>
	{#if onOpen}
		<!-- The layer is a sibling, not inside: its marks are buttons of their own. -->
		<button
			type="button"
			class="artifact-img-open"
			class:is-openable={openable}
			aria-label={openLabel}
			tabindex={openable ? 0 : -1}
			onclick={() => {
				if (openable && imgEl) onOpen?.(imgEl);
			}}
		>
			<img bind:this={imgEl} {src} {alt} class="artifact-img max-w-full max-h-full block my-0 mx-auto" onload={onImageLoad} data-copy-image />
		</button>
	{:else}
		<img bind:this={imgEl} {src} {alt} class="artifact-img max-w-full max-h-full block my-0 mx-auto" onload={onImageLoad} data-copy-image />
	{/if}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="img-annot-layer"
		class:is-unmeasured={!shown}
		style={layerStyle}
		title={creating ? labels.region : undefined}
		onpointerdown={onLayerDown}
		data-annot-layer
	>
		{#each marks as mark (mark.id)}
			<button
				type="button"
				class={markClass(mark)}
				class:is-flash={flashId === mark.id}
				style={toPercentStyle(mark.box)}
				data-annotation-id={mark.id}
				title={markTitle(mark)}
				aria-label={labels.mark(mark.n, mark.body)}
				onpointerdown={(ev) => onMarkDown(ev, mark.id)}
				onpointerup={clearPeekTimer}
				onpointerleave={clearPeekTimer}
				onpointercancel={clearPeekTimer}
				oncontextmenu={onMarkMenu}
				onclick={() => onMarkClick(mark.id)}
			>
				<span class="img-annot-num" aria-hidden="true">{mark.n}</span>
				{#if peekId === mark.id}
					<span class="img-annot-peek" role="tooltip">{markTitle(mark)}</span>
				{/if}
			</button>
		{/each}
		{#if liveBox}
			<div class="img-annot-live" style={toPercentStyle(liveBox)} aria-hidden="true"></div>
		{/if}
		{#if pendingBox}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="img-annot-pending"
				class:is-compact={compact}
				style={toPercentStyle(pendingBox)}
				title={labels.pending}
				data-annot-pending
				onpointerdown={onPendingDown}
			>
				{#each compact ? COMPACT_HANDLES : HANDLES as handle (handle)}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<span
						class="img-annot-handle is-{handle}"
						class:is-outside={compact}
						title={labels.resize}
						data-handle={handle}
						onpointerdown={(ev) => onHandleDown(ev, handle)}
					></span>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.img-annot {
		position: relative;
		height: 100%;
	}
	/*
	 * The button fills the annotator so the picture keeps fitting exactly as it did, and it lets the
	 * pointer through: only the picture is a target, not the empty space around a small one.
	 */
	.artifact-img-open {
		display: block;
		width: 100%;
		height: 100%;
		padding: 0;
		border: 0;
		background: none;
		pointer-events: none;
	}
	/* The picture itself stays a target either way: its own menu copies the pixels. */
	.artifact-img-open .artifact-img {
		pointer-events: auto;
	}
	.artifact-img-open.is-openable .artifact-img {
		cursor: zoom-in;
	}
	.artifact-img-open:focus-visible {
		outline: none;
	}
	.artifact-img-open:focus-visible .artifact-img {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.img-annot-layer {
		position: absolute;
		z-index: 1;
		pointer-events: none;
	}
	/* Until the image has loaded and is laid out the boxes have nothing to be a percentage of. */
	.img-annot-layer.is-unmeasured {
		visibility: hidden;
	}
	.img-annot.is-creating .img-annot-layer {
		pointer-events: auto;
		cursor: crosshair;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
	}

	/* An annotation: open is solid accent, a draft dotted and lighter, a resolved one grey. */
	.img-annot-mark {
		position: absolute;
		z-index: 1;
		box-sizing: border-box;
		margin: 0;
		padding: 0;
		border: 2px solid var(--accent);
		border-radius: 2px;
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--pane) 70%, transparent);
		color: inherit;
		font: inherit;
		cursor: pointer;
		pointer-events: auto;
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
	}
	.img-annot-mark:hover {
		background: color-mix(in srgb, var(--accent) 24%, transparent);
	}
	.img-annot-mark:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--accent-border);
	}
	.img-annot-mark.is-draft {
		border-style: dotted;
		background: color-mix(in srgb, var(--accent) 8%, transparent);
	}
	.img-annot-mark.is-resolved {
		border-color: color-mix(in srgb, var(--muted) 75%, transparent);
		background: color-mix(in srgb, var(--muted) 10%, transparent);
	}
	.img-annot-mark.is-resolved:hover {
		background: color-mix(in srgb, var(--muted) 18%, transparent);
	}
	/* The image changed since: the box may no longer sit on what it meant. */
	.img-annot-mark.is-stale {
		border-style: dashed;
	}
	.img-annot-mark.is-flash {
		animation: img-annot-flash 1.4s ease-out;
	}
	/* While annotating the boxes let a drag through; their numbers still open them. */
	.img-annot.is-creating .img-annot-mark {
		pointer-events: none;
	}
	.img-annot.is-creating .img-annot-num {
		pointer-events: auto;
		cursor: pointer;
	}

	.img-annot-num {
		position: absolute;
		left: 0;
		top: 0;
		transform: translate(-50%, -50%);
		box-sizing: border-box;
		min-width: 18px;
		height: 18px;
		padding: 0 4px;
		border-radius: 999px;
		background: var(--accent);
		color: var(--pane);
		font-family: var(--mono);
		font-size: 11px;
		font-weight: 600;
		line-height: 18px;
		text-align: center;
		box-shadow: var(--shadow-md);
	}
	.img-annot-num::before {
		content: '';
		position: absolute;
		inset: -4px;
	}
	.img-annot-mark.is-draft .img-annot-num {
		background: var(--pane);
		color: var(--accent);
		border: 1px dotted var(--accent);
		line-height: 16px;
	}
	.img-annot-mark.is-resolved .img-annot-num {
		background: var(--muted);
	}
	.img-annot-mark.is-stale .img-annot-num {
		border: 1px dashed var(--pane);
		line-height: 16px;
	}

	.img-annot-peek {
		position: absolute;
		left: 0;
		top: calc(100% + 6px);
		z-index: 4;
		width: max-content;
		max-width: min(260px, 70vw);
		padding: 6px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-md);
		font-size: 12px;
		line-height: 1.4;
		text-align: left;
		white-space: pre-wrap;
		word-break: break-word;
		pointer-events: none;
	}

	.img-annot-live {
		position: absolute;
		z-index: 3;
		box-sizing: border-box;
		border: 2px dashed var(--accent);
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		pointer-events: none;
	}

	/* The box waiting for its remark: solid, lifted, with a handle on each corner. */
	.img-annot-pending {
		position: absolute;
		z-index: 2;
		box-sizing: border-box;
		border: 2px solid var(--accent);
		border-radius: 2px;
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		box-shadow: 0 0 0 1px var(--pane), var(--shadow-md);
		cursor: move;
		pointer-events: auto;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
	}
	/* A small box is grabbed over at least 24px (40px by finger, below), centred on it. */
	.img-annot-pending::before {
		content: '';
		position: absolute;
		inset: min(0px, calc(50% - 12px));
	}
	.img-annot-handle {
		position: absolute;
		width: 16px;
		height: 16px;
		transform: translate(-50%, -50%);
		touch-action: none;
	}
	.img-annot-handle::after {
		content: '';
		position: absolute;
		left: 50%;
		top: 50%;
		width: 10px;
		height: 10px;
		box-sizing: border-box;
		transform: translate(-50%, -50%);
		border: 2px solid var(--accent);
		border-radius: 2px;
		background: var(--pane);
	}
	.img-annot-handle.is-nw {
		left: 0;
		top: 0;
		cursor: nwse-resize;
	}
	.img-annot-handle.is-ne {
		left: 100%;
		top: 0;
		cursor: nesw-resize;
	}
	.img-annot-handle.is-sw {
		left: 0;
		top: 100%;
		cursor: nesw-resize;
	}
	.img-annot-handle.is-se {
		left: 100%;
		top: 100%;
		cursor: nwse-resize;
	}
	/* The one handle of a small box: drawn on its corner, grabbed just outside it. */
	.img-annot-handle.is-outside {
		transform: translate(-4px, -4px);
	}
	.img-annot-handle.is-outside::after {
		left: 4px;
		top: 4px;
	}

	@keyframes img-annot-flash {
		0% {
			box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 60%, transparent);
		}
		35% {
			box-shadow: 0 0 0 8px color-mix(in srgb, var(--accent) 35%, transparent);
		}
		100% {
			box-shadow: 0 0 0 1px color-mix(in srgb, var(--pane) 70%, transparent);
		}
	}

	@media (max-width: 680px) {
		/* A finger needs 40px: the number and the handles grow their hit area, not their look. */
		.img-annot-num::before {
			inset: -11px;
		}
		.img-annot-pending::before {
			inset: min(0px, calc(50% - 20px));
		}
		.img-annot-handle {
			width: 40px;
			height: 40px;
		}
		.img-annot-handle::after {
			width: 14px;
			height: 14px;
		}
	}
</style>
