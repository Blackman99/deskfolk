<script lang="ts">
	import { USER_MEMBER, type Attachment, type Bot, type SessionSummary, type SessionTaskSummary, type TaskTrace, type TaskTraceNode } from '@real-bot/protocol';
	import { onMount, untrack } from 'svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import { classifySession, youBotPeer } from '../sidebar/session-groups.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import { sessionTitle } from '../sidebar/session-title.ts';
	import TraceOutput from './TraceOutput.svelte';
	import { buildCitedPathTree, citedBundleRoot, countCitedFiles } from './artifact-tree.ts';
	import { isOutside } from '../click-outside.ts';
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


	/**
	 * The board itself, filling whatever it is put in. A pane on a wide window, a page on a phone;
	 * nothing in here knows which, and nothing in here places or sizes itself.
	 */
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
		/** Absent in a pane: a pane is closed by its own tab, not by a button inside the content. */
		onClose?: () => void;
		onJump: (sessionId: string, messageId: string) => void;
		/** The job actually on screen, so the address follows the switcher. */
		onTask?: (taskId: string) => void;
		onOpenArtifact?: (
			relpath: string,
			att?: Attachment,
			messageId?: string | null,
			forceTree?: boolean,
			taskId?: string | null,
			siblings?: Attachment[] | null
		) => void;
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
		onTask,
		onOpenArtifact
	}: Props = $props();

	let jobs = $state<SessionTaskSummary[]>([]);
	let trace = $state<TaskTrace | null>(null);
	let currentId = $state<string | null>(null);
	let loading = $state(true);
	let failed = $state(false);
	let notableOnly = $state(false);
	let switcherOpen = $state(false);
	let titleMenuEl = $state<HTMLDivElement | null>(null);
	let titleTriggerEl = $state<HTMLButtonElement | null>(null);
	/** A file opened inside this board. The preview stays here; it never opens the chat's pane. */
	let openFile = $state<{ path: string; messageId: string; attachmentId: string } | null>(null);
	/**
	 * Whether that file is filling the board.
	 *
	 * The layer is rendered outside the canvas rather than inside the preview, because the canvas
	 * carries a `transform` and anything positioned inside it is positioned against the canvas —
	 * a preview asking to cover the board would have been given the canvas instead.
	 */
	let outputFull = $state(false);
	let loadSeq = 0;

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
		// The bottom tools float over the canvas, so fitting aims at what is actually clear.
		const body = viewportEl.parentElement;
		const bottomChrome = body?.querySelector('.trace-tools')?.clientHeight ?? 0;
		const box = viewportBox();
		const clear = { width: box.width - 24, height: Math.max(120, box.height - bottomChrome - 24) };
		const fitted = fitView(boardBox(), clear);
		view = { ...fitted, y: fitted.y + 12 };
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

	function toggleSwitcher(event: MouseEvent): void {
		event.stopPropagation();
		switcherOpen = !switcherOpen;
	}

	function onMenuKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopImmediatePropagation();
			switcherOpen = false;
			titleTriggerEl?.focus();
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			const items = Array.from(titleMenuEl?.querySelectorAll<HTMLButtonElement>('.trace-job') ?? []);
			const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
			const next = items[currentIndex + 1] ?? items[0];
			next?.focus();
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			const items = Array.from(titleMenuEl?.querySelectorAll<HTMLButtonElement>('.trace-job') ?? []);
			const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
			const prev = items[currentIndex - 1] ?? items[items.length - 1];
			prev?.focus();
		}
	}

	$effect(() => {
		if (!switcherOpen) return;
		function onPointerDown(e: PointerEvent): void {
			if (isOutside(e.target as Node, titleMenuEl)) {
				switcherOpen = false;
			}
		}
		document.addEventListener('pointerdown', onPointerDown);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown);
		};
	});

	$effect(() => {
		if (switcherOpen) {
			const activeBtn = titleMenuEl?.querySelector<HTMLButtonElement>('.trace-job.is-current');
			activeBtn?.focus();
		}
	});

	function selectJob(id: string): void {
		switcherOpen = false;
		if (id === currentId) return;
		void load(id);
	}

	onMount(() => {
		void load(taskId);
		/**
		 * One Escape, one step out: full screen, then the file, then the board.
		 *
		 * All of it in a single capture listener, because two listeners racing to answer the same
		 * key is decided by which mounted first — and the shell's own Escape, which closes the
		 * board, is a window listener that was there before this pane existed.
		 */
		function onKey(event: KeyboardEvent): void {
			if (event.key !== 'Escape') return;
			if (switcherOpen) {
				event.preventDefault();
				event.stopImmediatePropagation();
				switcherOpen = false;
				titleTriggerEl?.focus();
				return;
			}
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

	function nodeBundleInfo(node: TaskTraceNode) {
		const tree = buildCitedPathTree(node.artifacts.map((a) => a.path));
		const fileCount = countCitedFiles(tree);
		const bundle = citedBundleRoot(tree);
		return { tree, fileCount, bundle };
	}

	function firstPreviewable(rows: Attachment[]): Attachment {
		return (
			rows.find((row) => row.exists !== false && !row.is_dir) ??
			rows.find((row) => row.exists !== false) ??
			rows[0]!
		);
	}

	function openNodeArtifacts(node: TaskTraceNode): void {
		if (node.artifacts.length === 0) return;
		const isBundle = node.artifacts.length > 1;
		const siblings: Attachment[] = node.artifacts.map((file) => ({
			id: file.attachment_id,
			message_id: file.message_id,
			workspace_relpath: file.path,
			original_filename: file.path.split('/').pop() || file.path,
			created_at: node.created_at,
		}));
		const target = firstPreviewable(siblings);
		if (onOpenArtifact) {
			onOpenArtifact(
				target.workspace_relpath,
				target,
				node.focus_message_id || node.trigger_message_id,
				isBundle,
				currentId ?? taskId,
				siblings
			);
		} else {
			showFile({ path: target.workspace_relpath, messageId: target.message_id, attachmentId: target.id });
		}
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
			{@const isBundle = node.artifacts.length > 1}
			{@const info = isBundle ? nodeBundleInfo(node) : null}
			{@const single = node.artifacts[0]!}
			<div class="trace-files">
				<button
					type="button"
					class="trace-file-btn trace-file"
					class:is-bundle={isBundle}
					class:is-open={node.artifacts.some((a) => openFile?.attachmentId === a.attachment_id)}
					aria-expanded={node.artifacts.some((a) => openFile?.attachmentId === a.attachment_id)}
					onclick={() => openNodeArtifacts(node)}
					title={isBundle ? node.artifacts.map((a) => a.path).join('\n') : single.path}
				>
					<div class="file-icon-box text-accent flex items-center" aria-hidden="true">
						{#if isBundle}
							<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
							</svg>
						{:else}
							<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
								<polyline points="14 2 14 8 20 8"></polyline>
							</svg>
						{/if}
					</div>
					<div class="file-meta-col flex flex-col min-w-0 flex-1">
						<span class="file-title text-12 font-semibold overflow-hidden text-ellipsis whitespace-nowrap">
							{isBundle ? (info?.bundle ?? t.stream.artifactBundle) : traceFileName(single.path)}
						</span>
						<span class="file-sub text-10 text-muted overflow-hidden text-ellipsis whitespace-nowrap" class:mono={!isBundle}>
							{isBundle ? t.stream.artifactBundleCount(info?.fileCount ?? node.artifacts.length) : single.path}
						</span>
					</div>
				</button>
			</div>
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

<div class="trace-pane">
		<header class="trace-header">
			<div class="trace-titles">
				{#if jobs.length > 1}
					<div class="trace-title-select" bind:this={titleMenuEl}>
						<button
							type="button"
							class="trace-title-trigger"
							bind:this={titleTriggerEl}
							aria-haspopup="listbox"
							aria-expanded={switcherOpen}
							onclick={toggleSwitcher}
							title={trace ? `${t.trace.title} · ${trace.title || trace.dir}` : t.trace.title}
						>
							<h2>{trace ? `${t.trace.title} · ${trace.title || trace.dir}` : t.trace.title}</h2>
							<svg
								class="trace-title-arrow"
								class:is-open={switcherOpen}
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2.5"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<polyline points="6 9 12 15 18 9"></polyline>
							</svg>
						</button>
						{#if switcherOpen}
							<div
								class="trace-switcher-popover"
								role="listbox"
								tabindex="-1"
								aria-label={t.trace.title}
								onkeydown={onMenuKeydown}
							>
								{#each jobs as job (job.id)}
									<button
										type="button"
										role="option"
										class="trace-job"
										class:is-current={job.id === currentId}
										aria-selected={job.id === currentId}
										onclick={() => {
											selectJob(job.id);
											titleTriggerEl?.focus();
										}}
									>
										<span class="trace-job-check" aria-hidden="true">
											{#if job.id === currentId}
												<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
													<polyline points="20 6 9 17 4 12"></polyline>
												</svg>
											{/if}
										</span>
										<div class="trace-job-info">
											<span class="trace-job-title">{job.title || job.dir}</span>
											<span class="trace-job-meta mono">{job.closed_at ? t.trace.closed : t.trace.open} · {job.dir}</span>
										</div>
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{:else}
					<h2>{trace ? `${t.trace.title} · ${trace.title || trace.dir}` : t.trace.title}</h2>
				{/if}
				{#if trace}
					<span class="trace-meta">{trace.closed_at ? t.trace.closed : t.trace.open} · {trace.dir}</span>
				{/if}
			</div>
			{#if onClose}
			<button type="button" class="sheet-close" title={t.common.close} onclick={onClose}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="18" y1="6" x2="6" y2="18"></line>
					<line x1="6" y1="6" x2="18" y2="18"></line>
				</svg>
			</button>
			{/if}
		</header>
		<div class="trace-body">
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

<style>


	/* Fills its host. Where it sits and what it sits on are the host's business. */
	.trace-pane {
		position: relative;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--pane);
	}


	/*
	 * The grips draw nothing. A corner mark is clutter on a window that is mostly picture, and the
	 * cursor over the corner already says the window can be pulled there. They sit above the board
	 * because the viewport is positioned and comes later in the markup — without that it paints
	 * over the corners and a press that should resize pans the board instead.
	 */





	.trace-header {
		position: relative;
		z-index: 10;
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 14px 10px;
		border-bottom: 1px solid var(--line);
		background: var(--sidebar-bg);
		user-select: none;
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

	.trace-title-select {
		position: relative;
		display: inline-flex;
		align-items: center;
		min-width: 0;
		max-width: 100%;
	}

	.trace-title-trigger {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		max-width: 100%;
		margin: -3px -6px;
		padding: 3px 6px;
		border-radius: var(--radius-sm);
		border: 1px solid transparent;
		background: transparent;
		color: var(--ink);
		cursor: pointer;
		text-align: left;
		transition: background 0.15s ease, border-color 0.15s ease;
	}

	.trace-title-trigger:hover {
		background: var(--chip);
		border-color: var(--line-subtle);
	}

	.trace-title-trigger:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.trace-title-arrow {
		flex: none;
		color: var(--muted);
		transition: transform 0.2s ease;
	}

	.trace-title-arrow.is-open {
		transform: rotate(180deg);
	}

	.trace-switcher-popover {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 100;
		min-width: 260px;
		max-width: min(440px, calc(100vw - 32px));
		max-height: 280px;
		overflow-y: auto;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-md);
		padding: 4px;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.trace-job {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		width: 100%;
		padding: 6px 8px;
		border-radius: var(--radius-sm);
		border: 1px solid transparent;
		background: transparent;
		color: var(--ink);
		cursor: pointer;
		text-align: left;
		font-size: 12px;
		transition: background 0.12s ease, color 0.12s ease;
		box-sizing: border-box;
	}

	.trace-job:hover,
	.trace-job:focus-visible {
		background: var(--chip);
		outline: none;
	}

	.trace-job.is-current {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
		font-weight: 500;
	}

	.trace-job-check {
		flex: none;
		width: 14px;
		height: 14px;
		display: flex;
		align-items: center;
		justify-content: center;
		margin-top: 2px;
		color: var(--accent);
	}

	.trace-job-info {
		min-width: 0;
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.trace-job-title {
		font-weight: inherit;
		color: inherit;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.trace-job-meta {
		font-size: 11px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.trace-job.is-current .trace-job-meta {
		color: color-mix(in srgb, var(--accent) 70%, var(--muted));
	}

	.trace-meta {
		font-size: 11.5px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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

	.trace-tools {
		position: absolute;
		z-index: 1;
		left: 0;
		right: 0;
		bottom: 0;
		padding: 6px 10px;
		background: color-mix(in srgb, var(--pane) 86%, transparent);
		backdrop-filter: blur(6px);
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

	/* Over the board, at life size. Against the board rather than the screen: in a pane the
	   screen is the wrong thing to cover, and the host decides how big the board is. */
	.trace-output-layer {
		position: absolute;
		inset: 12px;
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
		padding: 0 10px 9px;
	}

	.trace-file-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 10px;
		background: var(--chip);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		cursor: pointer;
		text-align: left;
		transition: border-color 0.15s ease, background 0.15s ease;
		color: var(--ink);
		box-sizing: border-box;
	}

	.trace-file-btn:hover,
	.trace-file-btn.is-open {
		border-color: var(--accent-border);
		background: var(--line-subtle);
	}

	.trace-file-btn.is-open {
		background: var(--accent-tint);
	}

	.trace-file-btn .file-icon-box {
		flex: none;
		display: flex;
		align-items: center;
		color: var(--accent);
	}

	.trace-file-btn .file-meta-col {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}

	.trace-file-btn .file-title {
		font-size: 12px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.25;
	}

	.trace-file-btn .file-sub {
		font-size: 10px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.25;
		margin-top: 1px;
	}

</style>
