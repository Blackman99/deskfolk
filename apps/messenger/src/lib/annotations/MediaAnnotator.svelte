<!--
	音视频时间点批注（#29）：自带 <audio controls> / <video controls>，好读播放位置和时长。播放器下面一条细
	时间轴：已有批注按编号画成点（时间点）或条（时间段），状态配色，陈旧的虚线；点一下就跳过去。
	「在此处批注」把当前播放位置记成一个点；这个点等着写意见时，「到此为止」把它延长成一段到当前位置。
	视频的裁图是起点那一帧，在 crop() 里才取；音频没有裁图。
-->
<script lang="ts" module>
	/** Every string this annotator shows; the preview hands them in from its copy. */
	export type MediaAnnotatorLabels = {
		/** The button that takes the playback position as a point. */
		markHere: string;
		markHereHint: string;
		/** The button that turns the pending point into a span ending at the playback position. */
		endHere: string;
		endHereHint: string;
		/** The timeline's accessible name. */
		timeline: string;
		/** The tooltip on the time readout of the anchor that is waiting for its remark. */
		pending: string;
		/** Why nothing can be annotated: the player has no duration to measure against. */
		durationUnknown: string;
		/** Why 「到此为止」 is off: the playback position is too close to the start. */
		spanTooShort: string;
		/** Why 「到此为止」 is off: the point lies past the end the player now reports. */
		spanPastEnd: string;
		/** Added to a stale mark's tooltip. */
		stale: string;
	};
</script>

