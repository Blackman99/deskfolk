<!--
	HTML 元素批注（#28）：自带预览 iframe，sandbox 和今天一样（从不加 allow-same-origin）。只在批注模式下往页面
	最前面注入选取器（html-picker.ts）并重新加载，退出时再加载一次不带脚本的；页面上的描边和编号都由选取器画，
	普通视图不注入，批注只在列表里。批注模式下 iframe 上方一条细栏：编号（悬停看意见，点一下在列表里定位）、
	提示、「外层 / 内层」（手机上没有方向键）。没有裁图：跨源页面的像素读不到。
	页面装在一台缩小的设备里：电脑、平板、手机，整台设备等比缩进窗格（不放大过真实尺寸）。平板和手机按移动浏览器
	排版：页面声明的视口宽度，没声明就是 980（内容更宽就按内容宽），再缩到屏幕宽。换设备重新加载，页面按新尺寸
	从头初始化；页面前面总有一个小助手（html-viewport.ts）报内容宽度、在锁了滚动的长页面上放开纵向滚动。
	「全屏」让整块预览（批注条和设备）铺满窗口，设备可以放大过真实尺寸：用 Popover API 提到顶层，节点不挪，页面
	不重新加载。Esc 退出，焦点在页面里时由小助手把 Esc 转出来；全屏时选中一个元素也会退出，好写批注。
-->
<script lang="ts" module>
	import type { ViewportDevice } from '../overlays/html-viewport.ts';

	/** Every string this annotator shows; the preview hands them in from its copy. */
	export type HtmlAnnotatorLabels = {
		/** The bar's hint while choosing an element. */
		hint: string;
		/** The keyboard help beside the hint (hidden on phones). */
		keysHint: string;
		/** The bar's hint while a chosen element waits for its remark. */
		pendingHint: string;
		/** The button that moves the outline to the enclosing element. */
		outer: string;
		/** The button that moves the outline to the first element inside. */
		inner: string;
		/** The accessible name of the row of numbered marks. */
		marks: string;
		/** The accessible name of one numbered mark. */
		markLabel: (n: number) => string;
		/** Added to the tooltip of a mark whose file changed since it was written. */
		stale: string;
		/** Added to the tooltip of a mark the page no longer has. */
		notFound: string;
		/** The bar's hint when the picker never answered: the page's scripts are blocked here. */
		blocked: string;
		/** The device switcher under the page: its accessible name and each device's name. */
		viewport: {
			group: string;
			/** The size's tooltip when a phone or tablet zooms out on a page laid out wider than it. */
			zoomed: (width: number) => string;
			/** The full-screen button, before and while the preview fills the window. */
			enlarge: string;
			shrink: string;
		} & Record<ViewportDevice, string>;
	};
</script>

