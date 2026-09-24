<!--
	HTML 元素批注（#28）：自带预览 iframe，sandbox 和今天一样（从不加 allow-same-origin）。只在批注模式下往页面
	最前面注入选取器（html-picker.ts）并重新加载，退出时再加载一次不带脚本的；页面上的描边和编号都由选取器画，
	普通视图不注入，批注只在列表里。批注模式下 iframe 上方一条细栏：编号（悬停看意见，点一下在列表里定位）、
	提示、「外层 / 内层」（手机上没有方向键）。没有裁图：跨源页面的像素读不到。
-->
<script lang="ts" module>
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
	};
</script>

<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import type { Annotation, HtmlElementAnchor } from '@real-bot/protocol';
	import { HTML_PREVIEW_SANDBOX, htmlPreviewBlob, pageCspNonce } from '../overlays/artifacts.ts';
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
		void reloads;
		const ch = on ? newChannel() : null;
		const cspNonce = nonce === undefined ? pageCspNonce() : nonce;
		const url = URL.createObjectURL(htmlPreviewBlob(annotatorSource(raw, { scheme: sch, nonce: cspNonce, channel: ch })));
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

	function chipTitle(row: Annotation, n: number): string {
		const lines = [`${n}. ${row.body}`];
		if (notFound.has(row.id)) lines.push(labels.notFound);
		else if (row.stale) lines.push(labels.stale);
		return lines.join('\n');
	}
</script>

<svelte:window onmessage={onWindowMessage} />
<svelte:document onkeydown={onDocumentKey} />

<div class="html-annot min-w-0" data-html-annotator>
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
	{#if src}
		<iframe
			bind:this={frame}
			{title}
			class="artifact-frame"
			class:is-picking={picking}
			{src}
			sandbox={HTML_PREVIEW_SANDBOX}
			referrerpolicy="no-referrer"
			style:color-scheme={scheme}
			onload={onFrameLoad}
		></iframe>
	{/if}
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
	.artifact-frame {
		flex: 1 1 auto;
		width: 100%;
		height: 100%;
		min-height: 280px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
	}
	.artifact-frame.is-picking {
		border-color: var(--accent);
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
	}
</style>