<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import type { Annotation, MediaTimeAnchor } from '@real-bot/protocol';
	import { toNorm, type EncodedCrop } from './region-box.ts';
	import {
		captureFrame,
		drawVideoFrame,
		durationMs,
		layoutTimeline,
		markTitle,
		percentOf,
		pointAt,
		pointRoom,
		secondsToMs,
		spanBetween,
		timeLabel,
		type FrameDrawer,
		type SpanCheck,
		type TimelineMark
	} from './media-time.ts';

	interface Props {
		src: string;
		kind: 'audio' | 'video';
		/** This file's media_time rows, in display order: numbered 1..n. */
		annotations: Annotation[];
		/** Seek to this one and flash its mark when it changes, or when `focusSeq` asks again. */
		focusId: string | null;
		/** Bumped on every request to go to `focusId`, so the one already focused is revealed again. */
		focusSeq?: number;
		/** Part of the adapters' shared contract; the buttons are the mode here, so it is not read. */
		active?: boolean;
		/** Whether a new annotation may be started at all; existing ones are drawn either way. */
		enabled: boolean;
		labels: MediaAnnotatorLabels;
		/** A point was chosen: the preview opens the composer and calls `crop()` on save (video only). */
		onDraft: (draft: { anchor: MediaTimeAnchor; crop?: () => Promise<EncodedCrop | null> }) => void;
		/** A mark was clicked (after the player has jumped to it). */
		onPick: (id: string) => void;
		/** The anchor waiting for its remark. */
		pending?: MediaTimeAnchor | null;
		/** 「到此为止」 turned the pending anchor into this span. Without it the button is not offered. */
		onPendingChange?: (anchor: MediaTimeAnchor) => void;
		/** Escape with an anchor pending. */
		onCancel?: () => void;
		/** Draws the frame for a crop; tests hand in a double, since happy-dom has no canvas. */
		drawFrame?: FrameDrawer;
		/** The player could not play the source (a stream that broke off, a file that went away). */
		onError?: () => void;
	}

	let {
		src,
		kind,
		annotations,
		focusId,
		focusSeq = 0,
		enabled,
		labels,
		onDraft,
		onPick,
		pending = null,
		onPendingChange,
		onCancel,
		drawFrame = drawVideoFrame,
		onError
	}: Props = $props();

	let media = $state<HTMLAudioElement | HTMLVideoElement | null>(null);
	let root = $state<HTMLDivElement | null>(null);
	let lanesEl = $state<HTMLDivElement | null>(null);
	/** Playback position and duration in seconds, as the element last reported them. */
	let now = $state(0);
	let total = $state(Number.NaN);
	/** The element has reported its metadata once: an unknown duration after that is worth a word. */
	let metaSeen = $state(false);
	let flashId = $state<string | null>(null);
	/** Where the pending point was set: a span grows from here, whichever way the person seeks. */
	let spanOrigin = $state<number | null>(null);
	/** The timeline's width and a point mark's width (its `--lane-h`), in pixels; 0 until laid out. */
	let trackPx = $state(0);
	let pointPx = $state(0);
	/**
	 * Crops under way. A crop seeks the element to the anchor's start and back: meanwhile what the
	 * element reports is that detour, not where the person is, so it is not read and the buttons wait.
	 */
	let cropping = $state(0);

	/** The anchor last handed out, for a `crop()` that runs after the preview has let go of `pending`. */
	let latest: MediaTimeAnchor | null = null;
	let lastFocus: string | null = null;
	let lastFocusSeq = 0;
	let flashTimer: ReturnType<typeof setTimeout> | null = null;
	let cropQueue: Promise<unknown> = Promise.resolve();

	const dur = $derived(durationMs(total));
	const layout = $derived(layoutTimeline(annotations, dur, pointRoom(trackPx, pointPx)));
	/** The point the span would grow from: the one we set, or whatever point the preview holds. */
	const origin = $derived.by((): number | null => {
		const held = pending;
		if (!held) return null;
		if (held.end_ms === undefined) return held.start_ms;
		return spanOrigin !== null && (spanOrigin === held.start_ms || spanOrigin === held.end_ms) ? spanOrigin : held.start_ms;
	});
	const spanCheck = $derived<SpanCheck | null>(origin === null ? null : spanBetween(origin, secondsToMs(now), dur));
	const spanHint = $derived.by((): string | null => {
		if (!spanCheck || spanCheck.ok) return null;
		if (spanCheck.reason === 'too-short') return labels.spanTooShort;
		if (spanCheck.reason === 'past-end') return labels.spanPastEnd;
		return metaSeen ? labels.durationUnknown : null;
	});
	const scale = $derived(dur ?? pending?.duration_ms ?? null);
	const showTimeline = $derived(scale !== null && (layout.marks.length > 0 || pending !== null || enabled));
	const canExtend = $derived(Boolean(pending && onPendingChange));

	function sync(): void {
		const el = media;
		if (!el || cropping > 0) return;
		now = Number.isFinite(el.currentTime) ? el.currentTime : 0;
		total = el.duration;
	}

	/* Lanes are dealt by how wide a point's mark really is on this timeline (40px on a phone). */
	$effect(() => {
		const el = lanesEl;
		if (!el) return;
		const measure = (): void => {
			trackPx = el.clientWidth;
			const lane = Number.parseFloat(getComputedStyle(el).getPropertyValue('--lane-h'));
			pointPx = Number.isFinite(lane) && lane > 0 ? lane : 0;
		};
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	});

	function onMeta(): void {
		metaSeen = true;
		sync();
	}

	function onEmptied(): void {
		metaSeen = false;
		sync();
	}

	$effect(() => {
		if (media) untrack(sync);
	});

	function seek(ms: number): void {
		const el = media;
		if (!el) return;
		try {
			el.currentTime = ms / 1000;
		} catch {
			return;
		}
		now = ms / 1000;
	}

	/** The frame at the anchor's start, whichever anchor is current when the preview asks. */
	function crop(): Promise<EncodedCrop | null> {
		const run = async (): Promise<EncodedCrop | null> => {
			const el = media;
			const at = (pending ?? latest)?.start_ms;
			if (!el || kind !== 'video' || at === undefined) return null;
			cropping += 1;
			try {
				return await captureFrame(el as HTMLVideoElement, at, drawFrame);
			} finally {
				cropping -= 1;
				sync();
			}
		};
		// One seek at a time: a second crop must not read the first one's detour as where playback was.
		const next = cropQueue.then(run, run);
		cropQueue = next.catch(() => null);
		return next;
	}

	function markHere(): void {
		const el = media;
		if (!el || !enabled || pending || cropping > 0) return;
		const anchor = pointAt(el.currentTime, el.duration);
		if (!anchor) return;
		latest = anchor;
		spanOrigin = anchor.start_ms;
		onDraft(kind === 'video' ? { anchor, crop } : { anchor });
	}

	function endHere(): void {
		const el = media;
		const held = pending;
		if (!el || !held || !onPendingChange || cropping > 0) return;
		const from = origin ?? held.start_ms;
		const check = spanBetween(from, secondsToMs(el.currentTime), durationMs(el.duration));
		sync();
		if (!check.ok) return;
		latest = check.anchor;
		spanOrigin = from;
		onPendingChange(check.anchor);
	}

	function pick(mark: TimelineMark, ev: MouseEvent): void {
		ev.stopPropagation();
		seek(mark.start_ms);
		onPick(mark.id);
	}

	/** A click on the bare timeline seeks there; the native controls stay the keyboard way to seek. */
	function onTrackClick(ev: MouseEvent): void {
		if ((ev.target as Element | null)?.closest?.('[data-mark-id]')) return;
		const rect = lanesEl?.getBoundingClientRect();
		if (!rect) return;
		if (!(rect.width > 0) || scale === null) return;
		seek(Math.round(toNorm(ev.clientX, ev.clientY, rect).x * scale));
	}

	/*
	 * Escape drops the pending anchor wherever focus is: in the player, on the page (「在此处批注」 is
	 * gone once the point is taken, so focus falls to the body), anywhere in the pane. It is heard on
	 * the document, before the shell's window handler would close the whole preview. The composer
	 * handles its own Escape first and stops it there.
	 */
	$effect(() => {
		if (!pending || !onCancel || typeof document === 'undefined') return;
		const onKey = (ev: KeyboardEvent): void => {
			if (ev.key !== 'Escape' || ev.defaultPrevented || ev.isComposing) return;
			ev.preventDefault();
			ev.stopPropagation();
			onCancel?.();
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	});

	function markEl(id: string): HTMLElement | null {
		for (const el of root?.querySelectorAll<HTMLElement>('[data-mark-id]') ?? []) {
			if (el.dataset.markId === id) return el;
		}
		return null;
	}

	$effect(() => {
		const id = focusId;
		const seq = focusSeq;
		// The rows are read below, so a snapshot runs this again: only a new request seeks.
		if (id === lastFocus && seq === lastFocusSeq) return;
		if (!id) {
			lastFocus = null;
			lastFocusSeq = seq;
			return;
		}
		const row = annotations.find((item) => item.id === id);
		// Not ours yet: the rows may land after the focus does, and this runs again when they do.
		if (!row || row.anchor_kind !== 'media_time') return;
		lastFocus = id;
		lastFocusSeq = seq;
		untrack(() => {
			const start = (row.anchor as MediaTimeAnchor).start_ms;
			if (row.stale?.kind === 'missing' || (dur !== null && start > dur)) return;
			seek(start);
			flashId = id;
			if (flashTimer) clearTimeout(flashTimer);
			flashTimer = setTimeout(() => (flashId = null), 1400);
			void tick().then(() => markEl(id)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
		});
	});

	onDestroy(() => {
		if (flashTimer) clearTimeout(flashTimer);
	});

	const pct = (value: number): string => `${value.toFixed(3)}%`;
</script>

<div class="media-annot flex flex-col gap-6 w-full min-h-0" class:is-video={kind === 'video'} bind:this={root} data-media-annotator>
	{#if kind === 'video'}
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			class="media-annot-el"
			controls
			playsinline
			preload="metadata"
			{src}
			bind:this={media}
			ontimeupdate={sync}
			onseeking={sync}
			onseeked={sync}
			onloadedmetadata={onMeta}
			ondurationchange={onMeta}
			onemptied={onEmptied}
			onerror={() => onError?.()}
		></video>
	{:else}
		<audio
			class="media-annot-el"
			controls
			preload="metadata"
			{src}
			bind:this={media}
			ontimeupdate={sync}
			onseeking={sync}
			onseeked={sync}
			onloadedmetadata={onMeta}
			ondurationchange={onMeta}
			onemptied={onEmptied}
			onerror={() => onError?.()}
		></audio>
	{/if}

	{#if showTimeline && scale !== null}
		<!-- A click on the bare timeline is a shortcut; the native controls are the keyboard way to seek. -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<div class="media-annot-timeline" role="group" aria-label={labels.timeline} onclick={onTrackClick} data-media-timeline>
			<div class="media-annot-lanes" style:--lanes={layout.lanes} bind:this={lanesEl}>
				{#if spanCheck?.ok && pending && pending.end_ms === undefined}
					<!-- What 「到此为止」 would make right now. -->
					<div
						class="media-annot-preview"
						style:left={pct(percentOf(spanCheck.anchor.start_ms, scale))}
						style:width={pct(percentOf(spanCheck.anchor.end_ms ?? spanCheck.anchor.start_ms, scale) - percentOf(spanCheck.anchor.start_ms, scale))}
						aria-hidden="true"
					></div>
				{/if}
				{#each layout.marks as mark (mark.id)}
					{@const title = markTitle(mark, labels.stale)}
					<button
						type="button"
						class="media-annot-mark"
						class:is-point={mark.end_ms === null}
						class:is-span={mark.end_ms !== null}
						class:is-open={mark.status === 'open'}
						class:is-draft={mark.status === 'draft'}
						class:is-resolved={mark.status === 'resolved'}
						class:is-stale={mark.stale}
						class:is-flash={flashId === mark.id}
						style:left={pct(mark.left)}
						style:width={mark.end_ms === null ? undefined : pct(mark.width)}
						style:--lane={mark.lane}
						{title}
						aria-label={title}
						data-mark-id={mark.id}
						onclick={(ev) => pick(mark, ev)}
					>
						{#if mark.end_ms !== null}<span class="media-annot-fill" aria-hidden="true"></span>{/if}
						<span class="media-annot-badge mono" aria-hidden="true">{mark.n}</span>
					</button>
				{/each}
				{#if pending}
					<div
						class="media-annot-pending"
						class:is-point={pending.end_ms === undefined}
						class:is-span={pending.end_ms !== undefined}
						style:left={pct(percentOf(pending.start_ms, scale))}
						style:width={pending.end_ms === undefined ? undefined : pct(percentOf(pending.end_ms, scale) - percentOf(pending.start_ms, scale))}
						aria-hidden="true"
						data-media-pending
					></div>
				{/if}
				{#if dur !== null}
					<div class="media-annot-playhead" style:left={pct(percentOf(secondsToMs(now), dur))} aria-hidden="true"></div>
				{/if}
			</div>
		</div>
	{/if}

	{#if pending || enabled}
		<div class="media-annot-actions flex flex-wrap items-center gap-6">
			{#if pending}
				<span class="media-annot-range mono text-11" title={labels.pending} data-media-pending-label>{timeLabel(pending)}</span>
				{#if canExtend}
					<button
						type="button"
						class="media-annot-btn is-primary"
						title={labels.endHereHint}
						disabled={!spanCheck?.ok || cropping > 0}
						onclick={endHere}
					>{labels.endHere}</button>
				{/if}
				{#if canExtend && spanHint}
					<span class="media-annot-hint text-11" aria-live="polite">{spanHint}</span>
				{/if}
			{:else}
				<button
					type="button"
					class="media-annot-btn"
					title={dur === null ? labels.durationUnknown : labels.markHereHint}
					disabled={dur === null || cropping > 0}
					onclick={markHere}
				>{labels.markHere}</button>
				{#if dur === null && metaSeen}
					<span class="media-annot-hint text-11" aria-live="polite">{labels.durationUnknown}</span>
				{/if}
			{/if}
		</div>
	{/if}
</div>

<style>
	.media-annot-el {
		display: block;
		width: 100%;
	}
	/*
	 * A tall video must not push the timeline and the buttons out of the pane: the whole annotator
	 * keeps to the pane's height and the picture gives way (letterboxed), down to a usable minimum;
	 * below that the pane scrolls.
	 */
	.media-annot.is-video {
		max-height: 100%;
	}
	.media-annot.is-video .media-annot-el {
		flex: 0 1 auto;
		min-height: 96px;
		border-radius: var(--radius-md);
	}
	.media-annot-timeline,
	.media-annot-actions {
		flex-shrink: 0;
	}

	.media-annot-timeline {
		--lane-h: 20px;
		--badge: 16px;
		padding: 4px 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		cursor: pointer;
	}
	.media-annot-lanes {
		position: relative;
		height: calc(var(--lanes, 1) * var(--lane-h));
		border-radius: var(--radius-sm);
		background: var(--line-subtle);
	}

	.media-annot-mark {
		--mk: var(--accent);
		position: absolute;
		top: calc(var(--lane, 0) * var(--lane-h));
		height: var(--lane-h);
		padding: 0;
		border: 0;
		background: none;
		color: var(--ink);
		font: inherit;
		cursor: pointer;
		z-index: 1;
	}
	.media-annot-mark.is-resolved {
		--mk: var(--muted);
	}
	.media-annot-mark.is-point {
		width: var(--lane-h);
		transform: translateX(-50%);
	}
	.media-annot-mark.is-span {
		min-width: 4px;
	}
	.media-annot-mark:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
		border-radius: var(--radius-sm);
	}

	/* The span's bar; the badge sits on its start. */
	.media-annot-fill {
		position: absolute;
		left: 0;
		right: 0;
		top: 50%;
		height: 8px;
		margin-top: -4px;
		box-sizing: border-box;
		border: 1px solid var(--mk);
		border-radius: 4px;
		background: color-mix(in srgb, var(--mk) 70%, transparent);
	}
	.media-annot-badge {
		position: absolute;
		top: 50%;
		left: 50%;
		min-width: var(--badge);
		height: var(--badge);
		padding: 0 4px;
		box-sizing: border-box;
		transform: translate(-50%, -50%);
		border: 1px solid var(--mk);
		border-radius: 999px;
		background: var(--mk);
		color: #fff;
		font-size: 10px;
		font-weight: 650;
		line-height: calc(var(--badge) - 2px);
		text-align: center;
		white-space: nowrap;
	}
	.media-annot-mark.is-span .media-annot-badge {
		left: 0;
		transform: translate(0, -50%);
	}

	/* A draft: a lighter fill, a dotted outline. */
	.media-annot-mark.is-draft .media-annot-fill {
		border-style: dotted;
		background: color-mix(in srgb, var(--mk) 18%, transparent);
	}
	.media-annot-mark.is-draft .media-annot-badge {
		border-width: 1.5px;
		border-style: dotted;
		background: var(--pane);
		color: var(--accent);
	}
	/* Stale: dashed, and fainter. */
	.media-annot-mark.is-stale .media-annot-fill {
		border-style: dashed;
		background: color-mix(in srgb, var(--mk) 30%, transparent);
	}
	.media-annot-mark.is-stale .media-annot-badge {
		border-style: dashed;
		border-width: 1.5px;
	}
	.media-annot-mark.is-stale.is-open .media-annot-badge,
	.media-annot-mark.is-stale.is-resolved .media-annot-badge {
		background: color-mix(in srgb, var(--mk) 55%, var(--pane));
	}

	.media-annot-mark:hover .media-annot-badge,
	.media-annot-mark:hover .media-annot-fill {
		box-shadow: 0 0 0 2px var(--accent-border);
	}
	.media-annot-mark.is-flash {
		z-index: 2;
	}
	.media-annot-mark.is-flash .media-annot-badge,
	.media-annot-mark.is-flash .media-annot-fill {
		animation: media-annot-flash 1.4s ease-out;
	}
	@keyframes media-annot-flash {
		0%,
		30% {
			box-shadow: 0 0 0 4px var(--accent-border);
		}
		100% {
			box-shadow: 0 0 0 0 transparent;
		}
	}

	/* The anchor waiting for its remark: hatched, dashed, across every lane. */
	.media-annot-pending {
		position: absolute;
		top: -2px;
		bottom: -2px;
		pointer-events: none;
		z-index: 3;
	}
	.media-annot-pending.is-point {
		width: 0;
		border-left: 2px dashed var(--accent);
		margin-left: -1px;
	}
	.media-annot-pending.is-point::after {
		content: '';
		position: absolute;
		top: 50%;
		left: -6px;
		width: 10px;
		height: 10px;
		margin-top: -5px;
		border: 2px solid var(--accent);
		border-radius: 50%;
		background: var(--pane);
		animation: media-annot-pulse 1.6s ease-in-out infinite;
	}
	.media-annot-pending.is-span {
		box-sizing: border-box;
		min-width: 2px;
		border: 1.5px dashed var(--accent);
		border-radius: var(--radius-sm);
		background: repeating-linear-gradient(
			135deg,
			color-mix(in srgb, var(--accent) 30%, transparent) 0 4px,
			transparent 4px 8px
		);
	}
	@keyframes media-annot-pulse {
		50% {
			box-shadow: 0 0 0 4px var(--accent-tint);
		}
	}
	.media-annot-preview {
		position: absolute;
		top: 0;
		bottom: 0;
		box-sizing: border-box;
		border: 1px dashed var(--accent-border);
		background: var(--accent-tint);
		pointer-events: none;
	}
	.media-annot-playhead {
		position: absolute;
		top: -3px;
		bottom: -3px;
		width: 2px;
		margin-left: -1px;
		background: var(--ink);
		opacity: 0.55;
		pointer-events: none;
		z-index: 2;
	}

	.media-annot-btn {
		min-height: 28px;
		padding: 0 12px;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-sm);
		background: var(--accent-tint);
		color: var(--accent);
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}
	.media-annot-btn.is-primary {
		border-color: transparent;
		background: var(--accent);
		color: #fff;
	}
	.media-annot-btn:hover:not(:disabled) {
		border-color: var(--accent);
	}
	.media-annot-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.media-annot-range {
		color: var(--ink);
	}
	.media-annot-hint {
		color: var(--muted);
	}

	@media (prefers-reduced-motion: reduce) {
		.media-annot-pending.is-point::after,
		.media-annot-mark.is-flash .media-annot-badge,
		.media-annot-mark.is-flash .media-annot-fill {
			animation: none;
		}
	}

	@media (max-width: 680px) {
		/* A finger needs 40px: every lane is that tall, a point that wide, a span at least that wide. */
		.media-annot-timeline {
			--lane-h: 40px;
			--badge: 20px;
			padding: 2px 20px;
		}
		/*
		 * A short span keeps its true width on screen; only what the finger can hit grows, evenly on
		 * both sides, so at most 20px past either end: the timeline's padding, never the pane's width.
		 */
		.media-annot-mark.is-span::before {
			content: '';
			position: absolute;
			top: 0;
			bottom: 0;
			left: 50%;
			width: max(100%, 40px);
			transform: translateX(-50%);
		}
		.media-annot-badge {
			font-size: 11px;
		}
		.media-annot-btn {
			min-height: 40px;
			padding: 0 16px;
		}
	}
</style>
