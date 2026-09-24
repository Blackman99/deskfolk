<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import type { Attachment } from '@real-bot/protocol';
	import { originalSizeForBlob } from '../api.ts';
	import type { Copy } from '../copy.ts';
	import { formatFileSize } from './attachments.ts';
	import { fileProgressPercent, formatFileProgress, type FileLoadOptions, type FileProgress } from '../file-progress.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { holdBack } from './enlarged-images.ts';
	import { artifactKind, svgDisplayBlob } from '../overlays/artifacts.ts';

	/** Viewport rectangle of the picture that was clicked. */
	export type ImageOrigin = { top: number; left: number; width: number; height: number };

	interface Props {
		/** When set, bytes come from this attachment (or a workspace GET for a handoff chip). */
		attachment?: Attachment | null;
		/** Body image with no attachment row. Loaded with a workspace GET. */
		relpath?: string | null;
		/**
		 * A picture the opener already has on screen, as an object URL it keeps owning. Nothing is
		 * fetched and nothing is revoked here; `attachment` / `relpath` then only name it.
		 */
		src?: string | null;
		/** When `src` is the Mac's scaled copy, the original's length: the enlargement offers it. */
		srcOriginalSize?: number | null;
		/**
		 * A smaller copy of the same picture the opener already shows — the chip's thumbnail — as an
		 * object URL it keeps owning. It is on screen at once and has the picture's proportions, so
		 * the frame grows once, straight to where the picture will sit, and the real bytes replace
		 * it in place.
		 */
		placeholder?: string | null;
		/** Where the inline picture sits, so the enlargement can grow out of it. */
		origin?: ImageOrigin | null;
		api: MessengerApi | null;
		t: Copy;
		onClose: () => void;
	}

	let { attachment = null, relpath = null, src = null, srcOriginalSize = null, placeholder = null, origin = null, api, t, onClose }: Props = $props();

	const name = $derived(
		attachment?.original_filename ||
			relpath?.split('/').pop() ||
			attachment?.workspace_relpath ||
			relpath ||
			''
	);
	const path = $derived(attachment?.workspace_relpath || relpath || '');

	let url = $state<string | null>(null);
	/** Fetched here — the original, once asked for, over a copy the opener handed over. */
	const shown = $derived(url ?? src);
	/** The Mac's 256 px copy, fetched here when the opener had nothing to stand in for the picture. */
	let standIn = $state<string | null>(null);
	/**
	 * What is on screen: the picture, or while it is on its way something with its proportions.
	 * Growing to a guessed box first and then to the picture's own shape was a second resize.
	 */
	const displayed = $derived(shown ?? placeholder ?? standIn);
	const standingIn = $derived(!shown && Boolean(displayed));
	/**
	 * A phone is shown the Mac's 1600 px copy, which is a few hundred KB where a keyframe is several
	 * MB. This is the original's length while the copy is what is on screen.
	 */
	let reducedFrom = $state<number | null>(null);
	const offerOriginal = $derived(url ? reducedFrom : src ? srcOriginalSize : null);
	let originalProgress = $state<FileProgress | null>(null);
	const originalBytes = $derived(originalProgress ? formatFileProgress(originalProgress, formatFileSize) : null);
	/** Whatever is still arriving for this enlargement. Closing it stops the download. */
	let loadAbort: AbortController | null = null;
	let failed = $state(false);
	let loading = $state(true);
	/**
	 * Room for that offer, kept from the start on a remote host: the copy it comes with nearly
	 * always has one, and making room only when it arrived moved the picture a second time.
	 */
	const reserveOffer = $derived(offerOriginal !== null || (api?.kind === 'remote' && !src && loading));
	/** Bytes of this open. Kept out of the load effect so a progress tick cannot start another fetch. */
	let progress = $state<FileProgress | null>(null);
	let request = 0;
	/** Which file the current fetch is for. Writing the blob URL must not start another one. */
	let loadedKey = '';
	let root = $state<HTMLElement | null>(null);
	let frame = $state<HTMLImageElement | null>(null);
	/** The first paint keeps the thumbnail's rectangle; the next frame lets it grow. */
	let grown = $state(false);
	let phase = $state<'open' | 'back'>('open');
	let settled = $state<ImageOrigin | null>(null);
	let instant = $state(false);
	let closing = false;
	let closeTimer = 0;

	const loadPercent = $derived(progress ? fileProgressPercent(progress) : null);
	const loadBytes = $derived(progress ? formatFileProgress(progress, formatFileSize) : null);

	const frameBox = $derived.by((): ImageOrigin | null => {
		if (phase === 'back') return origin;
		if (!grown || !settled) return origin ?? settled;
		return settled;
	});

	function place(box: ImageOrigin): string {
		return `top:${box.top}px;left:${box.left}px;width:${box.width}px;height:${box.height}px;`;
	}

	/** A large centered box to hold the spinner until the picture's own size is known. */
	function stageBox(): ImageOrigin {
		const bounds = root?.getBoundingClientRect();
		const width = bounds && bounds.width > 2 ? bounds.width : window.innerWidth || 800;
		const height = bounds && bounds.height > 2 ? bounds.height : window.innerHeight || 600;
		const top = bounds && bounds.width > 2 ? bounds.top : 0;
		const left = bounds && bounds.width > 2 ? bounds.left : 0;
		const frameW = Math.max(1, Math.min(960, width - 48));
		const frameH = Math.max(1, Math.min(height * 0.8, height - 96));
		return {
			top: top + (height - frameH) / 2,
			left: left + (width - frameW) / 2,
			width: frameW,
			height: frameH
		};
	}

	function measure(): void {
		if (phase === 'back') return;
		const picture = frame;
		const host = root;
		if (!picture || !host || !picture.naturalWidth || !picture.naturalHeight) {
			if (grown && (!origin || failed)) settled = stageBox();
			return;
		}
		const bounds = host.getBoundingClientRect();
		// Room under the picture for the offer of the original, above the caption.
		const reserve = reserveOffer ? 44 : 0;
		const maxW = Math.max(1, bounds.width - 48);
		const maxH = Math.max(1, bounds.height - 96 - reserve);
		const ratio = picture.naturalWidth / picture.naturalHeight;
		let width = maxW;
		let height = width / ratio;
		if (height > maxH) {
			height = maxH;
			width = height * ratio;
		}
		settled = {
			top: bounds.top + (bounds.height - reserve - height) / 2,
			left: bounds.left + (bounds.width - width) / 2,
			width,
			height
		};
	}

	/** One picture's bytes, by attachment, handed-over path or body path. */
	function fetchPicture(
		client: MessengerApi,
		file: Attachment | null,
		workspacePath: string | null,
		onProgress: ((next: FileProgress) => void) | undefined,
		options: FileLoadOptions,
	): Promise<Blob> {
		if (!file) return client.getWorkspaceFileBlob(workspacePath!, onProgress, options);
		return file.id.startsWith('handoff:')
			? client.getWorkspaceFileBlob(file.workspace_relpath, onProgress, options)
			: client.getAttachmentBlob(file.id, onProgress, options);
	}

	async function load(
		client: MessengerApi | null,
		file: Attachment | null,
		workspacePath: string | null
	): Promise<void> {
		const mine = ++request;
		const label = file?.original_filename || workspacePath?.split('/').pop() || file?.workspace_relpath || workspacePath || '';
		const previous = url;
		const previousStandIn = standIn;
		url = null;
		standIn = null;
		reducedFrom = null;
		originalProgress = null;
		failed = false;
		loading = true;
		loadAbort?.abort();
		const abort = new AbortController();
		loadAbort = abort;
		// Remotely the enlargement starts from the Mac's copy; a local read is free, so it is the original.
		const remote = client?.kind === 'remote';
		const size = remote ? ('preview' as const) : undefined;
		// The attachment's size is the original's, which is not what a copy will weigh.
		const knownTotal = !size && typeof file?.size === 'number' && file.size > 0 ? file.size : null;
		progress = { loaded: 0, total: knownTotal };
		if (previous) URL.revokeObjectURL(previous);
		if (previousStandIn) URL.revokeObjectURL(previousStandIn);
		if (!client || (!file && !workspacePath)) {
			failed = true;
			loading = false;
			return;
		}
		try {
			// With nothing on hand to stand in for it, a remote picture's 256 px copy comes first:
			// 15 KB that says what shape to grow to, and stays on screen while the larger copy
			// arrives. A picture already that small is the picture itself, and nothing more is asked.
			if (remote && !placeholder && artifactKind(label) === 'image') {
				const small = await fetchPicture(client, file, workspacePath, undefined, { size: 'thumb', signal: abort.signal });
				if (mine !== request) return;
				if (originalSizeForBlob(small) === null) {
					url = URL.createObjectURL(small);
					return;
				}
				standIn = URL.createObjectURL(small);
			}
			const onProgress = (next: FileProgress) => {
				if (mine !== request) return;
				progress = { loaded: next.loaded, total: next.total ?? knownTotal };
			};
			const source = await fetchPicture(client, file, workspacePath, onProgress, { size, signal: abort.signal });
			if (mine !== request) return;
			const display = artifactKind(label) === 'svg' ? await svgDisplayBlob(source) : source;
			if (mine !== request) return;
			url = URL.createObjectURL(display);
			reducedFrom = originalSizeForBlob(source);
		} catch {
			if (mine !== request) return;
			failed = true;
		} finally {
			if (mine === request) loading = false;
		}
	}

	/** The picture itself, in place of the copy on screen. The copy stays up while it arrives. */
	async function loadOriginal(): Promise<void> {
		const client = api;
		const total = offerOriginal;
		const file = attachment;
		const workspacePath = relpath;
		if (!client || total === null || originalProgress || (!file && !workspacePath)) return;
		const mine = request;
		loadAbort?.abort();
		const abort = new AbortController();
		loadAbort = abort;
		originalProgress = { loaded: 0, total };
		try {
			const onProgress = (next: FileProgress) => {
				if (mine !== request) return;
				originalProgress = { loaded: next.loaded, total: next.total ?? total };
			};
			const source = await fetchPicture(client, file, workspacePath, onProgress, { signal: abort.signal });
			if (mine !== request) return;
			const previous = url;
			url = URL.createObjectURL(source);
			reducedFrom = null;
			if (previous) URL.revokeObjectURL(previous);
		} catch {
			// The copy stays on screen, and so does the offer.
		} finally {
			if (mine === request) originalProgress = null;
		}
	}

	// Room for the offer, made or given back, moves the picture up or back to centre.
	$effect(() => {
		void reserveOffer;
		if (displayed && grown) untrack(measure);
	});

	$effect(() => {
		if (src) return;
		const client = api;
		const file = attachment;
		const workspacePath = relpath;
		const key = `${file?.id ?? ''}|${workspacePath ?? ''}|${client ? '1' : '0'}`;
		if (!client || key === loadedKey) return;
		loadedKey = key;
		void load(client, file, workspacePath);
	});

	// With a picture it grew out of, the frame waits there until the first pixels — the
	// placeholder, the 256 px copy, or the picture — say what shape to grow to, and grows once;
	// the progress meanwhile sits in the middle of the screen. Only with nowhere to wait (no
	// origin) or nothing coming (a failure) does it take a centered box. The fetch effect above
	// does not read `settled`, so this write cannot refetch.
	$effect(() => {
		if (!grown || phase === 'back' || displayed) return;
		if (origin && !failed) return;
		settled = stageBox();
	});
	const waitingInPlace = $derived(grown && phase !== 'back' && loading && !displayed && Boolean(origin) && !failed);

	onMount(() => {
		instant = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		// The phone's Back closes this, the way ✕ does, instead of leaving the page under it.
		const releaseBack = holdBack(requestClose);
		if (instant || !origin) {
			grown = true;
		} else {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					grown = true;
				});
			});
		}
		return () => {
			releaseBack();
			document.body.style.overflow = previousOverflow;
			window.clearTimeout(closeTimer);
		};
	});

	onDestroy(() => {
		request += 1;
		loadAbort?.abort();
		if (url) URL.revokeObjectURL(url);
		if (standIn) URL.revokeObjectURL(standIn);
	});

	function requestClose(): void {
		if (closing) return;
		closing = true;
		if (instant || !origin || !grown) {
			onClose();
			return;
		}
		// Freeze the enlarged box first: the phase change reads `origin`, and a resize from that
		// write would otherwise remeasure the destination while the frame is already going back.
		phase = 'back';
		closeTimer = window.setTimeout(onClose, 360);
	}

	function onFrameEnd(ev: TransitionEvent): void {
		if (phase !== 'back' || ev.target !== ev.currentTarget || ev.propertyName !== 'width') return;
		window.clearTimeout(closeTimer);
		onClose();
	}

	function onKeydown(ev: KeyboardEvent): void {
		if (ev.key !== 'Escape') return;
		ev.preventDefault();
		ev.stopImmediatePropagation();
		requestClose();
	}

	function onBackdrop(ev: MouseEvent): void {
		const target = ev.target;
		if (!(target instanceof Element)) return;
		if (target.closest('.msg-image-frame, .msg-image-close, .msg-image-original')) return;
		requestClose();
	}
