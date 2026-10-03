<script lang="ts">
	import {
		type Attachment,
		type Bot,
		type Hold,
		type PlanStatus,
		type Provider,
		type SessionSummary,
		type SessionTaskSummary,
		type TaskDetail,
		type TaskTrace,
		type TaskTraceNode,
		type Ticket,
		type TicketStatus,
		type TicketWithArtifacts
	} from '@real-bot/protocol';
	import { onMount, tick, untrack } from 'svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { classifySession, youBotPeer } from '../sidebar/session-groups.ts';
	import { sessionTitle } from '../sidebar/session-title.ts';
	import { holdLabel } from '../sidebar/holds-list.ts';
	import { formatFullTimestamp, formatMessageTime } from '../chat/chat-view.ts';
	import StopMenu from '../chat/StopMenu.svelte';
	import { planStopItems, type StopChoice } from '../chat/stop-menu.ts';
	import PlanSpecPanel from './PlanSpecPanel.svelte';
	import TicketList from './TicketList.svelte';
	import TraceCard from './TraceCard.svelte';
	import TraceJobSwitcher from './TraceJobSwitcher.svelte';
	import TraceMinimap, { type MinimapTone } from './TraceMinimap.svelte';
	import TraceRound from './TraceRound.svelte';
	import TraceRouteDetail from './TraceRouteDetail.svelte';
	import { loadTraceMinimap, saveTraceMinimap } from './trace-minimap.ts';
	import { loadTraceSide, saveTraceSide, type TraceSide } from './trace-side.ts';
	import {
		actorFace,
		actorName,
		firstPreviewable,
		openTicketCount,
		planTitle,
		ticketArtifactAttachments,
		totalTicketCount
	} from './plan-board.ts';
	import { lastChangeLabel } from './plan-requirements.ts';
	import { routeCardRow, type RouteLogRow } from './route-log.ts';
	import { TraceCanvas } from './trace-canvas.svelte.ts';
	import {
		clampZoom,
		defaultFolded,
		filterTrace,
		focusMoveDue,
		focusNode,
		backOnBoard,
		holdOnScreen,
		highlightOf,
		keepBoard,
		keptBoard,
		routeHighlightCounts,
		traceFlow,
		traceRounds,
		wokenByName,
		TRACE_CARD_WIDTH,
		TRACE_ZOOM_MAX,
		TRACE_ZOOM_MIN,
		type RouteHighlight,
		type TraceBox,
		type TraceFocus
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
		/** A page fills the screen and has its own close button; a pane is closed by its tab. */
		host?: 'pane' | 'page';
		/** Absent in a pane: a pane is closed by its own tab, not by a button inside the content. */
		onClose?: () => void;
		onJump: (sessionId: string, messageId: string) => void;
		/** The job actually on screen, so the address follows the switcher. */
		onTask?: (taskId: string) => void;
		/** Your stops in force; null where the daemon has none, and the board then offers no stop. */
		holds?: readonly Hold[] | null;
		/** A choice from the board's stop menu: this job, or every Bot. Resolves to a refusal to show, or nothing. */
		onStop?: (choice: StopChoice) => Promise<unknown> | void;
		/** Resolves to a refusal to show, or nothing. */
		onLift?: (hold: Hold) => Promise<unknown> | void;
		/** The daemon is out of reach: the stop menu and the lifts show but cannot be pressed. */
		controlsDisabled?: boolean;
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
		onOpenArtifact,
		holds = null,
		onStop,
		onLift,
		controlsDisabled = false
	}: Props = $props();

	let jobs = $state<SessionTaskSummary[]>([]);
	let trace = $state<TaskTrace | null>(null);
	let currentId = $state<string | null>(null);
	let loading = $state(true);
	let failed = $state(false);
	let notableOnly = $state(false);
	let switcherOpen = $state(false);
	/** So the board's Escape listener can put focus back on the trigger once it closes the switcher. */
	let jobSwitcher = $state<TraceJobSwitcher>();
	/**
	 * The plan behind the trace: its spec, revision and tickets. Null until it arrives, and null
	 * for good on a daemon that predates plans — the tree still draws, without the panel and rail.
	 */
	let detail = $state<TaskDetail | null>(null);
	/** The ticket whose cards are lit; the rest of the board dims. One at a time, like a highlight. */
	let selectedTicket = $state<string | null>(null);
	/**
	 * Nothing lies over the board. On a wide host the spec or the tickets open beside it, one at a
	 * time or neither, and the choice outlives the pane. On a narrow one there is no room beside it,
	 * so the spec, the tree and the tickets take turns as tabs, starting on the tree.
	 */
	let side = $state<TraceSide>(loadTraceSide());
	let segment = $state<'spec' | 'trace' | 'tickets'>('trace');
	/** The status the ticket list is narrowed to; the spec's ticket states set it when they open the list. */
	let ticketFilter = $state<TicketStatus | 'all'>('all');
	/** The side panels, so a ticket shown from the spec can be scrolled to. */
	let sideEl = $state<HTMLElement>();
	/** The minimap in the corner, until you put it away; per-browser, like the side panel. */
	let minimapShown = $state(loadTraceMinimap());
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
	/**
	 * Rounds you folded or unfolded yourself, over the board's own choice. Only for this job:
	 * another job starts from its own defaults.
	 */
	let foldChoice = $state<Record<string, boolean>>({});
	const rounds = $derived(shown ? traceRounds(shown.nodes) : []);
	/**
	 * A long job keeps its newest rounds open and folds the rest to a line each. A round stays open
	 * while anything in it is still going, holds the card a message asked for, or holds a card a
	 * ticket or a highlight is lighting — folding those away would hide the answer to the question.
	 */
	const folded = $derived.by(() => {
		const asked = focus && shown ? focusNode(shown.nodes, focus)?.turn_id ?? null : null;
		const next = defaultFolded(
			rounds,
			(node) =>
				node.turn_id === asked ||
				(selectedTicket !== null && node.ticket_id === selectedTicket) ||
				highlightOf(node, lighting) === 'lit'
		);
		for (const [root, shut] of Object.entries(foldChoice)) {
			if (shut) next.add(root);
			else next.delete(root);
		}
		return next;
	});
	const flow = $derived(shown ? traceFlow(shown, new Map(Object.entries(boxes)), { folded }) : null);
	/**
	 * The board inside a fixed viewport: no scrollbars, it is dragged.
	 *
	 * The camera itself — its pan, zoom, gestures and the card-measuring loop — lives in
	 * `TraceCanvas`; see there for what it owns and why. What stays here is what a camera has no
	 * business touching: the fold/unfold-a-round arithmetic (it also decides which round to fold),
	 * the focus-token effect (it also unfolds a round) and the one Escape listener.
	 */
	const canvas = new TraceCanvas(sessionId, taskId, {
		sessionId: () => sessionId,
		flow: () => flow,
		currentId: () => currentId,
		focus: () => focus,
		focusToken: () => focusToken,
		boxes: () => boxes,
		setBox: (id, box) => {
			boxes = { ...boxes, [id]: box };
		}
	});
	/** Aliased so `use:` has a plain reference to bind: the directive cannot take a member expression. */
	const gestures = canvas.gestures;
	const watchViewport = canvas.watchViewport;
	const measured = canvas.measured;

	/**
	 * A new message's request starts from a view that is not yours yet.
	 *
	 * Read when the token changes, not while the board is being centred: writing `userMoved`
	 * there would re-run the effect that just wrote it. A board that was already showing this
	 * job slides; one that is opening lands on the card at once.
	 */
	let seenFocus = untrack(() => focusToken);
	$effect(() => {
		const token = focusToken;
		if (token === seenFocus) return;
		seenFocus = token;
		untrack(() => {
			// A message asking for its card opens the round it is in, even one you folded.
			const asked = focus && shown ? focusNode(shown.nodes, focus) : null;
			const root = asked ? rounds.find((round) => round.members.includes(asked))?.root : undefined;
			if (root && foldChoice[root]) foldChoice = { ...foldChoice, [root]: false };
			canvas.syncFocusToken();
		});
	});

	/**
	 * The conversation the job on screen was listed for. It is the key the board is kept under, and
	 * by the time a different conversation's job is being loaded the prop already names that one.
	 */
	let boardSession: string | null = null;

	/**
	 * Keep this job's board as it is, for when it comes back: its tab brought forward again (a tab
	 * that is not the one showing is unmounted), or the job picked again in the switcher.
	 */
	function keepThisBoard(): void {
		if (!currentId || !boardSession || canvas.fitted !== currentId) return;
		keepBoard(boardSession, currentId, {
			...canvas.leaving(),
			boxes: $state.snapshot(boxes),
			foldChoice: $state.snapshot(foldChoice),
			notableOnly,
			selectedTicket,
			highlight,
			openRoute
		});
	}

	$effect(() => () => {
		keepThisBoard();
		canvas.stopGlide();
	});

	/**
	 * Fold or unfold a round without losing your place.
	 *
	 * The layout changes under a view that stays put: everything under the round moves up or down,
	 * and the spine moves sideways when the round was the widest. So the row you pressed is held
	 * where it was on screen, and a fold that leaves the viewport on empty canvas — the round was
	 * the last one, or ran on below the view — slides the board back onto cards.
	 */
	function toggleRound(root: string): void {
		const shutting = !folded.has(root);
		const was = flow?.rounds.find((round) => round.root === root)?.header ?? null;
		foldChoice = { ...foldChoice, [root]: shutting };
		// Pressing a row is using the view: neither the opening nor a message's card pulls it back now.
		canvas.userMoved = true;
		canvas.openedView = null;
		canvas.stopGlide();
		const now = flow?.rounds.find((round) => round.root === root)?.header ?? null;
		if (!was || !now) return;
		canvas.view = holdOnScreen(canvas.view, was, now);
		const box = canvas.viewportBox();
		if (!shutting || !box.width || !box.height) return;
		const back = backOnBoard(canvas.view, canvas.boardBox(), { x: 12, y: 12, ...canvas.clearBox() });
		if (back.x !== canvas.view.x || back.y !== canvas.view.y) canvas.glideTo(back);
	}

	$effect(() => {
		// A board opens showing all of itself; a message opens on its card. After that the view
		// is yours, until another message asks. The card's first real measurement still counts
		// as that opening, so the move lands on the card you see, not the guess that preceded it.
		const width = flow?.width ?? 0;
		const id = currentId;
		const token = focusToken;
		const asked = focus;
		const drift = canvas.focusDrifted();
		if (!width || !id || !canvas.viewportEl) return;
		// The board keeps the previous job on screen, where it was, until the next one arrives.
		// Placing before that would put the next job's view on the previous job's picture.
		if (trace?.id !== id) return;
		// Nor until the job this message belongs to arrives: that would spend the request on the
		// wrong picture.
		if (asked && taskId && trace?.id !== taskId && focusMoveDue(token, canvas.placedFocus)) return;
		// A job whose board you have been on comes back where you left it, not opened afresh. Only a
		// message asking for a card it has not moved for yet moves it on from there.
		if (canvas.fitted !== id) untrack(() => canvas.resume(keptBoard(boardSession ?? sessionId, id), id));
		if (asked && (focusMoveDue(token, canvas.placedFocus) || (drift && !untrack(() => canvas.userMoved)))) {
			const centred = untrack(() => canvas.focusBoard());
			if (canvas.placedFocus !== token) return;
			if (!centred) {
				canvas.fitted = id;
				untrack(() => canvas.openBoard());
				return;
			}
		}
		if (canvas.fitted === id) {
			// Reading the view here would re-run this on every pan; it is only compared, once per layout.
			untrack(() => {
				if (canvas.stillOpened()) canvas.openBoard();
			});
			return;
		}
		canvas.fitted = id;
		// Centred on the card for this request already, here or by the viewport's first size. A
		// request only spent on an earlier copy of the board moved nothing on this one.
		if (!(asked && canvas.anchored?.token === token)) untrack(() => canvas.openBoard());
	});

	$effect(() => {
		// After every layout, read the cards back. A ResizeObserver only speaks when a size
		// changes, so without this a measurement lost for any reason would never return.
		void flow;
		const frame = requestAnimationFrame(() => {
			for (const [id, element] of canvas.slots) if (element.isConnected) canvas.recordBox(id, element);
		});
		return () => cancelAnimationFrame(frame);
	});
	const byId = $derived(new Map((shown?.nodes ?? []).map((node) => [node.turn_id, node])));
	/** The card this opening was asked to land on, while that request is the one on screen. */
	const focusedTurn = $derived(
		focus && canvas.placedFocus === focusToken && shown ? focusNode(shown.nodes, focus)?.turn_id ?? null : null
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
		// A job whose board was left starts from what its cards measured then, so the board it comes
		// back to is laid out as it was left, not from the fallback height for a frame.
		boxes = { ...(untrack(() => keptBoard(boardSession ?? sessionId, id)?.boxes) ?? {}) };
	});
	const botsById = $derived(new Map(bots.map((bot) => [bot.id, bot])));
	const sessionsById = $derived(new Map(sessions.map((session) => [session.id, session])));

	/** How many cards each highlight would light. A chip with nothing to show is not offered. */
	const highlightCounts = $derived(
		trace ? routeHighlightCounts(trace.nodes) : { feedback: 0, blamed: 0 }
	);
	const lighting = $derived(highlight && highlightCounts[highlight] > 0 ? highlight : null);
	const ticketsById = $derived(new Map((detail?.tickets ?? []).map((ticket) => [ticket.id, ticket])));
	/** An empty ticket list is a quarter of the board saying nothing; it comes with the first ticket. */
	const hasTickets = $derived((detail?.tickets.length ?? 0) > 0);
	/** Tickets asked for on a plan that has none yet leave the board to itself. */
	const sideShown = $derived<TraceSide>(!detail || (side === 'tickets' && !hasTickets) ? null : side);
	const segmentShown = $derived(!detail || (segment === 'tickets' && !hasTickets) ? 'trace' : segment);
	const planStatus = $derived<PlanStatus>(detail?.status ?? (trace?.closed_at ? 'done' : 'active'));
	/** 「上次变化 X 前」 ages while the board is open, so the clock it reads ticks now and then. */
	let nowMs = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (nowMs = Date.now()), 30_000);
		return () => clearInterval(timer);
	});
	const changeLine = $derived(detail ? lastChangeLabel(detail, nowMs, t.plan) : null);
	const heading = $derived(trace ? `${t.trace.title} · ${planTitle(detail ?? trace)}` : t.trace.title);
	/**
	 * Your stops over the job on the board: on it, on a Bot's work in it, on the conversation it
	 * belongs to, on everything. Read from the live list, so a stop made anywhere shows at once.
	 */
	const boardHolds = $derived.by(() => {
		if (!holds || !currentId) return [];
		const home = detail?.session_id ?? trace?.session_id ?? null;
		return holds.filter(
			(hold) =>
				hold.scope === 'global' ||
				(hold.scope === 'plan' && hold.scope_id === currentId) ||
				(hold.scope === 'bot_plan' && hold.scope_id?.endsWith(`:${currentId}`)) ||
				(hold.scope === 'session' && home !== null && hold.scope_id === home)
		);
	});
	const stopItems = $derived(
		holds && currentId && onStop ? planStopItems({ taskId: currentId, title: trace ? planTitle(detail ?? trace) : null, holds, t: t.control }) : []
	);

	/** The stop whose lift was refused, said on its chip until you try again. */
	let liftFailed = $state<string | null>(null);

	async function liftFromBoard(hold: Hold): Promise<void> {
		if (!onLift) return;
		liftFailed = null;
		try {
			if (await onLift(hold)) liftFailed = hold.id;
		} catch {
			liftFailed = hold.id;
		}
	}

	function holdText(hold: Hold): string {
		return holdLabel(hold, { bots: botsById, sessions: sessionsById, roster: { deleted: deletedLabel, archived: deletedLabel }, t: t.control });
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
		// What is lit has to be on the board: rounds you folded give way to it.
		if (id) foldChoice = {};
	}

	/**
	 * Open the spec or the tickets beside the board, or put them away. The viewport narrows or
	 * widens by the panel, so the board keeps its middle where it was — or, while it is still on
	 * the view it opened on, opens again on the new size.
	 */
	async function toggleSide(kind: 'spec' | 'tickets'): Promise<void> {
		const next = sideShown === kind ? null : kind;
		const before = canvas.viewportBox().width;
		const opened = canvas.stillOpened();
		side = next;
		saveTraceSide(next);
		await tick();
		const after = canvas.viewportBox().width;
		if (!before || !after || after === before) return;
		if (opened) {
			canvas.openBoard();
			return;
		}
		canvas.stopGlide();
		canvas.view = { ...canvas.view, x: canvas.view.x + (after - before) / 2 };
	}

	/**
	 * Bring the spec or the tickets up: beside the board on a wide host, as the tab on a narrow one.
	 * Already up, it stays — unlike the toggle, which would put it away.
	 */
	async function revealPanel(kind: 'spec' | 'tickets'): Promise<void> {
		segment = kind;
		if (sideShown !== kind) await toggleSide(kind);
	}

	/**
	 * A line of the spec held to one ticket, or the picked ticket's own strip, shows that ticket: it
	 * is picked — its cards light on the board — and its row is brought into view in the list.
	 */
	async function showTicket(id: string): Promise<void> {
		selectTicket(id);
		const ticket = ticketsById.get(id);
		if (ticketFilter !== 'all' && ticket?.status !== ticketFilter) ticketFilter = 'all';
		await revealPanel('tickets');
		await tick();
		const row = [...(sideEl?.querySelectorAll<HTMLElement>('.ticket-row') ?? [])].find((el) => el.dataset.ticketId === id);
		row?.scrollIntoView?.({ block: 'nearest' });
	}

	/** The spec's ticket states open the list on that status. */
	function showTickets(status: TicketStatus | 'all'): void {
		ticketFilter = status;
		void revealPanel('tickets');
	}

	function toggleMinimap(): void {
		minimapShown = !minimapShown;
		saveTraceMinimap(minimapShown);
	}

	/** A card on the minimap stands out the way it does on the board. */
	function minimapToneOf(node: TaskTraceNode): MinimapTone {
		const litKind = highlightOf(node, lighting);
		const ticketLight = ticketLightOf(node);
		if (litKind === 'lit') return lighting === 'blamed' ? 'blamed' : 'lit';
		if (ticketLight === 'lit') return 'lit';
		if (litKind === 'dim' || ticketLight === 'dim') return 'dim';
		return focusedTurn === node.turn_id ? 'focus' : null;
	}

	function toggleHighlight(kind: RouteHighlight): void {
		highlight = lighting === kind ? null : kind;
		if (highlight) selectedTicket = null;
		if (highlight) foldChoice = {};
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
			reasonCode: t.routes.reasonCode,
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

	function placeOf(node: { session_id: string }): string {
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
		const session = sessionId;
		try {
			const listed = await api.sessionTasks(session);
			if (seq !== loadSeq) return;
			jobs = listed;
			const next = id && listed.some((job) => job.id === id) ? id : (listed[0]?.id ?? null);
			// A refresh of the same plan keeps what you unfolded and lit. Switching plans leaves this
			// one as it is, to come back to, and takes the next one up as it was left, or fresh.
			if (next !== currentId) {
				keepThisBoard();
				const kept = keptBoard(session, next);
				openRoute = kept?.openRoute ?? null;
				selectedTicket = kept?.selectedTicket ?? null;
				segment = 'trace';
				ticketFilter = 'all';
				foldChoice = kept?.foldChoice ?? {};
				if (kept) {
					notableOnly = kept.notableOnly;
					highlight = kept.highlight;
				}
			}
			currentId = next;
			boardSession = session;
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
				jobSwitcher?.focusTrigger();
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

{#snippet specIcon()}
	<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
		<polyline points="14 2 14 8 20 8"></polyline>
		<line x1="16" y1="13" x2="8" y2="13"></line>
		<line x1="16" y1="17" x2="8" y2="17"></line>
	</svg>
{/snippet}

{#snippet ticketsIcon()}
	<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M9 11l3 3L22 4"></path>
		<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
	</svg>
{/snippet}

<div
	class="trace-pane"
	class:is-page={host === 'page'}
	class:has-side={sideShown !== null}
	class:has-segment={segmentShown !== 'trace'}
>
	<div class="trace-top">
		<header class="trace-header">
			<div class="trace-titles">
				<TraceJobSwitcher
					bind:this={jobSwitcher}
					{jobs}
					{currentId}
					{heading}
					{t}
					bind:open={switcherOpen}
					onSelectJob={selectJob}
				/>
				{#if trace}
					<span class="trace-meta">
						<span class="plan-status is-{planStatus}">{t.plan.status[planStatus]}</span>
						{#if detail?.dormant_since}
							<span class="plan-status is-dormant" title={t.plan.dormantHint}>{t.plan.dormant}</span>
						{/if}
						{#if detail?.kind} · {detail.kind}{/if}
						{#if detail && totalTicketCount(detail.ticket_counts) > 0}
							 · {t.plan.ticketCounts(openTicketCount(detail.ticket_counts), totalTicketCount(detail.ticket_counts))}
						{/if}
						{#if trace.session_id} · {placeOf({ session_id: trace.session_id })}{/if}
						 · <span class="mono">{trace.dir}</span>
					</span>
					{#if changeLine}
						<span class="trace-change" title={detail?.last_change ? formatFullTimestamp(detail.last_change.at) : undefined}>{changeLine}</span>
					{/if}
					{#if boardHolds.length > 0}
						<ul class="trace-holds" aria-label={t.control.holdsTitle}>
							{#each boardHolds as hold (hold.id)}
								<li class="trace-hold" title={hold.lift_on_next_user_message ? t.control.liftOnNext : undefined}>
									<svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect></svg>
									<span class="trace-hold-label">{holdText(hold)}</span>
									{#if liftFailed === hold.id}
										<span class="trace-hold-error" role="status">{t.control.failed}</span>
									{:else}
										<span class="trace-hold-time mono">{formatMessageTime(hold.created_at)}</span>
									{/if}
									{#if onLift}
										<button type="button" class="trace-hold-lift" disabled={controlsDisabled} onclick={() => void liftFromBoard(hold)}>{t.control.lift}</button>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				{/if}
			</div>
			<div class="trace-header-end">
				{#if stopItems.length > 0 && onStop}
					<StopMenu items={stopItems} {t} placement="below" size="sm" label={t.control.stop} disabled={controlsDisabled} onPick={(item) => onStop(item.choice)} />
				{/if}
				{#if detail}
					<!-- Only a wide host shows these: there the spec and the tickets open beside the board. -->
					<div class="trace-side-toggles">
						<button
							type="button"
							class="trace-side-toggle"
							aria-pressed={sideShown === 'spec'}
							title={sideShown === 'spec' ? t.plan.hideSpec : t.plan.showSpec}
							onclick={() => void toggleSide('spec')}
						>
							{@render specIcon()}
							<span>{t.plan.segmentSpec}</span>
						</button>
						{#if hasTickets}
							<button
								type="button"
								class="trace-side-toggle"
								aria-pressed={sideShown === 'tickets'}
								title={sideShown === 'tickets' ? t.plan.hideTickets : t.plan.showTickets}
								onclick={() => void toggleSide('tickets')}
							>
								{@render ticketsIcon()}
								<span>{t.plan.segmentTickets}</span>
								<span class="trace-side-count mono">{detail.tickets.length}</span>
							</button>
						{/if}
					</div>
				{/if}
				{#if onClose}
				<button type="button" class="sheet-close" title={t.common.close} onclick={onClose}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="18" y1="6" x2="6" y2="18"></line>
						<line x1="6" y1="6" x2="18" y2="18"></line>
					</svg>
				</button>
				{/if}
			</div>
		</header>
		{#if detail}
			<!-- Only a narrow host shows these: there the spec, the tree and the tickets take turns. -->
			<div class="trace-segments" role="tablist" aria-label={t.trace.title}>
				<button type="button" role="tab" aria-selected={segmentShown === 'spec'} class:is-on={segmentShown === 'spec'} onclick={() => (segment = 'spec')}>{t.plan.segmentSpec}</button>
				<button type="button" role="tab" aria-selected={segmentShown === 'trace'} class:is-on={segmentShown === 'trace'} onclick={() => (segment = 'trace')}>{t.plan.segmentTrace}</button>
				{#if hasTickets}
					<button type="button" role="tab" aria-selected={segmentShown === 'tickets'} class:is-on={segmentShown === 'tickets'} onclick={() => (segment = 'tickets')}>
						{t.plan.segmentTickets}<span class="trace-side-count mono">{detail.tickets.length}</span>
					</button>
				{/if}
			</div>
		{/if}
	</div>
	<div class="trace-body">
		<div class="trace-stage">
		{#if trace && trace.nodes.length > 0}
			<div class="trace-tools">
				<div class="trace-tools-start">
					<label class="trace-filter" title={t.trace.filter}>
						<input type="checkbox" bind:checked={notableOnly} />
						<span class="trace-filter-long">{t.trace.filter}</span>
						<span class="trace-filter-short">{t.trace.filterShort}</span>
					</label>
					{#if highlightCounts.feedback > 0}
						<button
							type="button"
							class="trace-highlight is-feedback"
							aria-pressed={lighting === 'feedback'}
							onclick={() => toggleHighlight('feedback')}
						>
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
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
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
							<span>{t.routes.filterBlamed}</span>
							<span class="mono">{highlightCounts.blamed}</span>
						</button>
					{/if}
				</div>
				<div class="trace-zoom">
					<button
						type="button"
						class="trace-zoom-step"
						aria-label={t.trace.zoomOut}
						title={t.trace.zoomOut}
						disabled={canvas.view.scale <= TRACE_ZOOM_MIN}
						onclick={() => canvas.zoomTo(canvas.view.scale / 1.2)}
					>−</button>
					<button type="button" class="trace-zoom-level" onclick={() => canvas.zoomTo(1)} title={t.trace.zoomReset}>
						{Math.round(canvas.view.scale * 100)}%
					</button>
					<button
						type="button"
						class="trace-zoom-step"
						aria-label={t.trace.zoomIn}
						title={t.trace.zoomIn}
						disabled={canvas.view.scale >= TRACE_ZOOM_MAX}
						onclick={() => canvas.zoomTo(canvas.view.scale * 1.2)}
					>+</button>
					<span class="trace-zoom-rule" aria-hidden="true"></span>
					<button type="button" class="trace-zoom-fit" aria-label={t.trace.zoomFit} title={t.trace.zoomFit} onclick={() => canvas.fitBoard()}>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M3 7V5a2 2 0 0 1 2-2h2"></path>
							<path d="M17 3h2a2 2 0 0 1 2 2v2"></path>
							<path d="M21 17v2a2 2 0 0 1-2 2h-2"></path>
							<path d="M7 21H5a2 2 0 0 1-2-2v-2"></path>
							<rect x="7" y="8" width="10" height="8" rx="1.5"></rect>
						</svg>
					</button>
					<button
						type="button"
						class="trace-zoom-minimap"
						aria-label={minimapShown ? t.trace.minimapHide : t.trace.minimapShow}
						title={minimapShown ? t.trace.minimapHide : t.trace.minimapShow}
						aria-pressed={minimapShown}
						onclick={toggleMinimap}
					>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<rect x="3" y="3" width="18" height="18" rx="2"></rect>
							<rect x="12" y="12" width="6" height="6" rx="1"></rect>
						</svg>
					</button>
				</div>
			</div>
		{/if}

		<!-- A fixed viewport. The board moves under it; the window's corner resizes the viewport. -->
		<div
			class="trace-viewport"
			class:is-dragging={canvas.drag !== null || canvas.pinch !== null}
			role="group"
			aria-label={t.trace.title}
			bind:this={canvas.viewportEl}
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
				{:else if !flow || flow.rounds.length === 0}
					<p class="trace-empty">{t.trace.none}</p>
				{:else}
					<div
						class="trace-flow"
						class:is-moving={canvas.dragged}
						style="width: {flow.width}px; height: {flow.height}px;
							transform: translate({canvas.view.x}px, {canvas.view.y}px) scale({canvas.view.scale});"
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
						{#each flow.rounds as round (round.root)}
							{#if round.header}
								<TraceRound {round} {t} {ticketsById} {nameOf} onToggle={() => toggleRound(round.root)} />
							{/if}
						{/each}
						{#each flow.placements as placement (placement.node.turn_id)}
							{@const node = placement.node}
							{@const litKind = highlightOf(node, lighting)}
							{@const ticketLight = ticketLightOf(node)}
							{@const route = routeOf(node)}
							<div
								class="trace-slot"
								style="left: {placement.x}px; top: {placement.y}px; width: {TRACE_CARD_WIDTH}px;"
								use:measured={node.turn_id}
							>
								<TraceCard
									{node}
									{t}
									here={node.session_id === activeSessionId}
									focused={focusedTurn === node.turn_id}
									lit={litKind === 'lit' || ticketLight === 'lit'}
									litBlamed={litKind === 'lit' && lighting === 'blamed'}
									dim={litKind === 'dim' || ticketLight === 'dim'}
									name={nameOf(node.actor)}
									avatar={avatarOf(node.actor)}
									ticket={ticketOf(node)}
									from={node.woken_by_turn_id && byId.has(node.woken_by_turn_id) ? null : wokenByName(node, byId, nameOf)}
									place={node.session_id !== shown?.session_id ? placeOf(node) : null}
									{route}
									routeOpen={openRoute === node.turn_id}
									onToggleRoute={() => toggleRoute(node)}
									onOpen={() => openCard(node)}
									onOpenArtifacts={() => openNodeArtifacts(node)}
								/>
								{#if openRoute === node.turn_id && route}
									<TraceRouteDetail
										{node}
										{route}
										{t}
										{providers}
										{onJump}
										onClose={() => (openRoute = null)}
										onMarkModel={api ? async (marked) => void (await api!.markTurnModel(node.turn_id, marked)) : undefined}
									/>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
		</div>
		{#if minimapShown && flow && flow.rounds.length > 0 && !failed && !(loading && !trace)}
			<!-- Over the corner, above the zoom: the board's ways around sit together. -->
			<div class="trace-minimap-dock">
				<TraceMinimap
					{flow}
					view={canvas.view}
					viewport={canvas.viewportSize}
					toneOf={minimapToneOf}
					hint={t.trace.minimapHint}
					onCentre={(point, glide) => canvas.centreOn(point, glide)}
					onWheel={canvas.onWheel}
				/>
			</div>
		{/if}
		</div>
		{#if detail}
			<!--
				Both panels stay mounted while the plan is on screen, so an edit half-typed in the spec
				survives a look at the tickets, and the window growing or shrinking across the narrow
				width keeps them. Which one shows is the host width's business, in the styles.
			-->
			<aside class="trace-side" bind:this={sideEl}>
				<div class="trace-side-panel" class:is-side-on={sideShown === 'spec'} class:is-segment-on={segmentShown === 'spec'}>
					<PlanSpecPanel
						{api}
						{detail}
						{t}
						onSaved={(next) => (detail = next)}
						onConflict={reloadPlan}
						{onJump}
						{selectedTicket}
						onShowTicket={(id) => void showTicket(id)}
						onClearTicket={() => selectTicket(null)}
						onShowTickets={showTickets}
					/>
				</div>
				{#if hasTickets}
					<div class="trace-side-panel" class:is-side-on={sideShown === 'tickets'} class:is-segment-on={segmentShown === 'tickets'}>
						<TicketList
							{api}
							{detail}
							{providers}
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
							bind:statusFilter={ticketFilter}
							onShowSpec={() => void revealPanel('spec')}
						/>
					</div>
				{/if}
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

	/*
	 * The title row — and on a narrow host the tabs under it — above the picture, and nothing else:
	 * the spec lives beside the board or in a tab now, not in a block that pushed the board down.
	 * The block clips nothing, so the plan picker drops out over the board instead of being cut off.
	 * It is the pane's colour, as a conversation's header is: in a workbench pane the active tab
	 * joins whatever is right under it, and a darker title row left that tab a lighter chip
	 * floating over it. The line below still sets the title apart from the board.
	 */
	.trace-top {
		position: relative;
		z-index: 10;
		flex: none;
		display: flex;
		flex-direction: column;
		border-bottom: 1px solid var(--line);
		background: var(--pane);
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
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--muted);
		font-size: 11px;
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

	/* Set aside, not a status of its own: quieter than any, a dashed outline with no fill. */
	.plan-status.is-dormant {
		border-style: dashed;
		border-color: var(--line-hover);
		background: transparent;
		color: var(--muted);
	}

	/* Beside the board: the spec, the tickets, or neither. Pressed is open; press again to put it away. */
	.trace-side-toggles {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.trace-side-toggle {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-height: 28px;
		padding: 3px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--ink-secondary);
		font: 600 12px/1.2 var(--font);
		cursor: pointer;
		user-select: none;
		transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
	}

	.trace-side-toggle:hover {
		border-color: var(--line-hover);
		color: var(--ink);
	}

	.trace-side-toggle[aria-pressed='true'] {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.trace-side-toggle:focus-visible,
	.trace-segments button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.trace-side-count {
		padding: 0 5px;
		border-radius: var(--radius-full);
		background: var(--line-subtle);
		color: var(--muted);
		font-size: 10px;
		font-weight: 700;
		line-height: 15px;
	}

	.trace-side-toggle[aria-pressed='true'] .trace-side-count,
	.trace-segments button.is-on .trace-side-count {
		background: var(--accent-tint);
		color: var(--accent);
	}

	/* A narrow host's tabs: a row of their own under the title, each an equal share of it. */
	.trace-segments {
		display: none;
		align-items: center;
		max-width: 480px;
		margin: 0 12px 10px;
		padding: 3px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		gap: 2px;
	}

	.trace-segments button {
		flex: 1 1 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		min-width: 0;
		min-height: 32px;
		padding: 4px 11px;
		border: 0;
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--muted);
		font: 600 13px/1.2 var(--font);
		cursor: pointer;
		transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
		user-select: none;
	}

	.trace-segments button.is-on {
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-xs);
	}

	/* The picture and, beside it, the plan's spec or its tickets — beside, never over it. */
	.trace-stage {
		position: relative;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}

	.trace-side {
		display: none;
		flex: none;
		flex-direction: column;
		width: clamp(260px, 34%, 360px);
		min-height: 0;
		border-left: 1px solid var(--line);
		background: var(--sidebar-bg);
	}

	.trace-pane.has-side .trace-side {
		display: flex;
	}

	.trace-side-panel {
		display: none;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
	}

	.trace-side-panel.is-side-on {
		display: block;
	}

	/*
	 * Narrow by the board's own width, not the window's: a narrow pane is a phone. Below 720px a
	 * panel beside the board would leave it a strip, so the panel gives way to tabs, and a tab other
	 * than the tree takes the whole body.
	 */
	@container trace (max-width: 720px) {
		.trace-side-toggles {
			display: none;
		}

		.trace-segments {
			display: flex;
		}

		.trace-pane.has-side .trace-side {
			display: none;
		}

		.trace-pane.has-segment .trace-side {
			display: flex;
			width: 100%;
			border-left: 0;
		}

		.trace-pane.has-segment .trace-stage {
			display: none;
		}

		.trace-side-panel.is-side-on {
			display: none;
		}

		.trace-side-panel.is-segment-on {
			display: block;
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

	.trace-meta {
		font-size: 12px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* When the job last moved and what moved: freshness, not status, so as quiet as the meta line. */
	.trace-change {
		font-size: 11px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Your stops over this job, under its title: grey, since stopping was your call, not a fault. */
	.trace-holds {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 6px;
		margin: 4px 0 0;
		padding: 0;
		list-style: none;
	}

	.trace-hold {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		max-width: 100%;
		min-height: 22px;
		padding: 0 4px 0 7px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 11px;
	}

	.trace-hold-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The label gives way on a narrow board; the time, a refusal and the lift keep their line. */
	.trace-hold-time,
	.trace-hold-error,
	.trace-hold-lift {
		flex-shrink: 0;
		white-space: nowrap;
	}

	.trace-hold-time {
		color: var(--muted);
	}

	.trace-hold-error {
		color: var(--danger-text);
	}

	.trace-hold-lift {
		padding: 1px 7px;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-full);
		background: var(--pane);
		color: var(--accent);
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
	}

	.trace-hold-lift:hover:not(:disabled) {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
	}

	.trace-hold-lift:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.trace-filter {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 28px;
		padding: 3px 10px 3px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--pane) 92%, transparent);
		backdrop-filter: blur(6px);
		font-size: 12px;
		color: var(--ink-secondary);
		white-space: nowrap;
		cursor: pointer;
	}

	.trace-filter input {
		margin: 0;
	}

	.trace-filter-short {
		display: none;
	}

	/*
	 * A phone's width fits the tools on one row only with the filter said shortly, and with no
	 * zoom steps: two fingers zoom there, and fitting is the button a finger needs.
	 */
	@container trace (max-width: 560px) {
		.trace-filter-long {
			display: none;
		}

		.trace-filter-short {
			display: inline;
		}

		@media (pointer: coarse) {
			.trace-zoom-step {
				display: none;
			}
		}
	}

	.trace-tools-start {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
		min-width: 0;
	}

	/* Each tool is its own pill; the strip they sit on lets the board through, to see and to drag. */
	.trace-filter,
	.trace-highlight,
	.trace-zoom {
		pointer-events: auto;
		box-shadow: var(--shadow-xs);
	}

	/* Light the cards a kind of model trouble landed on; the rest of the job stays in place, dim. */
	.trace-highlight {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-height: 28px;
		padding: 3px 9px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 12px;
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

	/* Floating over the canvas as pills, not a band across its bottom. */
	.trace-tools {
		position: absolute;
		z-index: 1;
		left: 0;
		right: 0;
		bottom: 0;
		padding: 8px 10px;
		pointer-events: none;
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
		align-items: flex-end;
		justify-content: space-between;
		gap: 8px;
	}

	.trace-zoom {
		flex: none;
		display: flex;
		align-items: center;
		gap: 0;
		padding: 1px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--pane) 92%, transparent);
		backdrop-filter: blur(6px);
	}

	.trace-zoom button {
		min-width: 28px;
		height: 26px;
		padding: 0 6px;
		border: 0;
		border-radius: var(--radius-full);
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

	.trace-zoom-level {
		min-width: 48px;
	}

	.trace-zoom-rule {
		flex: none;
		width: 1px;
		height: 14px;
		margin: 0 2px;
		background: var(--line);
	}

	.trace-zoom-fit,
	.trace-zoom-minimap {
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.trace-zoom button.trace-zoom-minimap[aria-pressed='true'] {
		color: var(--accent);
	}

	/*
	 * Over the canvas's bottom-right corner, just above the zoom pill: the tools' own padding, the
	 * pill's 30px and a gap. Not inside the tools strip, whose height is what fitting keeps clear.
	 */
	.trace-minimap-dock {
		position: absolute;
		z-index: 1;
		right: 10px;
		bottom: 46px;
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

	.trace-empty {
		margin: 24px 0;
		font-size: 13px;
		color: var(--muted);
	}

</style>
