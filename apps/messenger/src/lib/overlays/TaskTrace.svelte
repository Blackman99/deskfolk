<script lang="ts">
	import { USER_MEMBER, type Bot, type SessionSummary, type SessionTaskSummary, type TaskTrace, type TaskTraceNode } from '@real-bot/protocol';
	import { onMount, untrack } from 'svelte';
	import { pageSlide } from '../mobile-page-slide.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import { classifySession, youBotPeer } from '../sidebar/session-groups.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import { sessionTitle } from '../sidebar/session-title.ts';
	import TraceOutput from './TraceOutput.svelte';
	import {
		clampZoom,
		filterTrace,
		fitView,
		pinchSpan,
		traceFileName,
		traceFlow,
		wokenByName,
		zoomAt,
		TRACE_CARD_WIDTH,
		TRACE_ZOOM_MAX,
		TRACE_ZOOM_MIN,
		type TraceBox,
		type TraceView
	} from './task-trace.ts';
	import {
		clampTraceWindow,
		loadTraceWindow,
		resizeTraceWindow,
		saveTraceWindow,
		type TraceCorner,
		type TraceWindowFrame
	} from './trace-window.ts';

	/** Every corner resizes, so the window can be pulled open in whichever direction there is room. */
	const TRACE_CORNERS: readonly TraceCorner[] = ['nw', 'ne', 'sw', 'se'];

	interface Props {
		api: MessengerApi | null;
		/** The job to open on. Null asks the session for its most recent one. */
		taskId: string | null;
		sessionId: string;
		/** The conversation on screen, so the node that lives there reads as the one you are on. */
		activeSessionId: string;
		sessions: readonly SessionSummary[];
		bots: readonly Bot[];
		youLabel: string;
		deletedLabel: string;
		workspacePath: string | null;
		t: Copy;
		reloadToken: number;
		onClose: () => void;
		onJump: (sessionId: string, messageId: string) => void;
		/** The job actually on screen, so the address follows the switcher. */
		onTask?: (taskId: string) => void;
	}

	let {
		api,
		taskId,
		sessionId,
		activeSessionId,
		sessions,
		bots,
		youLabel,
		deletedLabel,
		workspacePath,
		t,
		reloadToken,
		onClose,
		onJump,
		onTask
	}: Props = $props();

	let jobs = $state<SessionTaskSummary[]>([]);
	let trace = $state<TaskTrace | null>(null);
	let currentId = $state<string | null>(null);
	let loading = $state(true);
	let failed = $state(false);
	let notableOnly = $state(false);
	/** A file opened inside this board. The preview stays here; it never opens the chat's pane. */
	let openFile = $state<{ path: string; messageId: string; attachmentId: string } | null>(null);
	/**
	 * Whether that file is filling the screen.
	 *
	 * It lives here rather than in the preview because the full-screen layer has to be rendered
	 * outside the board: the board carries a `transform`, and inside a transformed ancestor
	 * `position: fixed` is fixed to the ancestor, so a preview that asked for the screen would
	 * have been given the canvas.
	 */
	let outputFull = $state(false);
	let loadSeq = 0;
	const PHONE = '(max-width: 680px)';
	/** A phone is its own page: no frame, no drag, no resize. */
	let phone = $state(typeof window !== 'undefined' && window.matchMedia(PHONE).matches);
	/** Where the desktop window sits. Null keeps the corner default. */
	let frame = $state<TraceWindowFrame | null>(phone ? null : loadTraceWindow());
	let paneEl = $state<HTMLElement | null>(null);
	/** The press a move or resize is measured from. Held outside state so writing it cannot restart it. */
	let gesture:
		| { kind: 'move'; corner: null; x: number; y: number; frame: TraceWindowFrame }
		| { kind: 'resize'; corner: TraceCorner; x: number; y: number; frame: TraceWindowFrame }
		| null = null;

	const shown = $derived(trace ? filterTrace(trace, notableOnly) : null);
	/**
	 * What each card measured to. Cards differ in height — a summary runs long, a file list is
	 * taller, an opened file taller still — so the layout is fed the real boxes and redone when
	 * one changes. The first pass uses the fallback size, which is close enough to not flash.
	 */
	let boxes = $state<Record<string, TraceBox>>({});
	const flow = $derived(shown ? traceFlow(shown, new Map(Object.entries(boxes))) : null);

	/**
	 * The board inside a fixed viewport: no scrollbars, it is dragged.
	 *
	 * A fan is wider than any window it opens in, and a scrollbar on each axis turns reading a
	 * flow into operating a pair of sliders. So the viewport stays put and the board moves under
	 * it — drag to pan, ⌘/Ctrl + wheel or two fingers to zoom, and the window's own corner still
	 * resizes the viewport itself.
	 *
	 * One finger drags the board rather than the page. The board is the page here, so nothing is
	 * stolen; it does mean the gesture has to be taken properly, which is why the listeners below
	 * are bound non-passively.
	 */
	let view = $state<TraceView>({ scale: 1, x: 0, y: 0 });
	let viewportEl = $state<HTMLElement | null>(null);
	let fitted: string | null = null;
	/** Live pointers, so two of them can be read as a pinch and one as a drag. */
	const pointers = new Map<number, { x: number; y: number }>();
	// Read in the markup (the cursor, and whether a card is a target), so they are state.
	let drag = $state<{ x: number; y: number; view: TraceView } | null>(null);
	let pinch = $state<{ span: number; view: TraceView; at: { x: number; y: number } } | null>(null);
	let dragged = $state(false);

	const viewportBox = () => {
		const box = viewportEl?.getBoundingClientRect();
		return { width: box?.width ?? 0, height: box?.height ?? 0 };
	};
	const boardBox = () => ({ width: flow?.width ?? 0, height: flow?.height ?? 0 });

	/** No fence: the board goes where it is dragged. `适应` is the way back. */
	function settle(next: TraceView): void {
		view = next;
	}

	function localPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
		const box = viewportEl?.getBoundingClientRect();
		return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
	}

	function fitBoard(): void {
		if (!flow?.width || !viewportEl) return;
		// The switcher and the tools float over the canvas, so fitting aims at what is actually
		// clear: a board centred under a strip of chrome is a board half hidden.
		const body = viewportEl.parentElement;
		const chrome =
			(body?.querySelector('.trace-switcher')?.clientHeight ?? 0) +
			(body?.querySelector('.trace-tools')?.clientHeight ?? 0);
		const box = viewportBox();
		const clear = { width: box.width - 24, height: Math.max(120, box.height - chrome - 24) };
		const fitted = fitView(boardBox(), clear);
		view = { ...fitted, y: fitted.y + (body?.querySelector('.trace-switcher')?.clientHeight ?? 0) + 12 };
	}

	function zoomBy(factor: number, at?: { x: number; y: number }): void {
		const box = viewportBox();
		settle(zoomAt(view, view.scale * factor, at ?? { x: box.width / 2, y: box.height / 2 }));
	}

	function onWheel(event: WheelEvent): void {
		event.preventDefault();
		// The wheel zooms, at the pointer. Panning is dragging — on a canvas that reads better
		// than a wheel that scrolls a board with no scrollbar to scroll against. Shift is the
		// usual escape hatch for nudging sideways, and a trackpad pinch arrives as ctrl+wheel,
		// which lands here too.
		if (event.shiftKey) {
			settle({ ...view, x: view.x - (event.deltaX || event.deltaY), y: view.y });
			return;
		}
		const step = Math.exp(-event.deltaY / 400);
		settle(zoomAt(view, view.scale * step, localPoint(event)));
	}

	function onPointerDown(event: PointerEvent): void {
		// Anywhere is the canvas, cards included: a press that turns into a drag pans, and a
		// press that does not is still the card's click. Reserving the cards would have left
		// most of a full board unpannable, which is the whole board once it is zoomed in.
		if ((event.target as HTMLElement | null)?.closest('.trace-output')) return;
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		dragged = false;
		if (pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			pinch = {
				span: pinchSpan([{ clientX: a!.x, clientY: a!.y }, { clientX: b!.x, clientY: b!.y }]),
				view,
				at: localPoint({ clientX: (a!.x + b!.x) / 2, clientY: (a!.y + b!.y) / 2 }),
			};
			drag = null;
			return;
		}
		// Capture is taken only once a drag has actually started. Capturing on the press moves the
		// click to the capturing element, which is how the file chips and the cards stopped
		// opening: the press reached them, the click landed on the canvas.
		drag = { x: event.clientX, y: event.clientY, view };
	}

	function onPointerMove(event: PointerEvent): void {
		if (!pointers.has(event.pointerId)) return;
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		event.preventDefault();
		if (pinch && pointers.size >= 2) {
			const [a, b] = [...pointers.values()];
			const span = pinchSpan([{ clientX: a!.x, clientY: a!.y }, { clientX: b!.x, clientY: b!.y }]);
			if (!span || !pinch.span) return;
			settle(zoomAt(pinch.view, pinch.view.scale * (span / pinch.span), pinch.at));
			dragged = true;
			return;
		}
		if (!drag) return;
		const dx = event.clientX - drag.x;
		const dy = event.clientY - drag.y;
		if (!dragged && Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
		if (!dragged) {
			dragged = true;
			// Now it is a drag, so the pointer belongs to the canvas until it is let go.
			try {
				viewportEl?.setPointerCapture(event.pointerId);
			} catch {
				// A pointer that has already gone is not worth failing the pan over.
			}
		}
		settle({ ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy });
	}

	function onPointerUp(event: PointerEvent): void {
		pointers.delete(event.pointerId);
		if (pointers.size < 2) pinch = null;
		if (pointers.size === 0) drag = null;
		if (viewportEl?.hasPointerCapture?.(event.pointerId)) viewportEl.releasePointerCapture(event.pointerId);
	}

	/** A drag that ends on a card must not also open it. */
	function swallowClickAfterDrag(event: MouseEvent): void {
		if (!dragged) return;
		event.stopPropagation();
		event.preventDefault();
		dragged = false;
	}

	/** A press with no drag behind it leaves nothing to swallow. */
	function clearDragFlag(): void {
		dragged = false;
	}

	/** Wheel and pointer, bound by hand: Svelte's are passive, where `preventDefault` is ignored. */
	function gestures(node: HTMLElement) {
		const options = { passive: false } as const;
		node.addEventListener('click', swallowClickAfterDrag, true);
		node.addEventListener('wheel', onWheel, options);
		node.addEventListener('pointerdown', onPointerDown, options);
		node.addEventListener('pointermove', onPointerMove, options);
		node.addEventListener('pointerup', onPointerUp);
		node.addEventListener('pointercancel', onPointerUp);
		node.addEventListener('pointerleave', onPointerUp);
		return {
			destroy() {
				node.removeEventListener('click', swallowClickAfterDrag, true);
				node.removeEventListener('wheel', onWheel);
				node.removeEventListener('pointerdown', onPointerDown);
				node.removeEventListener('pointermove', onPointerMove);
				node.removeEventListener('pointerup', onPointerUp);
				node.removeEventListener('pointercancel', onPointerUp);
				node.removeEventListener('pointerleave', onPointerUp);
			}
		};
	}

	$effect(() => {
		// A board opens showing all of itself; after that the view is yours.
		const width = flow?.width ?? 0;
		const id = currentId;
		if (!width || !id || fitted === id || !viewportEl) return;
		fitted = id;
		fitBoard();
	});

	/** Every card on screen, so any of them can be re-read without waiting for a resize. */
	const slots = new Map<string, HTMLElement>();

	function recordBox(id: string, element: HTMLElement): void {
		const width = Math.round(element.offsetWidth);
		const height = Math.round(element.offsetHeight);
		const known = boxes[id];
		// Only on a real change: writing the same box back would re-run the layout forever.
		if (!width || !height || (known && known.width === width && known.height === height)) return;
		boxes = { ...boxes, [id]: { width, height } };
	}

	/** Measure a card and keep the layout honest about it. */
	function measured(element: HTMLElement, id: string) {
		slots.set(id, element);
		const record = () => {
			recordBox(id, element);
		};
		record();
		if (typeof ResizeObserver === 'undefined') return { destroy: () => slots.delete(id) };
		const observer = new ResizeObserver(record);
		observer.observe(element);
		return {
			destroy: () => {
				observer.disconnect();
				slots.delete(id);
			}
		};
	}

	$effect(() => {
		// After every layout, read the cards back. A ResizeObserver only speaks when a size
		// changes, so without this a measurement lost for any reason would never return.
		void flow;
		const frame = requestAnimationFrame(() => {
			for (const [id, element] of slots) if (element.isConnected) recordBox(id, element);
		});
		return () => cancelAnimationFrame(frame);
	});
	const byId = $derived(new Map((shown?.nodes ?? []).map((node) => [node.turn_id, node])));
	/**
	 * Measurements survive a reload of the same job.
	 *
	 * A live turn refetches the trace every few seconds. Clearing the measured heights on every
	 * new trace object dropped the layout back to the fallback height — and because the cards
	 * themselves had not changed size, no ResizeObserver fired to correct it, so the board stayed
	 * collapsed with children drawn on top of their parents. Only a different job is a reason to
	 * forget what its cards measured.
	 */
	let measuredJob: string | null = null;
	$effect(() => {
		const id = trace?.id ?? null;
		if (id === measuredJob) return;
		measuredJob = id;
		boxes = {};
	});
	const botsById = $derived(new Map(bots.map((bot) => [bot.id, bot])));
	const sessionsById = $derived(new Map(sessions.map((session) => [session.id, session])));

	function nameOf(actor: string): string {
		if (actor === USER_MEMBER) return youLabel;
		return botsById.get(actor)?.name ?? deletedLabel;
	}

	function avatarOf(actor: string): { src: string | null; letter: string; palette: ReturnType<typeof botAvatarColor> | null } {
		if (actor === USER_MEMBER) return { src: null, letter: rosterLetter(youLabel), palette: null };
		const bot = botsById.get(actor);
		const name = bot?.name ?? deletedLabel;
		return { src: avatarSrc(bot?.avatar), letter: rosterLetter(name), palette: botAvatarColor(actor) };
	}

	function placeOf(node: TaskTraceNode): string {
		const session = sessionsById.get(node.session_id);
		if (!session) return t.trace.sessionUnknown;
		if (session.kind === 'group') return t.trace.sessionGroup(session.name ?? session.id);
		const kind = classifySession(session);
		if (kind === 'you-bot') {
			const peer = youBotPeer(session);
			return t.trace.sessionDirect(peer ? nameOf(peer) : deletedLabel);
		}
		return t.trace.sessionDirect(sessionTitle(session, botsById, { deleted: deletedLabel, archived: deletedLabel }));
	}

	async function load(id: string | null): Promise<void> {
		const seq = ++loadSeq;
		if (!api) {
			loading = false;
			failed = true;
			return;
		}
		loading = true;
		failed = false;
		try {
			const listed = await api.sessionTasks(sessionId);
			if (seq !== loadSeq) return;
			jobs = listed;
			const next = id && listed.some((job) => job.id === id) ? id : (listed[0]?.id ?? null);
			// A refresh of the same job keeps the file you have open; switching jobs does not.
			if (next !== currentId) openFile = null;
			currentId = next;
			if (next) onTask?.(next);
			trace = next ? await api.taskTrace(next) : null;
			if (seq !== loadSeq) return;
			if (next && !trace) failed = true;
		} catch {
			if (seq !== loadSeq) return;
			failed = true;
		} finally {
			if (seq === loadSeq) loading = false;
		}
	}

	function selectJob(id: string): void {
		if (id === currentId) return;
		void load(id);
	}

	onMount(() => {
		void load(taskId);
		const query = window.matchMedia(PHONE);
		const apply = () => {
			phone = query.matches;
		};
		apply();
		query.addEventListener('change', apply);
		if (!query.matches) {
			const remembered = loadTraceWindow();
			if (remembered) frame = remembered;
		}
		/**
		 * One Escape, one step out: full screen, then the file, then the board.
		 *
		 * All of it in a single capture listener, because two listeners racing to answer the same
		 * key is decided by which mounted first — and the shell's own Escape, which closes the
		 * board, is a window listener that was there before this pane existed.
		 */
		function onKey(event: KeyboardEvent): void {
			if (event.key !== 'Escape') return;
			if (outputFull) {
				event.preventDefault();
				event.stopImmediatePropagation();
				outputFull = false;
				return;
			}
			if (!openFile) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			openFile = null;
		}
		window.addEventListener('keydown', onKey, true);
		return () => {
			query.removeEventListener('change', apply);
			window.removeEventListener('keydown', onKey, true);
		};
	});

	$effect(() => {
		void reloadToken;
		if (reloadToken === 0) return;
		void load(currentId ?? taskId);
	});

	/** A different conversation shows that conversation's job. */
	let loadedFor = sessionId;
	$effect(() => {
		const next = sessionId;
		if (next === loadedFor) return;
		loadedFor = next;
		untrack(() => void load(null));
	});

	/**
	 * The phone's Back, one step.
	 *
	 * Full screen is a page laid over the flow, so Back leaves it the way it leaves any page and
	 * the flow is still underneath. A file unfolded under its card is part of this page rather
	 * than a page over it, so Back does not stop there — `false` hands the press back to history,
	 * which is what closes the flow itself.
	 */
	export function backFromFullOutput(): boolean {
		if (!outputFull) return false;
		outputFull = false;
		return true;
	}

	function openCard(node: TaskTraceNode): void {
		const messageId = node.approval?.message_id ?? node.ask?.message_id ?? node.focus_message_id;
		onJump(node.session_id, messageId);
	}

	function currentFrame(): TraceWindowFrame {
		const pane = paneEl;
		const box = pane?.getBoundingClientRect();
		return frame ?? {
			x: box?.left ?? 0,
			y: box?.top ?? 0,
			width: box?.width ?? 440,
			height: box?.height ?? 640
		};
	}

	function track(event: PointerEvent, corner: TraceCorner | null): void {
		event.preventDefault();
		event.stopPropagation();
		const at = { x: event.clientX, y: event.clientY, frame: currentFrame() };
		gesture = corner ? { kind: 'resize', corner, ...at } : { kind: 'move', corner: null, ...at };
		function move(next: PointerEvent): void {
			const held = gesture;
			if (!held) return;
			const dx = next.clientX - held.x;
			const dy = next.clientY - held.y;
			frame =
				held.kind === 'move'
					? clampTraceWindow({ ...held.frame, x: held.frame.x + dx, y: held.frame.y + dy })
					: resizeTraceWindow(held.frame, held.corner, dx, dy);
		}
		function stop(): void {
			gesture = null;
			if (frame) saveTraceWindow(frame);
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', stop);
		}
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', stop);
	}

	function startDrag(event: PointerEvent): void {
		if (phone || event.button !== 0) return;
		if ((event.target as HTMLElement | null)?.closest('button, a, input, label')) return;
		if (!paneEl) return;
		track(event, null);
	}

	function startResize(event: PointerEvent, corner: TraceCorner): void {
		if (phone || event.button !== 0) return;
		if (!paneEl) return;
		track(event, corner);
	}

	/** The turn a file hangs off, so the output names who handed it over. */
	function ownerOf(attachmentId: string): TaskTraceNode | null {
		for (const node of shown?.nodes ?? []) {
			if (node.artifacts.some((file) => file.attachment_id === attachmentId)) return node;
		}
		return null;
	}

	function closeOutput(): void {
		openFile = null;
		outputFull = false;
	}

	function showFile(file: { path: string; messageId: string; attachmentId: string }): void {
		openFile = openFile?.attachmentId === file.attachmentId ? null : file;
	}

	function showPath(next: string): void {
		const known = (shown?.nodes ?? [])
			.flatMap((node) => node.artifacts)
			.find((file) => file.path === next);
		openFile = known
			? { path: known.path, messageId: known.message_id, attachmentId: known.attachment_id }
			: { path: next, messageId: '', attachmentId: next };
	}
</script>

{#snippet card(node: TaskTraceNode)}
	<!-- An edge already says who woke this card; words are for the ones with no line to follow. -->
	{@const from =
		node.woken_by_turn_id && byId.has(node.woken_by_turn_id)
			? null
			: wokenByName(node, byId, nameOf)}
	{@const face = avatarOf(node.actor)}
	<article class="trace-card is-{node.status}" class:is-here={node.session_id === activeSessionId}>
		<button type="button" class="trace-card-main" onclick={() => openCard(node)} title={t.trace.jump}>
			<span class="trace-card-line">
				<span
					class="trace-avatar"
					class:is-you={node.actor === USER_MEMBER}
					style:background={face.palette?.bg}
					style:color={face.palette?.text}
					style:border-color={face.palette?.border}
					aria-hidden="true"
				>
					{#if face.src}
						<img src={face.src} alt="" class="avatar-img" />
					{:else}
						{face.letter}
					{/if}
				</span>
				<span class="trace-card-who">{nameOf(node.actor)}</span>
				<span class="trace-status is-{node.status}">{t.trace.status[node.status]}</span>
			</span>
			{#if from}
				<span class="trace-woken">{t.trace.wokenBy(from)}</span>
			{/if}
			{#if node.summary}
				<span class="trace-summary">{node.summary}</span>
			{/if}
			{#if node.ask}
				<span class="trace-wait">{t.trace.waitingAsk} · {node.ask.question}</span>
			{/if}
			{#if node.approval}
				<span class="trace-wait">{t.trace.waitingApproval}{#if node.approval.summary} · {node.approval.summary}{/if}</span>
			{/if}
			{#if node.passed > 0}
				<span class="trace-passed">{t.trace.passed(node.passed)}</span>
			{/if}
			<span class="trace-place">{placeOf(node)}</span>
		</button>
		{#if node.artifacts.length > 0}
			<ul class="trace-files">
				{#each node.artifacts as file (file.attachment_id)}
					<li>
						<button
							type="button"
							class="trace-file"
							class:is-open={openFile?.attachmentId === file.attachment_id}
							aria-expanded={openFile?.attachmentId === file.attachment_id}
							onclick={() => showFile({ path: file.path, messageId: file.message_id, attachmentId: file.attachment_id })}
							title={file.path}
						>
							<span class="trace-file-name">{traceFileName(file.path)}</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</article>
{/snippet}

{#snippet output(full = false)}
	{#if openFile}
		{@const owner = ownerOf(openFile.attachmentId)}
		<div class="trace-output-stop">
			<TraceOutput
				path={openFile.path}
				handedBy={owner ? nameOf(owner.actor) : ''}
				{api}
				{workspacePath}
				{t}
				{full}
				onToggleFull={() => (outputFull = !outputFull)}
				onOpenPath={showPath}
				onClose={closeOutput}
			/>
		</div>
	{/if}
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="trace-overlay"
	class:is-placed={!phone && frame !== null}
	class:is-page={phone}
	transition:pageSlide
	role="dialog"
	aria-modal={phone}
	aria-label={t.trace.title}
	tabindex="-1"
>
	<div
		class="trace-pane"
		bind:this={paneEl}
		style:left={!phone && frame ? `${frame.x}px` : undefined}
		style:top={!phone && frame ? `${frame.y}px` : undefined}
		style:width={!phone && frame ? `${frame.width}px` : undefined}
		style:height={!phone && frame ? `${frame.height}px` : undefined}
	>
		<header class="trace-header" onpointerdowncapture={phone ? undefined : startDrag}>
			<div class="trace-titles">
				<h2>{trace ? `${t.trace.title} · ${trace.title}` : t.trace.title}</h2>
				{#if trace}
					<span class="trace-meta">{trace.closed_at ? t.trace.closed : t.trace.open} · {trace.dir}</span>
				{/if}
			</div>
			<button type="button" class="sheet-close" title={t.common.close} onclick={onClose}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="18" y1="6" x2="6" y2="18"></line>
					<line x1="6" y1="6" x2="18" y2="18"></line>
				</svg>
			</button>
		</header>
		{#if !phone}
			{#each TRACE_CORNERS as corner (corner)}
				<button
					type="button"
					class="trace-resize trace-resize-{corner}"
					aria-label={t.trace.resize}
					onpointerdowncapture={(event) => startResize(event, corner)}
				></button>
			{/each}
		{/if}

		<div class="trace-body">
		{#if jobs.length > 1}
			<div class="trace-switcher" role="tablist">
				{#each jobs as job (job.id)}
					<button
						type="button"
						role="tab"
						class="trace-job"
						class:is-current={job.id === currentId}
						aria-selected={job.id === currentId}
						onclick={() => selectJob(job.id)}
					>
						{job.title || job.dir}
					</button>
				{/each}
			</div>
		{/if}

		{#if trace && trace.nodes.length > 0}
			<div class="trace-tools">
				<label class="trace-filter">
					<input type="checkbox" bind:checked={notableOnly} />
					<span>{t.trace.filter}</span>
				</label>
				<div class="trace-zoom">
					<button
						type="button"
						aria-label={t.trace.zoomOut}
						title={t.trace.zoomOut}
						disabled={view.scale <= TRACE_ZOOM_MIN}
						onclick={() => zoomBy(1 / 1.2)}
					>−</button>
					<button type="button" class="trace-zoom-fit" onclick={fitBoard} title={t.trace.zoomFit}>
						{Math.round(view.scale * 100)}%
					</button>
					<button
						type="button"
						aria-label={t.trace.zoomIn}
						title={t.trace.zoomIn}
						disabled={view.scale >= TRACE_ZOOM_MAX}
						onclick={() => zoomBy(1.2)}
					>+</button>
				</div>
			</div>
		{/if}

		<!-- A fixed viewport. The board moves under it; the window's corner resizes the viewport. -->
		<div
			class="trace-viewport"
			class:is-dragging={drag !== null || pinch !== null}
			role="group"
			aria-label={t.trace.title}
			bind:this={viewportEl}
			use:gestures
		>
				{#if loading && !trace}
					<p class="trace-empty">{t.trace.loading}</p>
				{:else if failed}
					<p class="trace-empty">
						{t.trace.failed}
						<button type="button" onclick={() => void load(currentId ?? taskId)}>{t.trace.retry}</button>
					</p>
				{:else if !flow || flow.placements.length === 0}
					<p class="trace-empty">{t.trace.none}</p>
				{:else}
					<div
						class="trace-flow"
						class:is-moving={dragged}
						style="width: {flow.width}px; height: {flow.height}px;
							transform: translate({view.x}px, {view.y}px) scale({view.scale});"
					>
						<svg
							class="trace-edges"
							width={flow.width}
							height={flow.height}
							viewBox="0 0 {flow.width} {flow.height}"
							aria-hidden="true"
						>
							{#each flow.edges as edge (edge.from + '>' + edge.to)}
								<path d={edge.path} />
							{/each}
						</svg>
						{#each flow.placements as placement (placement.node.turn_id)}
							<div
								class="trace-slot"
								style="left: {placement.x}px; top: {placement.y}px; width: {TRACE_CARD_WIDTH}px;"
								use:measured={placement.node.turn_id}
							>
								{@render card(placement.node)}
								{#if !outputFull && placement.node.artifacts.some((file) => file.attachment_id === openFile?.attachmentId)}
									{@render output()}
								{/if}
							</div>
						{/each}
					</div>
				{/if}
		</div>
		</div>
	</div>
	{#if openFile && outputFull}
		<div class="trace-output-layer">
			{@render output(true)}
		</div>
	{/if}
</div>

<style>
	.trace-overlay {
		position: fixed;
		z-index: 70;
		right: 24px;
		bottom: 24px;
		display: flex;
		pointer-events: none;
	}

	.trace-overlay.is-placed {
		inset: 0;
		right: auto;
		bottom: auto;
	}

	.trace-pane {
		position: relative;
		pointer-events: auto;
		width: min(440px, calc(100vw - 48px));
		height: min(640px, calc(100vh - 96px));
		min-width: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
	}

	.trace-overlay.is-placed .trace-pane {
		position: fixed;
	}

	/*
	 * The grips draw nothing. A corner mark is clutter on a window that is mostly picture, and the
	 * cursor over the corner already says the window can be pulled there. They sit above the board
	 * because the viewport is positioned and comes later in the markup — without that it paints
	 * over the corners and a press that should resize pans the board instead.
	 */
	.trace-resize {
		position: absolute;
		z-index: 2;
		width: 14px;
		height: 14px;
		padding: 0;
		border: 0;
		background: transparent;
		touch-action: none;
	}

	.trace-resize-nw {
		top: 0;
		left: 0;
		cursor: nwse-resize;
	}

	.trace-resize-ne {
		top: 0;
		right: 0;
		cursor: nesw-resize;
	}

	.trace-resize-sw {
		bottom: 0;
		left: 0;
		cursor: nesw-resize;
	}

	.trace-resize-se {
		bottom: 0;
		right: 0;
		cursor: nwse-resize;
	}

	.trace-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 14px 10px;
		border-bottom: 1px solid var(--line);
		background: var(--sidebar-bg);
		cursor: grab;
		touch-action: none;
		user-select: none;
	}

	.trace-header:active {
		cursor: grabbing;
	}

	.trace-titles {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.trace-titles h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.trace-meta {
		font-size: 11.5px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.trace-switcher {
		display: flex;
		gap: 6px;
		overflow-x: auto;
		padding: 10px 16px 0;
	}

	.trace-job {
		flex: none;
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		height: 26px;
		padding: 0 10px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--ink-secondary);
		font-size: 12px;
		cursor: pointer;
	}

	.trace-job.is-current {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.trace-filter {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 16px 0;
		font-size: 12px;
		color: var(--ink-secondary);
	}

	/*
	 * The window below its title bar is one canvas: the board fills it corner to corner and the
	 * chrome floats on top, so a drag anywhere is a pan rather than a drag that only works in
	 * the part of the window left over after the rows above it.
	 */
	.trace-body {
		position: relative;
		flex: 1;
		min-height: 0;
	}

	.trace-switcher,
	.trace-tools {
		position: absolute;
		z-index: 1;
		left: 0;
		right: 0;
		background: color-mix(in srgb, var(--pane) 86%, transparent);
		backdrop-filter: blur(6px);
	}

	.trace-switcher {
		top: 0;
		padding: 6px 10px;
	}

	.trace-tools {
		bottom: 0;
		padding: 6px 10px;
	}

	.trace-viewport {
		position: absolute;
		inset: 0;
		overflow: hidden;
		/* Every gesture in here is the board's: no page scroll, no browser pinch fighting ours. */
		touch-action: none;
		cursor: grab;
	}

	.trace-viewport.is-dragging {
		cursor: grabbing;
	}

	.trace-tools {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.trace-zoom {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.trace-zoom button {
		min-width: 28px;
		height: 28px;
		padding: 0 6px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		font: 500 12px/1 var(--font);
		cursor: pointer;
	}

	.trace-zoom button:hover:not(:disabled) {
		color: var(--ink);
		background: var(--line-subtle);
	}

	.trace-zoom button:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.trace-zoom-fit {
		min-width: 48px;
	}

	/* A canvas the size dagre measured, with the cards placed on it and the edges beneath. */
	.trace-flow {
		position: absolute;
		top: 0;
		left: 0;
		transform-origin: 0 0;
		/* While it is being dragged the cards are scenery, not targets. */
		will-change: transform;
	}

	.trace-flow.is-moving {
		user-select: none;
	}

	.trace-edges {
		position: absolute;
		inset: 0;
		overflow: visible;
		pointer-events: none;
	}

	.trace-edges path {
		fill: none;
		stroke: var(--line-hover);
		stroke-width: 1.5;
	}

	.trace-slot {
		position: absolute;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 8px;
	}

	/* Outside the board, so it is fixed to the screen and drawn at life size. */
	.trace-output-layer {
		position: fixed;
		inset: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right))
			max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
		/* A phone has no room to spend on a gutter: edge to edge, minus the notch. */
		z-index: 120;
		display: flex;
		pointer-events: auto;
		box-shadow: 0 24px 64px rgb(0 0 0 / 45%);
		border-radius: var(--radius-md);
		overflow: hidden;
	}

	.trace-output-layer > :global(*) {
		flex: 1;
		min-width: 0;
	}

	.trace-output-stop {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
	}

	.trace-empty {
		margin: 24px 0;
		font-size: 13px;
		color: var(--muted);
	}

	.trace-card {
		border: 1px solid var(--line);
		border-left: 3px solid var(--muted-light);
		border-radius: var(--radius-md);
		background: var(--pane);
		overflow: hidden;
	}

	.trace-card.is-running {
		border-color: var(--accent-border);
		border-left-color: var(--accent);
		background: var(--accent-tint);
	}

	.trace-card.is-waiting_approval {
		border-color: var(--warn-line);
		border-left-color: var(--warn);
		background: var(--warn-bg);
	}

	.trace-card.is-waiting_ask {
		border-color: var(--purple-line);
		border-left-color: var(--purple);
		background: var(--purple-bg);
	}

	.trace-card.is-completed {
		border-color: var(--ok-line);
		border-left-color: var(--ok);
		background: var(--ok-bg);
	}

	.trace-card.is-redirected {
		border-color: var(--line);
		border-left-color: var(--muted);
		background: var(--chip);
	}

	.trace-card.is-interrupted,
	.trace-card.is-stopped {
		border-color: var(--danger-line);
		border-left-color: var(--danger);
		background: var(--danger-bg);
	}

	.trace-card.is-here {
		box-shadow: inset 0 0 0 1px var(--accent);
	}

	.trace-card-main {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
		width: 100%;
		padding: 9px 10px;
		border: 0;
		background: transparent;
		text-align: left;
		cursor: pointer;
		color: inherit;
	}

	.trace-card-main:hover {
		background: var(--line-subtle);
	}

	.trace-card-line {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
	}

	.trace-avatar {
		width: 22px;
		height: 22px;
		flex: none;
		border-radius: 50%;
		border: 1px solid;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		font-size: 11px;
		font-weight: 700;
		line-height: 1;
		user-select: none;
	}

	.trace-avatar.is-you {
		background: #1e293b;
		color: #ffffff;
		border-color: #334155;
	}

	.trace-card-who {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
	}

	.trace-status {
		margin-left: auto;
		font-size: 11px;
		color: var(--muted);
	}

	.trace-status.is-running { color: var(--accent); }
	.trace-status.is-waiting_approval { color: var(--warn-text); }
	.trace-status.is-waiting_ask { color: var(--purple); }
	.trace-status.is-completed { color: var(--ok-text); }
	.trace-status.is-redirected { color: var(--muted); }
	.trace-status.is-interrupted,
	.trace-status.is-stopped { color: var(--danger-text); }

	.trace-summary,
	.trace-wait,
	.trace-woken,
	.trace-passed,
	.trace-place {
		font-size: 12px;
		line-height: 1.45;
		color: var(--ink-secondary);
		overflow-wrap: anywhere;
	}

	.trace-place,
	.trace-woken,
	.trace-passed {
		font-size: 11px;
		color: var(--muted);
	}

	.trace-wait {
		color: var(--accent);
	}

	.trace-files {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin: 0;
		padding: 0 10px 9px;
	}

	.trace-file {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 100%;
		height: 24px;
		padding: 0 8px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 11.5px;
		cursor: pointer;
	}

	.trace-file:hover,
	.trace-file.is-open {
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.trace-file.is-open {
		background: var(--accent-tint);
	}

	.trace-file-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media (max-width: 680px) {
		.trace-output-layer {
			inset: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
				env(safe-area-inset-left);
			border-radius: 0;
		}

		/* All four edges. Resetting right and bottom afterwards would shrink this back to the flow. */
		.trace-overlay,
		.trace-overlay.is-placed,
		.trace-overlay.is-page {
			top: 0;
			right: 0;
			bottom: 0;
			left: 0;
			width: 100%;
			height: 100%;
			pointer-events: auto;
		}

		.trace-pane {
			position: relative;
			left: 0;
			top: 0;
			width: 100%;
			height: 100%;
			max-width: none;
			border: 0;
			border-radius: 0;
			box-shadow: none;
		}

		.trace-header {
			cursor: default;
			touch-action: auto;
		}

		.trace-resize {
			display: none;
		}

		.trace-header {
			padding: calc(10px + env(safe-area-inset-top)) 12px 10px;
		}

		.trace-flow-scroll {
			padding: 12px 12px calc(12px + env(safe-area-inset-bottom));
		}
	}
</style>