<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { holdFullscreenPreview } from '../overlays/fullscreen-preview.ts';
	import type { Annotation, HtmlElementAnchor } from '@real-bot/protocol';
	import { HTML_PREVIEW_SANDBOX, htmlPreviewBlob, pageCspNonce } from '../overlays/artifacts.ts';
	import {
		VIEWPORT_DEVICES,
		fitViewport,
		loadViewportDevice,
		pageLayoutWidth,
		saveViewportDevice,
		viewportMeta,
		viewportMessage,
		viewportHelperMarkup,
		ENLARGED_MAX_SCALE,
	} from '../overlays/html-viewport.ts';
	import type { EncodedCrop } from './region-box.ts';
	import {
		annotatorSource,
		focusMessage,
		marksMessage,
		navMessage,
		newChannel,
		pickerMarks,
		validatePickerMessage,
		type PickerMark,
	} from './html-picker.ts';

	interface Props {
		/** The file's raw source. */
		html: string;
		scheme: 'light' | 'dark';
		/** The iframe's title (the path). */
		title: string;
		/** This file's html_element rows, in display order: numbered 1..n. */
		annotations: Annotation[];
		/** Scroll the page to this one and flash it when it changes (annotate mode only: normal view is not injected). */
		focusId: string | null;
		/** Bumped on every request to go to `focusId`, so the one already focused is revealed again. */
		focusSeq?: number;
		/** Annotate mode: the picker is injected, hover outlines, a click chooses. */
		active: boolean;
		/** Whether a new annotation may be started at all; existing ones are drawn either way. */
		enabled: boolean;
		labels: HtmlAnnotatorLabels;
		/** An element was chosen. There is never a crop: the page's pixels are cross-origin. */
		onDraft: (draft: { anchor: HtmlElementAnchor; crop?: () => Promise<EncodedCrop | null> }) => void;
		/** A numbered mark in the bar was clicked. */
		onPick: (id: string) => void;
		/** The anchor waiting for its remark: drawn in the page with a heavier outline. */
		pending?: HtmlElementAnchor | null;
		/** Another element was chosen (click, ↑ ↓, 外层 / 内层) while one was pending. Without it, a new draft. */
		onPendingChange?: (anchor: HtmlElementAnchor) => void;
		/** Escape while choosing or with an anchor pending, in the page or in the messenger. */
		onCancel?: () => void;
		/** After the file changed: the rows whose element the page no longer has (with the same text). */
		onMissing?: (ids: string[]) => void;
		/** The CSP nonce for the page's scripts; the messenger page's own when left out. Tests pass one. */
		nonce?: string | null;
		/** How long after the page loaded the picker may take to say hello before the bar says it is blocked. */
		readyWaitMs?: number;
	}

	let {
		html,
		scheme,
		title,
		annotations,
		focusId,
		focusSeq = 0,
		active,
		enabled,
		labels,
		onDraft,
		onPick,
		pending = null,
		onPendingChange,
		onCancel,
		onMissing,
		nonce,
		readyWaitMs = 2000,
	}: Props = $props();

	let frame = $state<HTMLIFrameElement | null>(null);
	let src = $state<string | null>(null);
	/** Bumped when the picker exited on its own, so the page reloads (with a new one while still annotating). */
	let reloads = $state(0);
	/** The port the picker handed over; messages into the page go only through it. */
	let port = $state.raw<MessagePort | null>(null);
	let chipsEl = $state<HTMLElement | null>(null);
	let flashId = $state<string | null>(null);
	let notFound = $state<ReadonlySet<string>>(new Set());
	/** This injection's channel id; null while the page runs without the picker. */
	let channel: string | null = null;
	let rev = 0;
	let idsByN = new Map<number, string>();
	let checkedNs = new Set<number>();
	/** What went through the port last: the same list again (new row objects, same content) is not resent. */
	let sentKey = '';
	let lastMissing = '';
	/** A focus asked for before the picker was ready. */
	let focusN = 0;
	let flashTimer: ReturnType<typeof setTimeout> | null = null;
	/** Whether the page was injected on the last build, and whether the next load should take focus. */
	let wasInjecting = false;
	let focusOnLoad = false;
	/** The picker exited on Escape in the page, where focus was; its successor may take it back. */
	let reloadFocus = false;
	/**
	 * The page loaded with the picker but it never said hello: a CSP that allows no inline script
	 * (the hosted remote build's hash-only policy, which the blob page inherits) blocked it.
	 */
	let blocked = $state(false);
	let readyTimer: ReturnType<typeof setTimeout> | null = null;

	let device = $state<ViewportDevice>(loadViewportDevice());
	/** The room the device may take, measured off the stage. */
	let roomWidth = $state(0);
	let roomHeight = $state(0);
	const meta = $derived(viewportMeta(html));
	/** How wide the page said its content is, once this build of it has loaded. */
	let contentWidth = $state<number | null>(null);
	/** This build's channel for the helper's report. */
	let viewportChannel: string | null = null;
	const pageWidth = $derived(pageLayoutWidth(device, meta, contentWidth));
	/** The preview fills the window. */
	let enlarged = $state(false);
	let rootEl = $state<HTMLElement | null>(null);
	const layout = $derived(
		fitViewport(device, { width: roomWidth, height: roomHeight }, pageWidth, enlarged ? ENLARGED_MAX_SCALE : 1),
	);

	const injecting = $derived(active || pending != null);
	const picking = $derived(active && enabled);
	const marks = $derived(pickerMarks(annotations));
	const drawn = $derived(
		annotations
			.map((row, i) => ({ row, n: i + 1 }))
			.filter(({ row }) => row.anchor_kind === 'html_element' && row.stale?.kind !== 'missing'),
	);

	$effect(() => {
		const raw = html;
		const sch = scheme;
		const on = injecting;
		// A new device is a fresh load, so a page that sizes itself in script starts at the new size.
		const touch = device !== 'desktop';
		void reloads;
		const ch = on ? newChannel() : null;
		const vch = newChannel();
		const cspNonce = nonce === undefined ? pageCspNonce() : nonce;
		const viewport = viewportHelperMarkup({ channel: vch, touch, nonce: cspNonce });
		const url = URL.createObjectURL(htmlPreviewBlob(annotatorSource(raw, { scheme: sch, nonce: cspNonce, channel: ch, viewport })));
		// Only entering annotate mode (or the picker's own restart) hands the page the keyboard; a
		// reload because the file or the theme changed must not take focus from wherever it is.
		focusOnLoad = on && (!wasInjecting || reloadFocus);
		reloadFocus = false;
		wasInjecting = on;
		untrack(() => {
			dropPort();
			clearReadyWait();
			blocked = false;
			channel = ch;
			viewportChannel = vch;
			contentWidth = null;
			src = url;
		});
		return () => URL.revokeObjectURL(url);
	});

	$effect(() => {
		const target = port;
		const list = marks;
		const pendingSelector = pending?.selector ?? null;
		const choosing = picking;
		if (!target || !channel) return;
		untrack(() => sendMarks(target, list, pendingSelector, choosing));
	});

	$effect(() => {
		const id = focusId;
		void focusSeq;
		if (!id) return;
		untrack(() => focusOn(id));
	});

	// A row that is no longer re-checked (deleted, or its file is back to what was annotated) is not
	// missing any more, whether or not the page is open in annotate mode.
	$effect(() => {
		const checked = new Set(marks.filter((m) => m.check).map((m) => annotations[m.n - 1]?.id));
		untrack(() => {
			const kept = [...notFound].filter((id) => checked.has(id));
			if (kept.length !== notFound.size) reportMissing(kept);
		});
	});

	$effect(() => {
		if (!enlarged) return;
		return holdFullscreenPreview(() => { enlarged = false; });
	});

	// Into the top layer, where no pane's containment or clipping reaches it. Moving the node to the
	// body instead would reload the iframe; this leaves it where it is.
	$effect(() => {
		const el = rootEl;
		const on = enlarged;
		if (!el || typeof el.showPopover !== 'function') return;
		if (on) {
			el.setAttribute('popover', 'manual');
			try {
				el.showPopover();
			} catch {
				// Already showing.
			}
			return () => {
				try {
					el.hidePopover();
				} catch {
					// Gone with the preview.
				}
				el.removeAttribute('popover');
			};
		}
	});

	onDestroy(() => {
		dropPort();
		clearReadyWait();
		if (flashTimer) clearTimeout(flashTimer);
	});

	function clearReadyWait(): void {
		if (readyTimer) clearTimeout(readyTimer);
		readyTimer = null;
	}

	function dropPort(): void {
		try {
			port?.close();
		} catch {
			// Already closed.
		}
		port = null;
		sentKey = '';
	}

	function post(target: MessagePort, message: unknown): void {
		try {
			target.postMessage(message);
		} catch {
			// The page went away with its port.
		}
	}

	function sendMarks(target: MessagePort, list: PickerMark[], pendingSelector: string | null, choosing: boolean): void {
		if (!channel) return;
		// A snapshot that hands in new row objects with the same content would otherwise redraw the
		// page's marks (cutting a flash short) and run its re-anchor check again for nothing.
		const ids = annotations.map((row) => row.id);
		const key = JSON.stringify([list, pendingSelector, choosing, ids]);
		if (key !== sentKey) {
			sentKey = key;
			rev += 1;
			idsByN = new Map(ids.map((id, i) => [i + 1, id]));
			checkedNs = new Set(list.filter((m) => m.check).map((m) => m.n));
			post(target, marksMessage(channel, list, { pending: pendingSelector, picking: choosing, rev }));
		}
		if (focusN) {
			post(target, focusMessage(channel, focusN));
			focusN = 0;
		}
	}

	function focusOn(id: string): void {
		const n = annotations.findIndex((row) => row.id === id) + 1;
		if (n < 1) return;
		flashId = id;
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flashId = null), 1400);
		if (port && channel) post(port, focusMessage(channel, n));
		else if (injecting) focusN = n;
		void tick().then(() => {
			for (const chip of chipsEl?.querySelectorAll<HTMLElement>('[data-annotation-id]') ?? []) {
				if (chip.dataset.annotationId === id) chip.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
			}
		});
	}

	function onWindowMessage(ev: MessageEvent): void {
		const said = viewportMessage(ev, frame?.contentWindow ?? null, viewportChannel);
		if (said?.type === 'content') {
			// Only the first: widening the layout can widen a page sized off the viewport, and so on.
			if (contentWidth === null) contentWidth = said.width;
			return;
		}
		if (said?.type === 'escape') {
			enlarged = false;
			return;
		}
		const reply = validatePickerMessage(ev, frame?.contentWindow ?? null, channel);
		if (!reply) return;
		switch (reply.type) {
			case 'ready':
				dropPort();
				clearReadyWait();
				blocked = false;
				port = reply.port;
				return;
			case 'pick':
				chosen(reply.anchor);
				return;
			case 'cancel':
				// The picker has exited and cleaned up; the page reloads — without it once annotate mode is off.
				dropPort();
				reloadFocus = true;
				reloads += 1;
				onCancel?.();
				return;
			case 'missing':
				missingAnswer(reply.ns, reply.rev);
				return;
		}
	}

	function chosen(anchor: HtmlElementAnchor): void {
		if (!enabled || (!active && !pending)) return;
		// The remark is written in the pane, under the full-screen preview.
		enlarged = false;
		if (pending && onPendingChange) onPendingChange(anchor);
		else onDraft({ anchor });
	}

	function missingAnswer(ns: number[], answered: number): void {
		if (answered !== rev) return;
		const ids = ns
			.filter((n) => checkedNs.has(n))
			.map((n) => idsByN.get(n))
			.filter((id): id is string => typeof id === 'string');
		reportMissing(ids);
	}

	/** Remember which rows the page could not find, and tell the preview when that set changed. */
	function reportMissing(ids: string[]): void {
		notFound = new Set(ids);
		const key = [...ids].sort().join('\n');
		if (key === lastMissing) return;
		lastMissing = key;
		onMissing?.(ids);
	}

	function onDocumentKey(ev: KeyboardEvent): void {
		// Inner surfaces (the composer, the file list, find) stop Escape first; what is left here
		// would close the pane, so while choosing it only leaves annotate mode.
		if (ev.key !== 'Escape' || ev.defaultPrevented || ev.isComposing) return;
		if (enlarged) {
			ev.preventDefault();
			ev.stopPropagation();
			enlarged = false;
			return;
		}
		if (!onCancel || (!active && !pending)) return;
		ev.preventDefault();
		ev.stopPropagation();
		onCancel();
	}

	function isEditable(el: Element | null): boolean {
		if (!el) return false;
		const tag = el.localName;
		return tag === 'input' || tag === 'textarea' || tag === 'select' || (el as HTMLElement).isContentEditable === true;
	}

	function onFrameLoad(): void {
		if (injecting && !port && channel) {
			const waited = channel;
			clearReadyWait();
			readyTimer = setTimeout(() => {
				readyTimer = null;
				if (!port && channel === waited) blocked = true;
			}, readyWaitMs);
		}
		// Keys go to the picker (↑ ↓ Enter Esc) once the frame has focus — taken only on entering
		// annotate mode, and never from a field the person is typing in.
		const take = focusOnLoad;
		focusOnLoad = false;
		if (!take || !picking || pending || !frame) return;
		if (isEditable(document.activeElement)) return;
		frame.focus();
	}

	function nav(dir: 'up' | 'down'): void {
		if (port && channel) post(port, navMessage(channel, dir));
	}

	function pickDevice(next: ViewportDevice): void {
		if (next === device) return;
		device = next;
		saveViewportDevice(next);
	}

	function chipTitle(row: Annotation, n: number): string {
		const lines = [`${n}. ${row.body}`];
		if (notFound.has(row.id)) lines.push(labels.notFound);
		else if (row.stale) lines.push(labels.stale);
		return lines.join('\n');
	}