</script>

<svelte:window onkeydowncapture={onKeydown} onresize={measure} />

{#snippet progressBar()}
	<div
		class="msg-image-loading-bar"
		role="progressbar"
		aria-label={t.stream.artifactLoading}
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={loadPercent ?? undefined}
	>
		<div
			class="msg-image-loading-fill"
			class:is-indeterminate={loadPercent === null}
			style={loadPercent === null ? undefined : `width: ${loadPercent}%`}
		></div>
	</div>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	bind:this={root}
	class="msg-image-lightbox"
	class:is-shown={grown && phase !== 'back'}
	class:is-back={phase === 'back'}
	class:is-instant={instant}
	role="presentation"
	onclick={onBackdrop}
>
	<!-- The frame grows out of the clicked picture. The dialog role stays on the picture's box. -->
	<div
		class="msg-image-frame"
		class:is-centered={!frameBox}
		class:is-loading={loading && !displayed}
		style={frameBox ? place(frameBox) : undefined}
		role="dialog"
		aria-modal="true"
		aria-label={name || path}
		ontransitionend={onFrameEnd}
	>
		{#if displayed}
			<img bind:this={frame} src={displayed} alt={name || path} class="msg-image-full" data-copy-image onload={measure} />
			{#if standingIn && loading}
				<!-- The stand-in is on screen at the picture's size; what is still arriving shows on it. -->
				<div class="msg-image-progress" role="status" aria-live="polite" aria-busy="true">
					<span class="msg-image-progress-ring" aria-hidden="true"></span>
					<span class="msg-image-progress-copy">{t.stream.artifactLoading}</span>
					{#if loadBytes}
						<span class="msg-image-progress-bytes">{loadBytes}</span>
					{/if}
					{@render progressBar()}
				</div>
			{/if}
		{:else if failed}
			<p class="msg-image-status">{t.stream.artifactMissing}</p>
		{:else if loading}
			<div class="msg-image-loading" role="status" aria-live="polite" aria-busy="true">
				<span class="msg-image-loading-ring" aria-hidden="true"></span>
				<p class="msg-image-loading-copy">{t.stream.artifactLoading}</p>
				{#if loadBytes}
					<p class="msg-image-loading-bytes">{loadBytes}</p>
				{/if}
				{@render progressBar()}
			</div>
		{/if}
	</div>
	{#if waitingInPlace}
		<!-- The frame waits in the picture it grows out of, too small to read: the progress sits here. -->
		<div class="msg-image-waiting" aria-hidden="true">
			<span class="msg-image-progress-ring"></span>
			<span class="msg-image-waiting-copy">{t.stream.artifactLoading}</span>
			{#if loadBytes}
				<span class="msg-image-progress-bytes">{loadBytes}</span>
			{/if}
			{@render progressBar()}
		</div>
	{/if}
	<button type="button" class="msg-image-close" aria-label={t.common.close} onclick={requestClose}>
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
	</button>
	{#if offerOriginal !== null && shown}
		<button
			type="button"
			class="msg-image-original"
			aria-busy={originalProgress ? 'true' : undefined}
			disabled={originalProgress !== null}
			onclick={loadOriginal}
		>
			{originalProgress ? t.stream.imageOriginalLoading(originalBytes) : t.stream.imageOriginal(formatFileSize(offerOriginal))}
		</button>
	{/if}
	{#if name}
		<p class="msg-image-caption">{name}</p>
	{/if}
</div>

<style>
	.msg-image-lightbox {
		position: fixed;
		inset: 0;
		z-index: 1300;
		background: rgba(0, 0, 0, 0);
		transition: background-color 220ms ease;
	}

	.msg-image-lightbox.is-shown {
		background: color-mix(in srgb, var(--bg) 92%, transparent);
	}

	.msg-image-frame {
		position: fixed;
		margin: 0;
		overflow: hidden;
		/* The picture fills this box. Without a clamp it grows the box back to its own size. */
		min-width: 0;
		min-height: 0;
		max-width: none;
		border-radius: 6px;
		background: var(--pane);
		/* Text and the bar appear once the box has grown past the thumbnail. */
		container-type: size;
		transition:
			top 220ms ease,
			left 220ms ease,
			width 220ms ease,
			height 220ms ease,
			border-radius 220ms ease;
	}

	.msg-image-lightbox.is-shown .msg-image-frame {
		border-radius: 12px;
	}

	.msg-image-frame.is-centered {
		top: 50%;
		left: 50%;
		width: min(960px, calc(100vw - 48px));
		height: min(80vh, calc(100vh - 96px));
		transform: translate(-50%, -50%);
	}

	.msg-image-full {
		display: block;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
		max-width: none;
		/* Follow the frame as it grows out of a cropped thumb and shrinks back into it. */
		object-fit: cover;
		background: var(--pane);
	}

	.msg-image-caption,
	.msg-image-close,
	.msg-image-original {
		opacity: 0;
		pointer-events: none;
		transition: opacity 180ms ease;
	}

	.msg-image-lightbox.is-shown .msg-image-caption,
	.msg-image-lightbox.is-shown .msg-image-close,
	.msg-image-lightbox.is-shown .msg-image-original {
		opacity: 1;
		pointer-events: auto;
	}

	.msg-image-original {
		position: fixed;
		left: 50%;
		bottom: 50px;
		transform: translateX(-50%);
		max-width: calc(100vw - 48px);
		height: 32px;
		padding: 0 14px;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--btn-secondary-bg);
		color: var(--ink);
		font-size: 12px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		font-variant-numeric: tabular-nums;
		cursor: pointer;
	}

	.msg-image-original:hover,
	.msg-image-original:focus-visible {
		background: var(--btn-secondary-hover);
		outline: none;
	}

	.msg-image-original:disabled {
		cursor: progress;
	}

	.msg-image-caption {
		position: fixed;
		left: 50%;
		bottom: 22px;
		transform: translateX(-50%);
		margin: 0;
		max-width: calc(100vw - 48px);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: var(--ink-secondary);
	}

	.msg-image-status {
		margin: 0;
		padding: 28px 20px;
		color: var(--ink);
		font-size: 13px;
	}

	/* On the stand-in, along its bottom edge: the picture's shape stays in view. */
	.msg-image-progress {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 18px 12px 12px;
		background: linear-gradient(to top, var(--pane), color-mix(in srgb, var(--pane) 88%, transparent), transparent);
		color: var(--ink);
		font-size: 12px;
		font-weight: 600;
		pointer-events: none;
	}

	.msg-image-progress .msg-image-loading-bar {
		display: block;
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		width: auto;
		height: 3px;
		border-radius: 0;
	}

	.msg-image-progress-ring {
		width: 14px;
		height: 14px;
		flex: 0 0 auto;
		border-radius: 50%;
		border: 2px solid var(--line-hover);
		border-top-color: var(--accent);
		animation: msg-image-spin 0.9s linear infinite;
	}

	.msg-image-progress-bytes {
		margin-left: auto;
		font-family: var(--mono);
		font-size: 11.5px;
		font-weight: 400;
		color: var(--ink-secondary);
		font-variant-numeric: tabular-nums;
	}

	/* While the frame waits in the picture it grows out of, too small to hold this itself. */
	.msg-image-waiting {
		position: fixed;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		min-width: 168px;
		padding: 14px 18px;
		border-radius: 12px;
		background: var(--pane);
		box-shadow: var(--shadow-lg);
		color: var(--ink);
		font-size: 13px;
		font-weight: 600;
		pointer-events: none;
	}

	.msg-image-waiting .msg-image-progress-ring {
		width: 24px;
		height: 24px;
		border-width: 2.5px;
	}

	.msg-image-waiting .msg-image-progress-bytes {
		margin-left: 0;
	}

	.msg-image-waiting .msg-image-loading-bar {
		display: block;
		width: 140px;
	}

	.msg-image-loading {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 4px;
		min-width: 0;
		min-height: 0;
	}

	.msg-image-loading-ring {
		/* Fits inside the thumbnail the frame grows out of, then steps up once the frame has. */
		width: 16px;
		height: 16px;
		flex: 0 0 auto;
		border-radius: 50%;
		border: 2px solid var(--line-hover);
		border-top-color: var(--accent);
		background: var(--pane);
		box-shadow: var(--shadow-sm);
		animation: msg-image-spin 0.9s linear infinite;
	}

	.msg-image-loading-copy,
	.msg-image-loading-bytes {
		/* In the DOM for the status, painted only once the frame is past thumbnail size. */
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
	}

	.msg-image-loading-bar {
		display: none;
		width: min(160px, 78%);
		height: 4px;
		border-radius: 999px;
		background: var(--line-hover);
		overflow: hidden;
	}

	.msg-image-loading-fill {
		height: 100%;
		width: 0;
		border-radius: inherit;
		background: var(--accent);
		transition: width 0.2s ease;
	}

	.msg-image-loading-fill.is-indeterminate {
		width: 40%;
		animation: msg-image-sweep 1.2s ease-in-out infinite;
	}

	@container (min-width: 148px) and (min-height: 96px) {
		.msg-image-loading-ring {
			width: 28px;
			height: 28px;
			border-width: 2.5px;
		}

		.msg-image-loading-copy,
		.msg-image-loading-bytes {
			position: static;
			width: auto;
			height: auto;
			margin: 0;
			overflow: visible;
			clip: auto;
			max-width: 100%;
			text-align: center;
			color: var(--ink);
		}

		.msg-image-loading-copy {
			font-size: 13px;
			font-weight: 600;
		}

		.msg-image-loading-bytes {
			font-family: var(--mono);
			font-size: 11.5px;
			color: var(--ink-secondary);
		}

		.msg-image-loading-bar {
			display: block;
		}
	}

	@keyframes msg-image-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes msg-image-sweep {
		0% {
			transform: translateX(-110%);
		}
		100% {
			transform: translateX(260%);
		}
	}

	.msg-image-close {
		position: fixed;
		top: 16px;
		right: 16px;
		z-index: 1;
		width: 36px;
		height: 36px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 999px;
		background: var(--btn-secondary-bg);
		color: var(--ink);
		cursor: pointer;
	}

	.msg-image-close:hover,
	.msg-image-close:focus-visible {
		background: var(--btn-secondary-hover);
		outline: none;
	}

	.msg-image-lightbox.is-instant,
	.msg-image-lightbox.is-instant .msg-image-frame,
	.msg-image-lightbox.is-instant .msg-image-caption,
	.msg-image-lightbox.is-instant .msg-image-close,
	.msg-image-lightbox.is-instant .msg-image-original {
		transition: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.msg-image-lightbox,
		.msg-image-frame,
		.msg-image-caption,
		.msg-image-close,
		.msg-image-original {
			transition: none;
		}

		.msg-image-loading-ring,
		.msg-image-progress-ring {
			animation: none;
		}

		.msg-image-loading-fill.is-indeterminate {
			width: 100%;
			animation: none;
		}
	}
</style>
