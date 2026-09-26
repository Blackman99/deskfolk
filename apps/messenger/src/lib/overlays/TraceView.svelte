<script lang="ts">
	import {
		USER_MEMBER,
		type Attachment,
		type Bot,
		type PlanStatus,
		type Provider,
		type SessionSummary,
		type SessionTaskSummary,
		type TaskDetail,
		type TaskTrace,
		type TaskTraceNode,
		type Ticket,
		type TicketWithArtifacts
	} from '@real-bot/protocol';
	import { onMount, untrack } from 'svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { classifySession, youBotPeer } from '../sidebar/session-groups.ts';
	import { sessionTitle } from '../sidebar/session-title.ts';
	import PlanSpecPanel from './PlanSpecPanel.svelte';
	import TicketList from './TicketList.svelte';
	import {
		actorFace,
		actorName,
		firstPreviewable,
		openTicketCount,
		planTitle,
		ticketArtifactAttachments,
		ticketTag,
		totalTicketCount
	} from './plan-board.ts';
	import { formatDurationMs, formatFullTimestamp, formatMessageTime } from '../chat/chat-view.ts';
	import { routeCardRow, type RouteLogRow } from './route-log.ts';
	import { buildCitedPathTree, citedBundleRoot, countCitedFiles } from './artifact-tree.ts';
	import { isOutside } from '../click-outside.ts';
	import { deferWhileDragging } from '../workbench/pane-resize.svelte.ts';
	import { prefersReducedMotion } from '../reduced-motion.ts';
	import {
		clampZoom,
		filterTrace,
		centerOnNode,
		fitView,
		focusMoveDue,
		focusNode,
		boardViewAge,
		glideView,
		openView,
		rememberBoardView,
		rememberedBoardView,
		saidNothing,
		TRACE_GLIDE_MS,
		highlightOf,
		routeHighlightCounts,
		pinchSpan,
		traceFileName,
		traceFlow,
		wokenByName,
		zoomAt,
		TRACE_CARD_WIDTH,
		TRACE_ZOOM_MAX,
		TRACE_ZOOM_MIN,
		type RouteHighlight,
		type TraceBox,
		type TraceFocus,
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
		/** The message whose card to centre. A new `focusToken` is a new request to move. */
		focus?: TraceFocus | null;
		focusToken?: number;
		sessionId: string;
		/** The conversation on screen, so the node that lives there reads as the one you are on. */
		activeSessionId: string;
		sessions: readonly SessionSummary[];
		bots: readonly Bot[];
		/** Names the endpoint a turn ran on, once there is more than one to tell apart. */
		providers?: readonly Provider[];
		youLabel: string;
		deletedLabel: string;
		workspacePath: string | null;
		t: Copy;
		reloadToken: number;
		/** A page (the phone) opens with the plan's spec folded; a pane has the room to show it. */
		host?: 'pane' | 'page';
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
		focus = null,
		focusToken = 0,
		sessionId,
		activeSessionId,
		sessions,
		bots,
		providers = [],
		youLabel,
		deletedLabel,
		workspacePath,
		t,
		reloadToken,
		host = 'pane',
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
	/**
	 * The plan behind the trace: its spec, revision and tickets. Null until it arrives, and null
	 * for good on a daemon that predates plans — the tree still draws, without the panel and rail.
	 */
	let detail = $state<TaskDetail | null>(null);
	/** The ticket whose cards are lit; the rest of the board dims. One at a time, like a highlight. */
	let selectedTicket = $state<string | null>(null);
	/** On a narrow host the rail and the tree take turns; on a wide one they sit side by side. */
	let segment = $state<'trace' | 'tickets'>('trace');
	/** The card whose model choice is unfolded under it. One at a time. */
	let openRoute = $state<string | null>(null);
	/** Which kind of model trouble the board is lighting up, if any. */
	let highlight = $state<RouteHighlight | null>(null);
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
	/**
	 * The last place this job's board was left, so bringing its tab forward can slide from there.
	 * A tab that is not the one showing is unmounted, and without this the board would open on
	 * the card in a jump.
	 */
	const remembered = rememberedBoardView(sessionId, taskId);
	let view = $state<TraceView>(remembered ?? { scale: 1, x: 0, y: 0 });
	/**
	 * This board was already open a moment ago, just not the tab in front, so the first move
	 * slides. A layout restored tomorrow starts where it was without sliding across the window.
	 */
	let glideFromMemory = (boardViewAge(sessionId, taskId) ?? Infinity) < 10_000;
	let viewportEl = $state<HTMLElement | null>(null);
	let fitted: string | null = null;
	/** Which focus request has already moved the board. A reload of the same one does not. */
	let placedFocus = $state<number | null>(null);
	/** Where that card was when we centred it, so a later measurement can follow it once. */
	let anchored = $state<{ token: number; turn: string; x: number; y: number; width: number; height: number } | null>(null);
	/** A pan or a zoom is the view being yours; a measurement must not pull it back. */
	let userMoved = false;
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

	/** The bottom tools float over the canvas, so fitting aims at what is actually clear. */
	function clearBox(): { width: number; height: number } {
		const bottomChrome = viewportEl?.parentElement?.querySelector('.trace-tools')?.clientHeight ?? 0;
		const box = viewportBox();
		return { width: box.width - 24, height: Math.max(120, box.height - bottomChrome - 24) };
	}

	function fitBoard(): void {
		stopGlide();
		if (!flow?.width || !viewportEl) return;
		const fitted = fitView(boardBox(), clearBox());
		view = { ...fitted, y: fitted.y + 12 };
	}

	/** The view the board opened on, so the cards' measurements can move it while it still is. */
	let openedView: (TraceView & { job: string }) | null = null;

	/** Whole when the whole board can be read; otherwise on its newest round, at the bottom. */
	function openBoard(): void {
		stopGlide();
		if (!flow?.width || !viewportEl || !currentId) return;
		const opened = openView(flow, clearBox());
		view = { ...opened, y: opened.y + 12 };
		openedView = { ...view, job: currentId };
	}

	/**
	 * Still on the view it opened on. The first paint lays the board out from estimated heights and
	 * the measured ones land a frame later, taller or shorter, which moves the bottom it opened on.
	 * Any pan, zoom, fit or slide is a different view, and from then on the view is yours.
	 */
	function stillOpened(): boolean {
		const at = openedView;
		return !!at && at.job === currentId && at.x === view.x && at.y === view.y && at.scale === view.scale;
	}

	/**
	 * Put the asked-for card in the middle, at a size a card can be read at.
	 * False when the viewport has no size yet, or this job has no such card — the caller fits.
	 */
	function focusBoard(): boolean {
		if (!focus || !flow || !viewportEl) return false;
		const box = viewportBox();
		if (!box.width || !box.height) return false;
		const node = focusNode(flow.placements.map((placement) => placement.node), focus);
		const placement = node ? flow.placements.find((row) => row.node.turn_id === node.turn_id) : null;
		placedFocus = focusToken;
		if (!placement) return false;
		const next = centerOnNode(placement, box);
		if (glideThis) glideTo(next);
		else view = next;
		anchored = {
			token: focusToken,
			turn: placement.node.turn_id,
			x: placement.x,
			y: placement.y,
			width: placement.width,
			height: placement.height
		};
		return true;
	}

	/** The card moved after we centred it — the first measurement, usually. */
	function focusDrifted(): boolean {
		const here = anchored;
		if (!here || here.token !== focusToken || !flow) return false;
		const placement = flow.placements.find((row) => row.node.turn_id === here.turn);
		if (!placement) return false;
		return (
			placement.x !== here.x ||
			placement.y !== here.y ||
			placement.width !== here.width ||
			placement.height !== here.height
		);
	}

	/**
	 * A new message's request starts from a view that is not yours yet.
	 *
	 * Read when the token changes, not while the board is being centred: writing `userMoved`
	 * there would re-run the effect that just wrote it. A board that was already showing this
	 * job slides; one that is opening lands on the card at once.
	 */
	let seenFocus = untrack(() => focusToken);
	let glideThis = false;
	let glideFrame: ReturnType<typeof setTimeout> | 0 = 0;
	/** Where the slide in progress is going, so an unmount keeps the end and not the halfway. */
	let glideTarget: TraceView | null = null;
	$effect(() => {
		const token = focusToken;
		if (token === seenFocus) return;
		seenFocus = token;
		untrack(() => {
			userMoved = false;
			glideThis = glideFromMemory || (fitted === currentId && currentId !== null);
			glideFromMemory = false;
		});
	});

	function stopGlide(): void {
		if (!glideFrame) return;
		clearTimeout(glideFrame);
		glideFrame = 0;
		glideTarget = null;
	}

	/**
	 * Slide the board that is already on screen. A fresh one has nothing to slide from.
	 *
	 * The clock is `setTimeout`, not an animation frame: the board lives in its own tab, and a
	 * frame never fires while that tab is in the background, which would leave the slide halfway.
	 */
	function glideTo(next: TraceView): void {
		stopGlide();
		if (prefersReducedMotion()) {
			view = next;
			return;
		}
		const from = view;
		const started = performance.now();
		glideTarget = next;
		const step = () => {
			const t = (performance.now() - started) / TRACE_GLIDE_MS;
			if (t >= 1) {
				view = next;
				glideFrame = 0;
				glideTarget = null;
				return;
			}
			view = glideView(from, next, t);
			glideFrame = setTimeout(step, 16);
		};
		glideFrame = setTimeout(step, 16);
	}

	$effect(() => () => {
		if (glideTarget && currentId) rememberBoardView(sessionId, currentId, glideTarget);
		stopGlide();
	});

	$effect(() => {
		const id = currentId;
		const here = view;
		if (!id) return;
		untrack(() => {
			if (glideFrame) return;
			rememberBoardView(sessionId, id, here);
		});
	});

	function zoomBy(factor: number, at?: { x: number; y: number }): void {
		stopGlide();
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
			userMoved = true;
			stopGlide();
			settle({ ...view, x: view.x - (event.deltaX || event.deltaY), y: view.y });
			return;
		}
		userMoved = true;
		stopGlide();
		const step = Math.exp(-event.deltaY / 400);
		settle(zoomAt(view, view.scale * step, localPoint(event)));
	}

	function onPointerDown(event: PointerEvent): void {
		// Anywhere is the canvas, cards included: a press that turns into a drag pans, and a
		// press that does not is still the card's click. Reserving the cards would have left
		// most of a full board unpannable, which is the whole board once it is zoomed in.
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
			userMoved = true;
			stopGlide();
			return;
		}
		if (!drag) return;
		const dx = event.clientX - drag.x;
		const dy = event.clientY - drag.y;
		if (!dragged && Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
		if (!dragged) {
			dragged = true;
			userMoved = true;
			stopGlide();
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
		// A board opens showing all of itself; a message opens on its card. After that the view
		// is yours, until another message asks. The card's first real measurement still counts
		// as that opening, so the move lands on the card you see, not the guess that preceded it.
		const width = flow?.width ?? 0;
		const id = currentId;
		const token = focusToken;
		const asked = focus;
		const drift = focusDrifted();
		if (!width || !id || !viewportEl) return;
		// The board keeps the previous job on screen until the one this message belongs to
		// arrives. Moving before that would spend the request on the wrong picture.
		if (asked && taskId && trace?.id !== taskId && focusMoveDue(token, placedFocus)) return;
		if (asked && (focusMoveDue(token, placedFocus) || (drift && !untrack(() => userMoved)))) {
			const centred = untrack(() => focusBoard());
			if (placedFocus !== token) return;
			if (!centred) {
				fitted = id;
				untrack(() => openBoard());
				return;
			}
		}
		if (fitted === id) {
			// Reading the view here would re-run this on every pan; it is only compared, once per layout.
			untrack(() => {
				if (stillOpened()) openBoard();
			});
			return;
		}
		fitted = id;
		if (!(asked && placedFocus === token)) untrack(() => openBoard());
	});

	/** A pane is often zero-sized for the first frame; the move waits until it has a box. */
	function watchViewport(node: HTMLElement) {
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(() => {
			if (focus && focusMoveDue(focusToken, placedFocus)) focusBoard();
		});
		observer.observe(node);
		return { destroy: () => observer.disconnect() };
	}

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
		// A pane resize used to write every card's box on each frame and lay the board out again.
		const deferred = deferWhileDragging(() => recordBox(id, element));
		deferred.run();
		if (typeof ResizeObserver === 'undefined') {
			return { destroy: () => { deferred.cancel(); slots.delete(id); } };
		}
		const observer = new ResizeObserver(deferred.run);
		observer.observe(element);
		return {
			destroy: () => {
				observer.disconnect();
				deferred.cancel();
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
	/** The card this opening was asked to land on, while that request is the one on screen. */
	const focusedTurn = $derived(
		focus && placedFocus === focusToken && shown ? focusNode(shown.nodes, focus)?.turn_id ?? null : null
	);
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

	/** How many cards each highlight would light. A chip with nothing to show is not offered. */
	const highlightCounts = $derived(
		trace ? routeHighlightCounts(trace.nodes) : { feedback: 0, blamed: 0 }
	);
	const lighting = $derived(highlight && highlightCounts[highlight] > 0 ? highlight : null);
	const ticketsById = $derived(new Map((detail?.tickets ?? []).map((ticket) => [ticket.id, ticket])));
	const planStatus = $derived<PlanStatus>(detail?.status ?? (trace?.closed_at ? 'done' : 'active'));
	const heading = $derived(trace ? `${t.trace.title} · ${planTitle(detail ?? trace)}` : t.trace.title);

	/** A switcher row from a daemon that predates plans has neither a status nor counts. */
	function planStatusOf(job: SessionTaskSummary): PlanStatus {
		return job.status ?? (job.closed_at ? 'done' : 'active');
	}

	/** The ticket a card worked in, as `01`; nothing on your own card and on turns filed under none. */
	function ticketOf(node: TaskTraceNode): Ticket | null {
		return node.ticket_id ? (ticketsById.get(node.ticket_id) ?? null) : null;
	}

	/** Lit when the selected ticket is this card's; dim when a ticket is selected and it is not. */
	function ticketLightOf(node: TaskTraceNode): 'lit' | 'dim' | null {
		if (!selectedTicket) return null;
		return node.ticket_id === selectedTicket ? 'lit' : 'dim';
	}

	/** A ticket and a model highlight both light cards; showing both at once would say nothing. */
	function selectTicket(id: string | null): void {
		selectedTicket = id;
		if (id) highlight = null;
	}

	function toggleHighlight(kind: RouteHighlight): void {
		highlight = lighting === kind ? null : kind;
		if (highlight) selectedTicket = null;
	}

	/** A ticket you moved comes back alone; the plan's counts and revision moved with it. */
	function ticketPatched(ticket: Ticket): void {
		if (!detail) return;
		detail = {
			...detail,
			revision: detail.revision + 1,
			revision_actor: 'user',
			tickets: detail.tickets.map((row) => (row.id === ticket.id ? { ...row, ...ticket } : row))
		};
		void reloadPlan();
	}

	/** The plan changed under an edit, or a ticket moved: read it again, the tree with it. */
	function reloadPlan(): void {
		void load(currentId ?? taskId);
	}

	function openTicketArtifacts(ticket: TicketWithArtifacts): void {
		const siblings = ticketArtifactAttachments(ticket);
		const target = firstPreviewable(siblings);
		if (!target || !onOpenArtifact) return;
		onOpenArtifact(target.workspace_relpath, target, target.message_id, true, currentId ?? taskId, siblings);
	}
	const routeInput = $derived({
		bots,
		providers,
		labels: {
			outcome: t.routes.outcome,
			fault: t.routes.fault,
			direction: t.routes.direction,
			signature: t.routes.signature,
			failReason: t.routes.failReason,
			thinking: t.routes.thinking,
			unknownBot: deletedLabel
		}
	});
	function routeOf(node: TaskTraceNode): RouteLogRow | null {
		return node.route ? routeCardRow(node.route, routeInput) : null;
	}

	function toggleRoute(node: TaskTraceNode): void {
		openRoute = openRoute === node.turn_id ? null : node.turn_id;
	}

	function nameOf(actor: string): string {
		return actorName(actor, botsById, youLabel, deletedLabel);
	}

	function avatarOf(actor: string): ReturnType<typeof actorFace> {
		return actorFace(actor, botsById, youLabel, deletedLabel);
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
		return t.trace.sessionDirect(sessionTitle(session, botsById, { deleted: deletedLabel, archived: deletedLabel, fileDrop: t.sidebar.fileDrop }));
	}

	/** The plan behind a trace; none from a daemon that predates plans, and none is not a failure. */
	async function readDetail(id: string): Promise<TaskDetail | null> {
		try {
			return await api!.taskDetail(id);
		} catch {
			return null;
		}
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
			// A refresh of the same plan keeps what you unfolded and lit; switching plans does not.
			if (next !== currentId) {
				openRoute = null;
				selectedTicket = null;
				segment = 'trace';
			}
			currentId = next;
			if (next) onTask?.(next);
			// The tree and the plan, together. A daemon that predates plans answers the second with a
			// 404, and the board is then the tree alone — as it was.
			const [nextTrace, nextDetail] = next ? await Promise.all([api.taskTrace(next), readDetail(next)]) : [null, null];
			if (seq !== loadSeq) return;
			trace = nextTrace;
			detail = nextDetail;
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
		 * One Escape, one step out: the switcher, then an unfolded model choice, then a lit ticket,
		 * then the board.
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
			if (openRoute) {
				event.preventDefault();
				event.stopImmediatePropagation();
				openRoute = null;
				return;
			}
			if (!selectedTicket) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			selectedTicket = null;
		}
		window.addEventListener('keydown', onKey, true);
		return () => {
			window.removeEventListener('keydown', onKey, true);
		};
	});

	/**
	 * A live plan reloads on every turn, message, filing and ticket move. A fan-out lands several of
	 * those within a frame; one read a moment later shows all of them.
	 */
	$effect(() => {
		void reloadToken;
		if (reloadToken === 0) return;
		const timer = setTimeout(() => void load(currentId ?? taskId), 150);
		return () => clearTimeout(timer);
	});

	/**
	 * Pointed at another job from outside — a card, a link, the conversation's own button. The
	 * job picked in here comes back through `onTask` and lands as the same value, so it is not
	 * fetched twice.
	 */
	let requestedTask = untrack(() => taskId);
	$effect(() => {
		const next = taskId;
		if (next === requestedTask) return;
		requestedTask = next;
		if (next && next !== untrack(() => currentId)) untrack(() => void load(next));
	});

	/** A different conversation shows that conversation's job. */
	let loadedFor = sessionId;
	$effect(() => {
		const next = sessionId;
		if (next === loadedFor) return;
		loadedFor = next;
		untrack(() => void load(null));
	});

	function openCard(node: TaskTraceNode): void {
		const messageId = node.approval?.message_id ?? node.ask?.message_id ?? node.focus_message_id;
		onJump(node.session_id, messageId);
	}


	function nodeBundleInfo(node: TaskTraceNode) {
		const tree = buildCitedPathTree(node.artifacts.map((a) => a.path));
		const fileCount = countCitedFiles(tree);
		const bundle = citedBundleRoot(tree);
		return { tree, fileCount, bundle };
	}

	/** A file a card handed over opens in the host's preview; the board itself shows no file. */
	function openNodeArtifacts(node: TaskTraceNode): void {
		if (node.artifacts.length === 0 || !onOpenArtifact) return;
		const isBundle = node.artifacts.length > 1;
		const siblings: Attachment[] = node.artifacts.map((file) => ({
			id: file.attachment_id,
			message_id: file.message_id,
			workspace_relpath: file.path,
			original_filename: file.path.split('/').pop() || file.path,
			created_at: node.created_at,
			...(file.exists === undefined ? {} : { exists: file.exists }),
		}));
		const target = firstPreviewable(siblings);
		if (!target) return;
		onOpenArtifact(
			target.workspace_relpath,
			target,
			node.focus_message_id || node.trigger_message_id,
			isBundle,
			currentId ?? taskId,
			siblings
		);
	}