</script>

<svelte:window onmessage={onWindowMessage} />
<svelte:document onkeydown={onDocumentKey} />

<div class="html-annot min-w-0" class:is-enlarged={enlarged} data-html-annotator bind:this={rootEl}>
	{#if injecting}
		<div class="html-annot-bar flex items-center gap-6 min-w-0 px-6 py-4" data-html-annot-bar data-annotator-bar>
			{#if drawn.length > 0}
				<ol class="html-annot-marks flex items-center gap-4 m-0 p-0 min-w-0" aria-label={labels.marks} bind:this={chipsEl}>
					{#each drawn as { row, n } (row.id)}
						<li class="flex">
							<button
								type="button"
								class="html-annot-chip text-11"
								class:is-open={row.status === 'open'}
								class:is-draft={row.status === 'draft'}
								class:is-resolved={row.status === 'resolved'}
								class:is-stale={row.stale != null}
								class:is-missing={notFound.has(row.id)}
								class:is-flash={flashId === row.id}
								data-annotation-id={row.id}
								aria-label={labels.markLabel(n)}
								title={chipTitle(row, n)}
								onclick={() => onPick(row.id)}
							>{n}</button>
						</li>
					{/each}
				</ol>
			{/if}
			<span class="html-annot-hint text-12 flex-1 min-w-0 truncate">{pending ? labels.pendingHint : picking ? (blocked ? labels.blocked : labels.hint) : ''}</span>
			{#if picking && !pending && !blocked}
				<span class="html-annot-keys text-11">{labels.keysHint}</span>
			{/if}
			{#if picking}
				<button type="button" class="html-annot-nav text-12" disabled={!port} onclick={() => nav('up')}>{labels.outer}</button>
				<button type="button" class="html-annot-nav text-12" disabled={!port} onclick={() => nav('down')}>{labels.inner}</button>
			{/if}
		</div>
	{/if}
	<div class="html-stage" class:is-dark={scheme === 'dark'} class:is-annotating={active} data-html-stage>
		<div class="html-stage-room" bind:clientWidth={roomWidth} bind:clientHeight={roomHeight}>
			<div
				class="html-device is-{device}"
				data-device={device}
				style:width="{layout.frame.width}px"
				style:height="{layout.frame.height}px"
				style:--screen-w="{layout.screen.width}px"
				style:--screen-h="{layout.screen.height}px"
				style:--bezel-side="{layout.bezel.side}px"
				style:--bezel-top="{layout.bezel.top}px"
				style:--bezel-bottom="{layout.bezel.bottom}px"
				style:--device-radius="{layout.radius}px"
				style:--device-base="{layout.base}px"
			>
				<div class="html-device-body">
					<div class="html-device-screen" class:is-picking={picking}>
						{#if src}
							<iframe
								bind:this={frame}
								{title}
								class="artifact-frame"
								{src}
								sandbox={HTML_PREVIEW_SANDBOX}
								referrerpolicy="no-referrer"
								style:color-scheme={scheme}
								style:width="{layout.page.width}px"
								style:height="{layout.page.height}px"
								style:transform="scale({layout.page.scale})"
								onload={onFrameLoad}
							></iframe>
						{/if}
					</div>
				</div>
				{#if device === 'desktop'}
					<div class="html-device-base" aria-hidden="true"></div>
				{/if}
			</div>
		</div>
		<div class="html-viewport-bar" role="group" aria-label={labels.viewport.group} data-html-viewport-bar>
			{#each VIEWPORT_DEVICES as option (option)}
				<button
					type="button"
					class="html-viewport-option"
					aria-pressed={device === option}
					title={labels.viewport[option]}
					data-viewport-device={option}
					onclick={() => pickDevice(option)}
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						{#if option === 'desktop'}
							<rect x="4" y="4" width="16" height="11" rx="1.5"></rect>
							<path d="M2 19h20"></path>
						{:else if option === 'tablet'}
							<rect x="5" y="2" width="14" height="20" rx="2"></rect>
							<path d="M11 18h2"></path>
						{:else}
							<rect x="7" y="2" width="10" height="20" rx="2.5"></rect>
							<path d="M11 5h2"></path>
						{/if}
					</svg>
					<span class="html-viewport-name">{labels.viewport[option]}</span>
				</button>
			{/each}
			<span
				class="html-viewport-size"
				data-html-viewport-size
				title={layout.page.width !== layout.width ? labels.viewport.zoomed(Math.round(layout.page.width)) : undefined}
			>{layout.width} × {layout.height} · {Math.round(layout.scale * 100)}%</span>
			<button
				type="button"
				class="html-viewport-option html-viewport-enlarge"
				aria-pressed={enlarged}
				aria-label={enlarged ? labels.viewport.shrink : labels.viewport.enlarge}
				title={enlarged ? labels.viewport.shrink : labels.viewport.enlarge}
				data-html-enlarge
				onclick={() => (enlarged = !enlarged)}
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					{#if enlarged}
						<path d="M9 4v5H4"></path>
						<path d="M15 4v5h5"></path>
						<path d="M9 20v-5H4"></path>
						<path d="M15 20v-5h5"></path>
					{:else}
						<path d="M4 9V4h5"></path>
						<path d="M20 9V4h-5"></path>
						<path d="M4 15v5h5"></path>
						<path d="M20 15v5h-5"></path>
					{/if}
				</svg>
			</button>
		</div>
	</div>
</div>

<style>
	.html-annot {
		display: flex;
		flex-direction: column;
		gap: 6px;
		width: 100%;
		height: 100%;
		min-height: 0;
	}
	/* Filling the window. As a popover it is in the top layer; this also undoes the UA's popover box. */
	.html-annot.is-enlarged {
		position: fixed;
		inset: 0;
		z-index: 1000;
		width: auto;
		height: auto;
		max-width: none;
		max-height: none;
		margin: 0;
		padding: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right))
			max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
		border: 0;
		overflow: hidden;
		color: var(--ink);
		background: var(--bg);
	}
	.html-annot.is-enlarged .html-stage {
		border-radius: var(--radius-lg);
	}
	.html-annot-bar {
		flex: none;
		min-height: 32px;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-md);
		background: var(--accent-tint);
		color: var(--ink);
	}
	.html-annot-marks {
		list-style: none;
		flex: none;
		max-width: 50%;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.html-annot-chip {
		min-width: 22px;
		height: 22px;
		padding: 0 6px;
		border: 1px solid var(--accent);
		border-radius: 999px;
		background: var(--accent);
		color: #fff;
		font: inherit;
		font-size: 11px;
		line-height: 20px;
		font-variant-numeric: tabular-nums;
		cursor: pointer;
	}
	.html-annot-chip.is-draft {
		background: var(--pane);
		color: var(--accent);
		border-style: dotted;
	}
	.html-annot-chip.is-resolved {
		background: var(--btn-secondary-bg);
		color: var(--muted);
		border-color: var(--line-hover);
	}
	.html-annot-chip.is-stale {
		border-style: dashed;
	}
	.html-annot-chip.is-missing {
		opacity: 0.55;
		text-decoration: line-through;
	}
	.html-annot-chip:hover {
		box-shadow: 0 0 0 2px var(--accent-border);
	}
	.html-annot-chip.is-flash {
		animation: html-annot-flash 1.4s ease-out;
	}
	@keyframes html-annot-flash {
		0%,
		40% {
			box-shadow: 0 0 0 4px var(--accent-border);
		}
		100% {
			box-shadow: 0 0 0 0 transparent;
		}
	}
	.html-annot-hint {
		color: var(--ink);
	}
	.html-annot-keys {
		flex: none;
		color: var(--muted);
		white-space: nowrap;
	}
	.html-annot-nav {
		flex: none;
		height: 24px;
		padding: 0 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--btn-secondary-bg);
		color: var(--ink);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.html-annot-nav:hover:not(:disabled) {
		border-color: var(--line-hover);
	}
	.html-annot-nav:disabled {
		opacity: 0.5;
		cursor: default;
	}
	/*
	 * The desk the device sits on. Its room is inset from the top by the preview's floating
	 * 「源码」 pill (hidden while elements are being picked) and from the bottom by the device bar.
	 */
	.html-stage {
		--bar-h: 30px;
		--device-body: #1c1e23;
		--device-rim: rgba(255, 255, 255, 0.07);
		--device-edge: rgba(15, 23, 42, 0.22);
		--device-shadow: 0 24px 48px -20px rgba(15, 23, 42, 0.45), 0 8px 16px -8px rgba(15, 23, 42, 0.22);
		--device-lens: #2c3038;
		--device-metal-hi: #e6e8ec;
		--device-metal-lo: #b1b5bd;
		position: relative;
		flex: 1 1 auto;
		min-height: 280px;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background:
			radial-gradient(110% 80% at 50% 0%, color-mix(in srgb, var(--pane) 75%, transparent), transparent 72%),
			var(--bg);
		container: html-stage / inline-size;
	}
	.html-stage.is-dark {
		--device-body: #0a0c10;
		--device-rim: rgba(255, 255, 255, 0.1);
		--device-edge: rgba(255, 255, 255, 0.12);
		--device-shadow: 0 24px 48px -20px rgba(0, 0, 0, 0.8), 0 8px 16px -8px rgba(0, 0, 0, 0.5);
		--device-lens: #1f232b;
		--device-metal-hi: #6c717a;
		--device-metal-lo: #3a3e46;
	}
	.html-stage-room {
		position: absolute;
		inset: 44px 16px calc(var(--bar-h) + 20px);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.html-stage.is-annotating .html-stage-room,
	.html-annot.is-enlarged .html-stage-room {
		top: 16px;
	}

	.html-device {
		position: relative;
		flex: none;
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.html-device-body {
		position: relative;
		padding: var(--bezel-top) var(--bezel-side) var(--bezel-bottom);
		border-radius: var(--device-radius);
		background: var(--device-body);
		box-shadow:
			inset 0 0 0 1px var(--device-rim),
			0 0 0 1px var(--device-edge),
			var(--device-shadow);
	}
	/* The camera, centred in the top bezel; a phone's is the earpiece slot. */
	.html-device-body::before {
		content: '';
		position: absolute;
		top: calc(var(--bezel-top) / 2);
		left: 50%;
		width: max(3px, calc(var(--bezel-top) * 0.26));
		height: max(3px, calc(var(--bezel-top) * 0.26));
		border-radius: 999px;
		transform: translate(-50%, -50%);
		background: var(--device-lens);
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
	}
	.html-device.is-phone .html-device-body::before {
		width: calc(var(--screen-w) * 0.2);
		height: max(2px, calc(var(--bezel-top) * 0.3));
	}
	.html-device-screen {
		position: relative;
		width: var(--screen-w);
		height: var(--screen-h);
		overflow: hidden;
		border-radius: max(2px, calc(var(--device-radius) - var(--bezel-side)));
		background: var(--pane);
	}
	.html-device-screen.is-picking {
		box-shadow: 0 0 0 2px var(--accent);
	}
	.artifact-frame {
		display: block;
		border: 0;
		transform-origin: 0 0;
		background: var(--pane);
	}

	/* A laptop: the lid is squarer at the hinge, and sits on a metal base a little wider than it. */
	.html-device.is-desktop .html-device-body {
		border-radius: var(--device-radius) var(--device-radius) calc(var(--device-radius) * 0.3) calc(var(--device-radius) * 0.3);
	}
	.html-device.is-desktop .html-device-screen {
		border-radius: max(1px, calc(var(--device-radius) * 0.25));
	}
	.html-device-base {
		position: relative;
		width: 100%;
		height: var(--device-base);
		border-radius: 1px 1px calc(var(--device-base) * 2) calc(var(--device-base) * 2) / 1px 1px var(--device-base) var(--device-base);
		background: linear-gradient(to bottom, var(--device-metal-hi), var(--device-metal-lo));
		box-shadow: 0 0 0 1px var(--device-edge), var(--device-shadow);
	}
	/* The notch you open it by. */
	.html-device-base::before {
		content: '';
		position: absolute;
		top: 0;
		left: 50%;
		width: 15%;
		height: 42%;
		transform: translateX(-50%);
		border-radius: 0 0 999px 999px;
		background: var(--device-metal-lo);
		box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.18);
	}

	/* A phone's side buttons: power on the right, volume on the left. */
	.html-device.is-phone {
		--button-w: max(2px, calc(var(--screen-w) * 0.008));
	}
	.html-device.is-phone::before,
	.html-device.is-phone::after {
		content: '';
		position: absolute;
		width: var(--button-w);
		background: var(--device-body);
		box-shadow: 0 0 0 1px var(--device-edge);
	}
	.html-device.is-phone::before {
		right: calc(var(--button-w) * -1);
		top: 26%;
		height: 11%;
		border-radius: 0 2px 2px 0;
	}
	.html-device.is-phone::after {
		left: calc(var(--button-w) * -1);
		top: 21%;
		height: 15%;
		border-radius: 2px 0 0 2px;
	}

	.html-viewport-bar {
		position: absolute;
		left: 50%;
		bottom: 10px;
		z-index: 2;
		display: inline-flex;
		align-items: center;
		gap: 2px;
		max-width: calc(100% - 24px);
		height: var(--bar-h);
		padding: 0 3px;
		transform: translateX(-50%);
		border: 1px solid var(--line);
		border-radius: 999px;
		background: color-mix(in srgb, var(--pane) 88%, transparent);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		box-shadow: var(--shadow-xs);
		white-space: nowrap;
	}
	.html-viewport-option {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		height: calc(var(--bar-h) - 6px);
		padding: 0 9px 0 8px;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--ink-secondary);
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		line-height: 1;
		cursor: pointer;
	}
	.html-viewport-option svg {
		flex: none;
	}
	.html-viewport-option:hover {
		color: var(--accent);
	}
	.html-viewport-option[aria-pressed='true'] {
		background: var(--accent-tint);
		color: var(--accent);
	}
	.html-viewport-option:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.html-viewport-size {
		margin-left: 6px;
		padding: 0 6px 0 9px;
		border-left: 1px solid var(--line);
		color: var(--muted);
		font-size: 11px;
		line-height: 14px;
		font-variant-numeric: tabular-nums;
	}
	@container html-stage (max-width: 440px) {
		.html-viewport-name {
			display: none;
		}
		.html-viewport-option {
			padding: 0 8px;
		}
	}
	.html-viewport-enlarge {
		padding: 0 7px;
		border-left: 1px solid var(--line);
		border-radius: 0 999px 999px 0;
	}
	@container html-stage (max-width: 300px) {
		.html-viewport-size {
			display: none;
		}
	}
	@media (max-width: 680px) {
		.html-annot-bar {
			flex-wrap: wrap;
		}
		.html-annot-keys {
			display: none;
		}
		.html-annot-marks {
			max-width: 100%;
		}
		.html-annot-chip,
		.html-annot-nav {
			min-width: 40px;
			min-height: 40px;
		}
		.html-annot-chip {
			line-height: 38px;
		}
		.html-stage {
			--bar-h: 44px;
		}
		.html-viewport-option {
			min-width: 40px;
		}
	}
</style>
