<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Attachment, Bot, Provider, SessionSummary, TaskTraceNode, Ticket } from '@real-bot/protocol';
	import { tick, untrack } from 'svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { classifySession, youBotPeer } from '../sidebar/session-groups.ts';
	import { sessionTitle } from '../sidebar/session-title.ts';
	import TraceCard from './TraceCard.svelte';
	import TraceMinimap, { type MinimapTone } from './TraceMinimap.svelte';
	import TraceRound from './TraceRound.svelte';
	import TraceRouteDetail from './TraceRouteDetail.svelte';
	import TraceStepCard from './TraceStepCard.svelte';
	import { anomalousCards, loadTraceSteps, saveTraceSteps } from './trace-steps.ts';
	import { loadTraceMinimap, saveTraceMinimap } from './trace-minimap.ts';
	import { actorFace, actorName, firstPreviewable, latestTurnOfTicket } from './plan-board.ts';
	import { routeCardRow, type RouteLogRow } from './route-log.ts';
	import { TraceCanvas } from './trace-canvas.svelte.ts';
	import type { JobState } from './job-state.svelte.ts';
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
		TRACE_STEP_WIDTH,
		TRACE_ZOOM_MAX,
		TRACE_ZOOM_MIN,
		type RouteHighlight,
		type TraceBox,
		type TraceFocus
	} from './task-trace.ts';

	/**
	 * The job's trace on its canvas, filling whatever it is put in. The job it draws — its trace,
	 * its plan, the ticket and step picked in it — is the `JobState` it is handed, shared with the
	 * rail and the inspector beside it; what is only the picture's — the camera, the folds, the
	 * measured cards, the highlights — is its own.
	 */
	interface Props {
		api: MessengerApi | null;
		job: JobState;
		/** The job asked for from outside; a card it asks for waits for that job to be on screen. */
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
		t: Copy;
		onJump: (sessionId: string, messageId: string) => void;
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
		job,
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
		t,
		onJump,
		onOpenArtifact
	}: Props = $props();

	let notableOnly = $state(false);
	/** The minimap in the corner, until you put it away; per-browser, like the view. */
	let minimapShown = $state(loadTraceMinimap());
	/** The card whose model choice is unfolded under it. One at a time. */
	let openRoute = $state<string | null>(null);
	/** Which kind of model trouble the board is lighting up, if any. */
	let highlight = $state<RouteHighlight | null>(null);
	/** The app's own calls on the board (ADR 0083): drawn unless you hid them, one opened at a time. */
	let showSteps = $state(loadTraceSteps());
	/** The steps that went wrong lit, the rest of the board dimmed. */
	let stepsLit = $state(false);

	const shown = $derived(job.trace ? filterTrace(job.trace, notableOnly) : null);
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
	/** The cards something that went wrong hangs under: lit, their rounds stay open. */
	const anomalous = $derived(shown && showSteps ? anomalousCards(shown.nodes, shown.steps ?? []) : new Set<string>());
	const folded = $derived.by(() => {
		const asked = focus && shown ? focusNode(shown.nodes, focus)?.turn_id ?? null : null;
		const next = defaultFolded(
			rounds,
			(node) =>
				node.turn_id === asked ||
				(job.selectedTicket !== null && node.ticket_id === job.selectedTicket) ||
				highlightOf(node, lighting) === 'lit' ||
				(stepsLit && anomalous.has(node.turn_id))
		);
		for (const [root, shut] of Object.entries(foldChoice)) {
			if (shut) next.add(root);
			else next.delete(root);
		}
		return next;
	});
	const flow = $derived(shown ? traceFlow(shown, new Map(Object.entries(boxes)), { folded, showSteps }) : null);
	const anomalyCount = $derived(flow?.rounds.reduce((sum, round) => sum + round.anomalies, 0) ?? 0);
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
		currentId: () => job.currentId,
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
	 * Keep this job's board as it is, for when it comes back: its tab brought forward again (a tab
	 * that is not the one showing is unmounted), or the job picked again in the switcher. The
	 * trace's camera is only worth keeping once it has been placed.
	 */
	function keepThisBoard(): void {
		if (!job.currentId || !job.boardSession || canvas.fitted !== job.currentId) return;
		keepBoard(job.boardSession, job.currentId, {
			...canvas.leaving(),
			boxes: $state.snapshot(boxes),
			foldChoice: $state.snapshot(foldChoice),
			notableOnly,
			selectedTicket: job.selectedTicket,
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
		const id = job.currentId;
		const token = focusToken;
		const asked = focus;
		const drift = canvas.focusDrifted();
		if (!width || !id || !canvas.viewportEl) return;
		// The board keeps the previous job on screen, where it was, until the next one arrives.
		// Placing before that would put the next job's view on the previous job's picture.
		if (job.trace?.id !== id) return;
		// Nor until the job this message belongs to arrives: that would spend the request on the
		// wrong picture.
		if (asked && taskId && job.trace?.id !== taskId && focusMoveDue(token, canvas.placedFocus)) return;
		// A job whose board you have been on comes back where you left it, not opened afresh. Only a
		// message asking for a card it has not moved for yet moves it on from there.
		if (canvas.fitted !== id) untrack(() => canvas.resume(keptBoard(job.boardSession ?? sessionId, id), id));
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
	/** The step whose panel is open, while the board still draws it. */
	const openStepGroup = $derived(job.openStep ? (flow?.steps.find((row) => row.group.id === job.openStep)?.group ?? null) : null);
	// A step's panel sits beside the board on a wide job, and over the board's bottom as a sheet on a
	// narrow one. Where it lies over the board, the card it is about slides out from under it once.
	$effect(() => {
		const id = job.openStep;
		if (!id) return;
		void tick().then(() => {
			const card = canvas.slots.get(id);
			const viewport = canvas.viewportEl;
			const panel = viewport?.closest('.job-pane')?.querySelector<HTMLElement>('.trace-step-detail');
			if (job.openStep !== id || !card || !panel || !viewport) return;
			const cover = panel.getBoundingClientRect();
			const view = viewport.getBoundingClientRect();
			const overlaps = cover.left < view.right && cover.right > view.left && cover.top < view.bottom && cover.bottom > view.top;
			if (overlaps) canvas.uncover(card, panel);
		});
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
		const id = job.trace?.id ?? null;
		if (id === measuredJob) return;
		measuredJob = id;
		// A job whose board was left starts from what its cards measured then, so the board it comes
		// back to is laid out as it was left, not from the fallback height for a frame.
		boxes = { ...(untrack(() => keptBoard(job.boardSession ?? sessionId, id)?.boxes) ?? {}) };
	});
	const botsById = $derived(new Map(bots.map((bot) => [bot.id, bot])));
	const sessionsById = $derived(new Map(sessions.map((session) => [session.id, session])));
	/** Where the job's own conversation is, for the title row. */
	const tracePlace = $derived(job.trace?.session_id ? placeOf({ session_id: job.trace.session_id }) : null);

	/** How many cards each highlight would light. A chip with nothing to show is not offered. */
	const highlightCounts = $derived(
		job.trace ? routeHighlightCounts(job.trace.nodes) : { feedback: 0, blamed: 0 }
	);
	const lighting = $derived(highlight && highlightCounts[highlight] > 0 ? highlight : null);
	const ticketsById = $derived(new Map((job.detail?.tickets ?? []).map((ticket) => [ticket.id, ticket])));
	/** The ticket a card worked in, as `01`; nothing on your own card and on turns filed under none. */
	function ticketOf(node: TaskTraceNode): Ticket | null {
		return node.ticket_id ? (ticketsById.get(node.ticket_id) ?? null) : null;
	}

	/** Lit when the selected ticket is this card's; dim when a ticket is selected and it is not. */
	function ticketLightOf(node: TaskTraceNode): 'lit' | 'dim' | null {
		if (!job.selectedTicket) return null;
		return node.ticket_id === job.selectedTicket ? 'lit' : 'dim';
	}

	/** A ticket and a model highlight both light cards; showing both at once would say nothing. */
	function selectTicket(id: string | null): void {
		job.selectedTicket = id;
		if (id) highlight = null;
		// What is lit has to be on the board: rounds you folded give way to it.
		if (id) foldChoice = {};
	}

	/**
	 * A ticket seen where its work happened: picked — its rounds lit and open — and the board slides
	 * to the newest card made for it.
	 */
	export async function showTicket(id: string): Promise<void> {
		const latest = latestTurnOfTicket(shown?.nodes ?? [], id);
		selectTicket(id);
		await tick();
		if (latest) slideTo(latest.turn_id);
	}

	/** One card, asked for from beside the board (a mark on the rail): its round opened, the board slid to it. */
	export async function showCard(turnId: string): Promise<void> {
		const root = rounds.find((round) => round.members.some((node) => node.turn_id === turnId))?.root;
		if (root && folded.has(root)) foldChoice = { ...foldChoice, [root]: false };
		await tick();
		slideTo(turnId);
	}

	function slideTo(turnId: string): void {
		const placed = flow?.placements.find((placement) => placement.node.turn_id === turnId);
		if (!placed) return;
		const height = boxes[placed.node.turn_id]?.height ?? 0;
		canvas.centreOn({ x: placed.x + TRACE_CARD_WIDTH / 2, y: placed.y + height / 2 }, true);
	}

	/** Escape, from the job around the board: an unfolded model choice closes first. True when one did. */
	export function closeRoute(): boolean {
		if (!openRoute) return false;
		openRoute = null;
		return true;
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

	function toggleSteps(): void {
		showSteps = !showSteps;
		saveTraceSteps(showSteps);
		if (!showSteps) {
			job.openStep = null;
			stepsLit = false;
		}
	}

	function toggleStepsLit(): void {
		stepsLit = !stepsLit;
		if (stepsLit) {
			highlight = null;
			job.selectedTicket = null;
			foldChoice = {};
		}
	}

	function toggleHighlight(kind: RouteHighlight): void {
		highlight = lighting === kind ? null : kind;
		if (highlight) stepsLit = false;
		if (highlight) job.selectedTicket = null;
		if (highlight) foldChoice = {};
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

	/**
	 * Another job is about to be on screen: keep this one's board as it is, to come back to, and take
	 * the next one up as it was left, or fresh. A refresh of the same plan keeps what you unfolded and lit.
	 */
	export function switchBoard(session: string, next: string | null): void {
		keepThisBoard();
		const kept = keptBoard(session, next);
		openRoute = kept?.openRoute ?? null;
		job.selectedTicket = kept?.selectedTicket ?? null;
		foldChoice = kept?.foldChoice ?? {};
		if (kept) {
			notableOnly = kept.notableOnly;
			highlight = kept.highlight;
		}
	}

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
			job.currentId ?? taskId,
			siblings
		);
	}
</script>

<div class="trace-pane">
	<div class="trace-body">
		<div class="trace-stage">
		{#if job.trace && job.trace.nodes.length > 0}
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
							<Icon name="message" size={12} />
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
							<Icon name="alert-triangle" size={12} />
							<span>{t.routes.filterBlamed}</span>
							<span class="mono">{highlightCounts.blamed}</span>
						</button>
					{/if}
					{#if job.trace.steps?.length}
						<button type="button" class="trace-highlight" aria-pressed={showSteps} title={t.traceSteps.showHint} data-steps-toggle onclick={toggleSteps}>
							<Icon name="trace-step" size={12} />
							<span>{showSteps ? t.traceSteps.hide : t.traceSteps.show}</span>
						</button>
					{/if}
					{#if showSteps && anomalyCount > 0}
						<button type="button" class="trace-highlight is-blamed" aria-pressed={stepsLit} data-steps-lit onclick={toggleStepsLit}>
							<span>{t.traceSteps.anomalies}</span>
							<span class="mono">{anomalyCount}</span>
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
						<Icon name="fit" />
					</button>
					<button
						type="button"
						class="trace-zoom-minimap"
						aria-label={minimapShown ? t.trace.minimapHide : t.trace.minimapShow}
						title={minimapShown ? t.trace.minimapHide : t.trace.minimapShow}
						aria-pressed={minimapShown}
						onclick={toggleMinimap}
					>
						<Icon name="minimap" />
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
				{#if job.loading && !job.trace}
					<p class="trace-empty">{t.trace.loading}</p>
				{:else if job.failed}
					<p class="trace-empty">
						{t.trace.failed}
						<button type="button" onclick={() => void job.load(job.currentId ?? taskId)}>{t.trace.retry}</button>
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
						{#each flow.steps as placement (placement.group.id)}
							<div
								class="trace-slot"
								style="left: {placement.x}px; top: {placement.y}px; width: {TRACE_STEP_WIDTH}px;"
								use:measured={placement.group.id}
							>
								<TraceStepCard
									group={placement.group}
									{t}
									open={job.openStep === placement.group.id}
									lit={stepsLit && placement.group.anomalous}
									dim={(stepsLit && !placement.group.anomalous) || lighting !== null || job.selectedTicket !== null}
									onToggle={() => (job.openStep = job.openStep === placement.group.id ? null : placement.group.id)}
								/>
							</div>
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
									dim={litKind === 'dim' || ticketLight === 'dim' || stepsLit}
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
		{#if minimapShown && flow && flow.rounds.length > 0 && !job.failed && !(job.loading && !job.trace)}
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

	/* The picture: the trace's view, under the tools and the minimap that float over it. */
	.trace-stage {
		position: absolute;
		inset: 0;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	/*
	 * The grips draw nothing. A corner mark is clutter on a window that is mostly picture, and the
	 * cursor over the corner already says the window can be pulled there. They sit above the board
	 * because the viewport is positioned and comes later in the markup — without that it paints
	 * over the corners and a press that should resize pans the board instead.
	 */





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