</script>

{#snippet card(node: TaskTraceNode)}
	<!-- An edge already says who woke this card; words are for the ones with no line to follow. -->
	{@const from =
		node.woken_by_turn_id && byId.has(node.woken_by_turn_id)
			? null
			: wokenByName(node, byId, nameOf)}
	{@const face = avatarOf(node.actor)}
	{@const route = routeOf(node)}
	{@const lit = highlightOf(node, lighting)}
	{@const ticket = ticketOf(node)}
	{@const ticketLight = ticketLightOf(node)}
	<article
		class="trace-card is-{node.status}"
		class:is-here={node.session_id === activeSessionId}
		class:is-focus={focusedTurn === node.turn_id}
		class:is-lit={lit === 'lit' || ticketLight === 'lit'}
		class:is-lit-blamed={lit === 'lit' && lighting === 'blamed'}
		class:is-dim={lit === 'dim' || ticketLight === 'dim'}
	>
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
				{#if ticket}
					<span class="trace-ticket-tag mono" title={ticket.title}>{ticketTag(ticket.seq)}</span>
				{/if}
			</span>
			{#if from}
				<span class="trace-woken">{t.trace.wokenBy(from)}</span>
			{/if}
			{#if saidNothing(node)}
				<!-- Its summary would be the line that woke it, read as the Bot saying it. -->
				<span class="trace-silent">{t.trace.silent}</span>
			{:else if node.summary}
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
		{#if route}
			<!-- How this turn ran: the model it was given, and the trouble that came of it. -->
			<div class="trace-route-line">
				<button
					type="button"
					class="trace-route-btn"
					class:is-open={openRoute === node.turn_id}
					aria-expanded={openRoute === node.turn_id}
					title={t.routes.cardToggle}
					onclick={() => toggleRoute(node)}
				>
					<span class="trace-route-model mono">{route.model}</span>
					<span class="trace-route-meta">{t.routes.thinkingPrefix} {route.thinkingLabel} · {route.signatureLabel}</span>
					<span class="trace-route-flags">
						{#if route.review?.blamedModel}
							<span class="trace-route-flag is-blamed" title={t.routes.filterBlamed}>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
							</span>
						{/if}
						{#if route.feedback.length > 0}
							<span class="trace-route-flag is-feedback" title={t.routes.feedbackCount(route.feedback.length)}>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
								<span class="mono">{route.feedback.length}</span>
							</span>
						{/if}
						{#if route.failReason}
							<span class="trace-route-flag is-failed" title={route.failReason}>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
							</span>
						{/if}
					</span>
					<svg class="trace-route-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
				</button>
			</div>
		{/if}
		{#if node.artifacts.length > 0}
			{@const isBundle = node.artifacts.length > 1}
			{@const info = isBundle ? nodeBundleInfo(node) : null}
			{@const single = node.artifacts[0]!}
			<div class="trace-files">
				<button
					type="button"
					class="trace-file-btn trace-file"
					class:is-bundle={isBundle}
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

{#snippet routeDetail(node: TaskTraceNode, route: RouteLogRow)}
	<!-- Unfolded under its own card, the way a file is: what was picked, why, and what came of it. -->
	<section class="trace-route" aria-label={t.routes.cardTitle}>
		<header class="trace-route-head">
			<span class="trace-route-title">{t.routes.cardTitle}</span>
			<span class="trace-route-outcome is-{route.outcome}">{route.outcomeLabel}</span>
			<button type="button" class="trace-route-close" title={t.trace.outputClose} aria-label={t.trace.outputClose} onclick={() => (openRoute = null)}>
				<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
			</button>
		</header>
		<div class="trace-route-chips">
			<span class="trace-route-chip is-model mono" title={route.model}>{route.model}</span>
			<span class="trace-route-chip">{t.routes.thinkingPrefix} {route.thinkingLabel}</span>
			<span class="trace-route-chip" title={t.routes.kindLabel}>{route.signatureLabel}</span>
			{#if providers.length > 1 && route.providerName}
				<span class="trace-route-chip" title={t.routes.endpoint}>{route.providerName}</span>
			{/if}
		</div>
		{#if route.durationMs !== null || (route.hops !== null && route.toolErrors !== null)}
			<p class="trace-route-stats mono">
				{#if route.durationMs !== null}{formatDurationMs(route.durationMs)}{/if}{#if route.durationMs !== null && route.hops !== null && route.toolErrors !== null}{' · '}{/if}{#if route.hops !== null && route.toolErrors !== null}{t.routes.execution(route.hops, route.toolErrors)}{/if}
			</p>
		{/if}
		{#if route.failReason}
			<p class="trace-route-fail">{route.failReason}</p>
		{/if}
		{#if route.reason}
			<p class="trace-route-why"><span class="trace-route-label">{t.routes.pickReason}</span>{route.reason}</p>
		{/if}
		{#if route.feedback.length > 0}
			<div class="trace-route-block">
				<span class="trace-route-label">{t.routes.feedbackCount(route.feedback.length)}</span>
				<ul class="trace-route-feedback">
					{#each route.feedback as note (note.message_id)}
						<li>
							<button
								type="button"
								class="trace-route-note"
								title={t.routes.jump}
								onclick={() => onJump(node.session_id, note.message_id)}
							>
								<span class="trace-route-note-body">{note.body}</span>
								<span class="trace-route-note-time mono" title={formatFullTimestamp(note.created_at)}>{formatMessageTime(note.created_at)}</span>
							</button>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
		{#if route.review}
			<div class="trace-route-block trace-route-review" class:is-model={route.review.blamedModel}>
				<span class="trace-route-review-head">
					<span class="trace-route-label">{t.routes.reviewTitle}</span>
					<span class="trace-route-fault">{route.review.faultLabel}</span>
					{#if route.review.directionLabel}
						<span class="trace-route-direction">{route.review.directionLabel}</span>
					{/if}
					{#if route.review.rounds > 0}
						<span class="trace-route-rounds">{t.routes.reviewRounds(route.review.rounds)}</span>
					{/if}
				</span>
				{#if route.review.reason}
					<span class="trace-route-review-reason">{route.review.reason}</span>
				{/if}
				{#if route.review.retired}
					<span class="trace-route-effect">{t.routes.effectRetired}</span>
				{:else if route.review.effect === 'unknown'}
					<span class="trace-route-effect">{t.routes.effectUnused}</span>
				{:else if route.review.effect === 'followed'}
					<span class="trace-route-effect">{t.routes.effectFollowed}{route.review.cleaner ? ` · ${t.routes.effectCleaner}` : ''}</span>
				{/if}
			</div>
		{/if}
		{#if route.learning}
			<p class="trace-route-learning">
				{route.learning.kind === 'memory'
					? t.routes.learnedMemory(route.learning.label)
					: route.learning.kind === 'skill'
						? t.routes.learnedSkill(route.learning.label)
						: t.routes.learnedNone}
			</p>
		{/if}
	</section>
{/snippet}

<div class="trace-pane" class:is-page={host === 'page'} class:is-tickets={segment === 'tickets'}>
	<div class="trace-top">
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
							title={heading}
						>
							<h2>{heading}</h2>
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
									{@const status = planStatusOf(job)}
									{@const total = totalTicketCount(job.ticket_counts)}
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
											<span class="trace-job-title">{planTitle(job)}</span>
											<span class="trace-job-meta">
												<span class="plan-status is-{status}">{t.plan.status[status]}</span>
												{#if total > 0} · {t.plan.ticketCounts(openTicketCount(job.ticket_counts), total)}{/if}
												 · <span class="mono">{job.dir}</span>
											</span>
										</div>
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{:else}
					<h2>{heading}</h2>
				{/if}
				{#if trace}
					<span class="trace-meta">
						<span class="plan-status is-{planStatus}">{t.plan.status[planStatus]}</span>
						{#if detail?.kind} · {detail.kind}{/if}
						{#if detail && totalTicketCount(detail.ticket_counts) > 0}
							 · {t.plan.ticketCounts(openTicketCount(detail.ticket_counts), totalTicketCount(detail.ticket_counts))}
						{/if}
						 · <span class="mono">{trace.dir}</span>
					</span>
				{/if}
			</div>
			<div class="trace-header-end">
				{#if detail}
					<!-- Only a narrow host shows these: there the rail and the tree take turns. -->
					<div class="trace-segments" role="tablist" aria-label={t.plan.tickets}>
						<button type="button" role="tab" aria-selected={segment === 'trace'} class:is-on={segment === 'trace'} onclick={() => (segment = 'trace')}>{t.plan.segmentTrace}</button>
						<button type="button" role="tab" aria-selected={segment === 'tickets'} class:is-on={segment === 'tickets'} onclick={() => (segment = 'tickets')}>{t.plan.segmentTickets}</button>
					</div>
				{/if}
				{#if onClose}
				<button type="button" class="sheet-close" title={t.common.close} onclick={onClose}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="18" y1="6" x2="6" y2="18"></line>
						<line x1="6" y1="6" x2="18" y2="18"></line>
					</svg>
				</button>
				{/if}
			</div>
		</header>
		{#if detail}
			<PlanSpecPanel
				{api}
				{detail}
				{t}
				defaultOpen={host !== 'page'}
				onSaved={(next) => (detail = next)}
				onConflict={reloadPlan}
				{onJump}
			/>
		{/if}
	</div>
	<div class="trace-body">
		<div class="trace-stage">
		{#if trace && trace.nodes.length > 0}
			<div class="trace-tools">
				<div class="trace-tools-start">
					<label class="trace-filter">
						<input type="checkbox" bind:checked={notableOnly} />
						<span>{t.trace.filter}</span>
					</label>
					{#if highlightCounts.feedback > 0}
						<button
							type="button"
							class="trace-highlight is-feedback"
							aria-pressed={lighting === 'feedback'}
							onclick={() => toggleHighlight('feedback')}
						>
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
							<span>{t.routes.filterFeedback}</span>
							<span class="mono">{highlightCounts.feedback}</span>
						</button>
					{/if}
					{#if highlightCounts.blamed > 0}
						<button
							type="button"
							class="trace-highlight is-blamed"
							aria-pressed={lighting === 'blamed'}
							onclick={() => toggleHighlight('blamed')}
						>
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
							<span>{t.routes.filterBlamed}</span>
							<span class="mono">{highlightCounts.blamed}</span>
						</button>
					{/if}
				</div>
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
			use:watchViewport
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
								{#if openRoute === placement.node.turn_id}
									{@const route = routeOf(placement.node)}
									{#if route}
										{@render routeDetail(placement.node, route)}
									{/if}
								{/if}
							</div>
						{/each}
					</div>
				{/if}
		</div>
		</div>
		{#if detail}
			<aside class="trace-rail">
				<TicketList
					{api}
					{detail}
					nodes={shown?.nodes ?? []}
					{bots}
					{youLabel}
					{deletedLabel}
					{t}
					selectedId={selectedTicket}
					onSelect={selectTicket}
					{onJump}
					onOpenArtifacts={openTicketArtifacts}
					onPatched={ticketPatched}
					onConflict={reloadPlan}
				/>
			</aside>
		{/if}
	</div>
</div>

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
		/* The rail folds by the board's own width, not the window's: a narrow pane is a phone. */
		container: trace / inline-size;
	}

	/* The title row and the plan's spec under it, one block above the picture. */
	.trace-top {
		position: relative;
		z-index: 10;
		flex: none;
		display: flex;
		flex-direction: column;
		max-height: 60%;
		overflow-y: auto;
		border-bottom: 1px solid var(--line);
		background: var(--sidebar-bg);
	}

	.trace-header-end {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.plan-status {
		display: inline-block;
		padding: 0 6px;
		border: 1px solid var(--line);
		border-radius: 9999px;
		background: var(--chip);
		color: var(--muted);
		font-size: 10.5px;
		font-weight: 600;
		line-height: 16px;
		white-space: nowrap;
		vertical-align: 1px;
	}

	.plan-status.is-active {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.plan-status.is-done {
		border-color: var(--ok-line);
		background: var(--ok-bg);
		color: var(--ok-text);
	}

	.trace-segments {
		display: none;
		align-items: center;
		padding: 3px;
		border: 1px solid var(--line);
		border-radius: 9999px;
		background: var(--chip);
		gap: 2px;
	}

	.trace-segments button {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 4px 11px;
		border: 0;
		border-radius: 9999px;
		background: transparent;
		color: var(--muted);
		font: 600 11.5px/1.2 var(--font);
		cursor: pointer;
		min-height: 28px;
		transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
		user-select: none;
	}

	.trace-segments button.is-on {
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-xs);
	}

	/* The ticket a card worked in, as its number; the rail says the rest. */
	.trace-ticket-tag {
		flex: none;
		padding: 0 5px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--muted);
		font-size: 10px;
		font-weight: 600;
		line-height: 15px;
	}

	/* The picture and, beside it, the plan's tickets. */
	.trace-stage {
		position: relative;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}

	.trace-rail {
		flex: none;
		width: 288px;
		min-height: 0;
		overflow-y: auto;
		border-left: 1px solid var(--line);
		background: var(--sidebar-bg);
		-webkit-overflow-scrolling: touch;
	}

	@container trace (max-width: 560px) {
		.trace-segments {
			display: inline-flex;
		}

		.trace-rail {
			display: none;
		}

		.trace-pane.is-tickets .trace-rail {
			display: block;
			width: 100%;
			border-left: 0;
			overflow-y: auto;
		}

		.trace-pane.is-tickets .trace-stage {
			display: none;
		}
	}


	/*
	 * The grips draw nothing. A corner mark is clutter on a window that is mostly picture, and the
	 * cursor over the corner already says the window can be pulled there. They sit above the board
	 * because the viewport is positioned and comes later in the markup — without that it paints
	 * over the corners and a press that should resize pans the board instead.
	 */





	.trace-header {
		flex: none;
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 14px 10px;
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
		padding: 0 6px;
		font-size: 12px;
		color: var(--ink-secondary);
	}

	.trace-tools-start {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		min-width: 0;
	}

	/* Light the cards a kind of model trouble landed on; the rest of the job stays in place, dim. */
	.trace-highlight {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 3px 9px;
		border: 1px solid var(--line);
		border-radius: 9999px;
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 11.5px;
		cursor: pointer;
	}

	.trace-highlight:hover {
		border-color: var(--line-hover);
		color: var(--ink);
	}

	.trace-highlight.is-feedback[aria-pressed='true'] {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.trace-highlight.is-blamed[aria-pressed='true'] {
		border-color: var(--warn-line);
		background: var(--warn-bg);
		color: var(--warn-text);
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
		display: flex;
		align-items: stretch;
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

	.trace-card.is-focus {
		box-shadow: 0 0 0 2px var(--accent);
	}

	.trace-card {
		transition: opacity 0.15s ease;
	}

	.trace-card.is-dim {
		opacity: 0.32;
	}

	.trace-card.is-lit {
		box-shadow: 0 0 0 2px var(--accent);
	}

	.trace-card.is-lit.is-lit-blamed {
		box-shadow: 0 0 0 2px var(--warn);
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
	.trace-silent,
	.trace-place {
		font-size: 12px;
		line-height: 1.45;
		color: var(--ink-secondary);
		overflow-wrap: anywhere;
	}

	.trace-place,
	.trace-woken,
	.trace-passed,
	.trace-silent {
		font-size: 11px;
		color: var(--muted);
	}

	.trace-wait {
		color: var(--accent);
	}

	.trace-files {
		padding: 0 10px 9px;
	}

	/* How the turn ran, as one line under what it did: model, thinking level, kind, and trouble. */
	.trace-route-line {
		padding: 0 10px 9px;
	}

	.trace-route-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 4px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 11px;
		line-height: 1.3;
		text-align: left;
		cursor: pointer;
		box-sizing: border-box;
		transition: border-color 0.15s ease, background 0.15s ease;
	}

	.trace-route-btn:hover,
	.trace-route-btn.is-open {
		border-color: var(--accent-border);
		background: var(--accent-tint);
	}

	.trace-route-model {
		flex: 0 1 auto;
		max-width: 50%;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 10.5px;
		font-weight: 600;
		color: var(--ink);
	}

	.trace-route-meta {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--muted);
	}

	.trace-route-flags {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		flex: none;
	}

	.trace-route-flag {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-size: 10px;
	}

	.trace-route-flag.is-blamed { color: var(--warn-text); }
	.trace-route-flag.is-feedback { color: var(--accent); }
	.trace-route-flag.is-failed { color: var(--danger-text); }

	.trace-route-caret {
		flex: none;
		color: var(--muted);
		transition: transform 0.15s ease;
	}

	.trace-route-btn.is-open .trace-route-caret {
		transform: rotate(180deg);
	}

	.trace-route {
		display: flex;
		flex-direction: column;
		gap: 7px;
		padding: 8px 10px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
		font-size: 11.5px;
		color: var(--ink-secondary);
	}

	.trace-route-head {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.trace-route-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
	}

	.trace-route-outcome {
		font-size: 10.5px;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 9999px;
		border: 1px solid var(--line);
		background: var(--chip);
		color: var(--muted);
		white-space: nowrap;
	}

	.trace-route-outcome.is-completed {
		background: var(--ok-bg);
		color: var(--ok-text);
		border-color: var(--ok-line);
	}

	.trace-route-outcome.is-failed {
		background: var(--danger-bg);
		color: var(--danger-text);
		border-color: var(--danger-line);
	}

	.trace-route-outcome.is-interrupted {
		background: var(--warn-bg);
		color: var(--warn-text);
		border-color: var(--warn-line);
	}

	.trace-route-outcome.is-live,
	.trace-route-outcome.is-redirected {
		background: var(--accent-tint);
		color: var(--accent);
		border-color: var(--accent-border);
	}

	.trace-route-close {
		margin-left: auto;
		width: 20px;
		height: 20px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.trace-route-close:hover {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.trace-route-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.trace-route-chip {
		max-width: 100%;
		padding: 1px 7px;
		border: 1px solid var(--line);
		border-radius: 9999px;
		background: var(--chip);
		font-size: 10.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.trace-route-chip.is-model {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.trace-route-stats,
	.trace-route-fail,
	.trace-route-why,
	.trace-route-learning {
		margin: 0;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.trace-route-stats {
		font-size: 10.5px;
		color: var(--muted);
	}

	.trace-route-fail {
		color: var(--danger-text);
	}

	.trace-route-learning {
		color: var(--ok-text);
	}

	.trace-route-label {
		margin-right: 6px;
		font-weight: 600;
		color: var(--muted);
	}

	.trace-route-block {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.trace-route-feedback {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.trace-route-note {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		width: 100%;
		padding: 5px 7px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--ink);
		font-size: 11.5px;
		text-align: left;
		cursor: pointer;
		box-sizing: border-box;
	}

	.trace-route-note:hover {
		border-color: var(--accent-border);
	}

	.trace-route-note-body {
		flex: 1;
		min-width: 0;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	.trace-route-note-time {
		flex: none;
		padding-top: 1px;
		font-size: 10px;
		color: var(--muted-light);
	}

	.trace-route-review {
		padding: 6px 8px;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: var(--line-subtle);
	}

	.trace-route-review.is-model {
		border-color: var(--warn-line);
		background: var(--warn-bg);
	}

	.trace-route-review-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 5px;
	}

	.trace-route-fault {
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.trace-route-direction,
	.trace-route-rounds,
	.trace-route-effect {
		font-size: 10.5px;
		color: var(--muted);
	}

	.trace-route-review-reason {
		line-height: 1.45;
		overflow-wrap: anywhere;
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
