<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Attachment, Bot, BuiltinModelRole, Hold, Provider, SessionSummary, TicketStatus, TicketWithArtifacts } from '@real-bot/protocol';
	import { onMount, tick, untrack, type Snippet } from 'svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { holdBack } from '../chat/message-text-pages.ts';
	import type { StopChoice } from '../chat/stop-menu.ts';
	import { trackPointerDrag } from '../pointer-drag.ts';
	import { classifySession, youBotPeer } from '../sidebar/session-groups.ts';
	import { sessionTitle } from '../sidebar/session-title.ts';
	import JobHeader from './JobHeader.svelte';
	import JobInspector, { type InspectorEngine, type InspectorView } from './JobInspector.svelte';
	import TicketList from './TicketList.svelte';
	import TicketRail from './TicketRail.svelte';
	import TraceView from './TraceView.svelte';
	import { JobState } from './job-state.svelte.ts';
	import { engineOffSteps, sessionEngine, sessionsOnEngine } from './job-engine.ts';
	import { attentionCount, planAttention } from './plan-attention.ts';
	import { Playbooks, playbookName } from '../settings/playbooks.svelte.ts';
	import { jobInspectorWidth, jobLayoutMode, jobRailWidth } from './job-layout.ts';
	import { actorName, firstPreviewable, ticketArtifactAttachments } from './plan-board.ts';
	import { TicketEdits } from './ticket-edits.svelte.ts';
	import { divisionOf, ticketLanes, type LaneMark } from './ticket-lanes.ts';
	import { attachSteps } from './trace-steps.ts';
	import { askSpent, loadTraceView, saveTraceView, spendAsk, type TraceViewAsk, type TraceViewKind } from './trace-view.ts';
	import type { TraceFocus } from './task-trace.ts';

	/**
	 * A job, whole, in one place (ADR 0086): its title row, then its tickets in a rail, its trace in
	 * the middle and what is picked in it beside — the ticket, a step of the app's own, or the job's
	 * spec when nothing is. One job and one pick for all three, so switching the job switches every
	 * part and picking a ticket lights it everywhere.
	 *
	 * It lays out by its own width, not the window's. Narrow — a phone, a narrow pane — the three are
	 * one at a time behind the switch in the title row, and a ticket or a step picked comes up as a
	 * sheet over the bottom. The parts not on screen are hidden where they are, at full size, so the
	 * trace keeps its camera while you are away from it.
	 */
	interface Props {
		api: MessengerApi | null;
		/** The job to open on. Null asks the session for its most recent one. */
		taskId: string | null;
		/** A line of yours filed under no job, drawn as a flow of its own (ADR 0083): no tickets, no spec. */
		line?: string | null;
		/** A built-in call's model and prompts, changed in a step's panel by its 「改这个调用」. */
		callEditor?: Snippet<[BuiltinModelRole]>;
		/** The message whose card to centre. A new `focusToken` is a new request to move. */
		focus?: TraceFocus | null;
		focusToken?: number;
		sessionId: string;
		/** The conversation on screen, so the node that lives there reads as the one you are on. */
		activeSessionId: string;
		sessions: readonly SessionSummary[];
		bots: readonly Bot[];
		/** Names the endpoint a turn ran on, and offers a ticket's models. */
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
		/**
		 * What a tab saved before the job was one tab asks to open on: the board opened out, or the
		 * spec beside the trace. Left out, the job opens as it was left.
		 */
		view?: TraceViewKind | null;
		/** What a tab was asked to show — a ticket, a column — and which request. A new `askToken` is a new request. */
		ask?: TraceViewAsk | null;
		askToken?: number;
		/** Your stops in force; null where the daemon has none, and the board then offers no stop. */
		holds?: readonly Hold[] | null;
		onStop?: (choice: StopChoice) => Promise<unknown> | void;
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
		/** Roles, on the engine the job runs under. Left out, the job names its engine without a way there. */
		onOpenRoles?: (playbookId: string) => void;
		/** This job's task map (ADR 0097), opened beside the flow; absent where no workbench holds it. */
		onOpenMap?: (taskId: string) => void;
		/** A width to lay out by instead of measuring one: stories and tests. */
		width?: number;
	}

	let {
		api,
		taskId,
		line = null,
		callEditor,
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
		reloadToken,
		host = 'pane',
		onClose,
		onJump,
		onTask,
		view = null,
		ask = null,
		askToken = 0,
		holds = null,
		onStop,
		onLift,
		controlsDisabled = false,
		onOpenArtifact,
		onOpenRoles,
		onOpenMap,
		width: fixedWidth
	}: Props = $props();

	let traceView = $state<TraceView>();
	let header = $state<JobHeader>();
	let switcherOpen = $state(false);

	const job = new JobState({
		api: () => api,
		sessionId: () => sessionId,
		taskId: () => taskId,
		line: () => line,
		onTask: (id) => onTask?.(id),
		onSwitch: (session, next) => {
			traceView?.switchBoard(session, next);
			statusFilter = 'all';
			specHeld = false;
		}
	});

	/** Every edit to the job's tickets, from the board opened out or the inspector, through one queue. */
	const edits = new TicketEdits({
		api: () => api,
		detail: () => job.detail!,
		t: () => t,
		providers: () => providers,
		onPatched: (ticket) => job.ticketPatched(ticket),
		onConflict: () => job.reloadPlan()
	});
	$effect(() => {
		if (job.detail) edits.loadModels();
	});

	/** Its own width once measured; before that a page is narrow and a pane is wide. */
	let measuredWidth = $state(0);
	const width = $derived(fixedWidth ?? measuredWidth);
	const mode = $derived(jobLayoutMode(width, host));
	const narrow = $derived(mode === 'narrow');
	const medium = $derived(mode === 'medium');
	/** Medium: the spec over the trace's right edge, asked for from the title row's 要点. */
	let specOpen = $state(false);
	/** Narrow, the part on screen: the tickets, the trace or the spec. Remembered per browser. */
	let segment = $state<TraceViewKind>(untrack(() => view ?? (focus ? 'trace' : loadTraceView())));
	/** The board of five columns in place of the rail and the trace. */
	let boardOpen = $state(untrack(() => view === 'board'));
	/** The spec held to the picked ticket, from its 「在要点里看」. */
	let specHeld = $state(false);
	/** Wide: the inspector over the whole tab, for reading or editing the spec at length. */
	let inspectorExpanded = $state(false);
	/** The board's column the spec asked to bring into view, and the rail's filter; 'all' for none. */
	let statusFilter = $state<TicketStatus | 'all'>('all');

	const hasTickets = $derived((job.detail?.tickets.length ?? 0) > 0);
	/** Who does what in the job: each Bot's tickets as written down beside the turns it ran. */
	const division = $derived(job.detail && job.trace ? divisionOf(job.trace.nodes, job.detail.tickets) : []);
	/** What in the plan needs you, said in the title row too. */
	const attention = $derived(job.detail ? attentionCount(planAttention(job.detail)) : 0);

	/** The engines, read once per daemon, so the job can say which one its own calls run under. */
	const playbooks = new Playbooks(() => api);
	let playbooksFor: MessengerApi | null = null;
	$effect(() => {
		const client = api;
		if (!client || client === playbooksFor) return;
		playbooksFor = client;
		untrack(() => void playbooks.load());
	});
	const engine = $derived.by<InspectorEngine | null>(() => {
		if (!job.detail || !playbooks.list) return null;
		const known = (id: string) => Boolean(playbooks.find(id));
		const { id, why } = sessionEngine(sessions, job.detail.session_id, playbooks.defaultId, known);
		const item = playbooks.find(id);
		return {
			name: playbookName(item, t.playbooks.builtin) || id,
			why,
			off: engineOffSteps(item).map((step) => t.playbooks.steps[step]?.name ?? step),
			sessions: sessionsOnEngine(sessions, id, playbooks.defaultId, known),
			onOpen: onOpenRoles ? () => onOpenRoles(id) : undefined
		};
	});
	const lanes = $derived(job.detail && job.trace ? ticketLanes(job.trace.nodes, job.detail.tickets) : null);
	const stepGroup = $derived.by(() => {
		const id = job.openStep;
		const trace = job.trace;
		if (!id || !trace?.steps?.length) return null;
		return attachSteps(trace.nodes, trace.steps).groups.find((group) => group.id === id) ?? null;
	});
	const ticketPicked = $derived(job.selectedTicket !== null && Boolean(job.detail?.tickets.some((row) => row.id === job.selectedTicket)));
	/**
	 * What the inspector shows. Wide: a step, else the ticket, else the spec. Medium the same, except
	 * that with nothing picked the spec waits to be asked for. Narrow, the part on screen decides: a
	 * step over the trace, the ticket over the rail, and the spec as the spec's part — held to the
	 * picked ticket when its 「在要点里看」 brought you there.
	 */
	const inspectorView = $derived.by<InspectorView | null>(() => {
		if (narrow) {
			if (segment === 'trace') return stepGroup ? 'step' : null;
			if (segment === 'board') return ticketPicked ? 'ticket' : null;
			return job.detail ? 'spec' : null;
		}
		if (stepGroup) return 'step';
		if (medium) {
			if (ticketPicked && !specHeld) return 'ticket';
			return job.detail && (specOpen || specHeld) ? 'spec' : null;
		}
		if (ticketPicked && !specHeld) return 'ticket';
		return job.detail ? 'spec' : null;
	});
	/** Narrow, a step or a ticket comes up over the bottom of the part it was picked in. */
	const sheet = $derived(narrow && segment !== 'spec' && inspectorView !== null);
	const segmentShown = $derived<TraceViewKind>(!job.detail || (segment === 'board' && !hasTickets) ? 'trace' : segment);

	const railWidthStore = jobRailWidth();
	const inspectorWidthStore = jobInspectorWidth();
	let railPreferred = $state(railWidthStore.load());
	let inspectorPreferred = $state(inspectorWidthStore.load());
	const railWidth = $derived(railWidthStore.clamp(railPreferred, width || Number.POSITIVE_INFINITY));
	const inspectorWidth = $derived(inspectorWidthStore.clamp(inspectorPreferred, width || Number.POSITIVE_INFINITY));
	/** Which edge is in hand: it keeps its tint while the pointer runs off it. */
	let resizing = $state<'rail' | 'inspector' | null>(null);

	function startResize(event: PointerEvent, which: 'rail' | 'inspector'): void {
		event.preventDefault();
		resizing = which;
		const originX = event.clientX;
		const originW = which === 'rail' ? railWidth : inspectorWidth;
		trackPointerDrag(window, {
			move: (move) => {
				const delta = move.clientX - originX;
				if (which === 'rail') railPreferred = railWidthStore.clamp(originW + delta, width);
				else inspectorPreferred = inspectorWidthStore.clamp(originW - delta, width);
			},
			end: () => {
				resizing = null;
				if (which === 'rail') railWidthStore.save(railPreferred);
				else inspectorWidthStore.save(inspectorPreferred);
			},
			cancel: false
		});
	}

	/** Medium, the title row's 要点: the spec over the trace (held to the picked ticket), or put away. */
	function toggleSpec(): void {
		if (inspectorView === 'spec') {
			specOpen = false;
			specHeld = false;
			return;
		}
		job.openStep = null;
		if (ticketPicked) specHeld = true;
		else specOpen = true;
	}

	function chooseSegment(next: TraceViewKind): void {
		segment = next;
		saveTraceView(next);
	}

	const botsById = $derived(new Map(bots.map((bot) => [bot.id, bot])));
	const sessionsById = $derived(new Map(sessions.map((session) => [session.id, session])));

	function nameOf(actor: string): string {
		return actorName(actor, botsById, youLabel, deletedLabel);
	}

	/** Where the job's own conversation is, for the title row, said as the trace's cards say it. */
	const place = $derived.by(() => {
		const id = job.trace?.session_id;
		if (!id) return null;
		const session = sessionsById.get(id);
		if (!session) return t.trace.sessionUnknown;
		if (session.kind === 'group') return t.trace.sessionGroup(session.name ?? session.id);
		if (classifySession(session) === 'you-bot') {
			const peer = youBotPeer(session);
			return t.trace.sessionDirect(peer ? nameOf(peer) : deletedLabel);
		}
		return t.trace.sessionDirect(sessionTitle(session, botsById, { deleted: deletedLabel, archived: deletedLabel, fileDrop: t.sidebar.fileDrop, projectUntitled: t.project.untitled }));
	});

	function selectJob(id: string): void {
		switcherOpen = false;
		job.selectJob(id);
	}

	/** A ticket picked on the rail, or put down. */
	function pickTicket(id: string | null): void {
		job.selectedTicket = id;
		specHeld = false;
		inspectorExpanded = false;
	}

	/** A card on a lane: its ticket picked, and the trace slides to it. */
	function pickMark(ticketId: string | null, mark: LaneMark): void {
		if (ticketId) pickTicket(ticketId);
		if (narrow) chooseSegment('trace');
		void tick().then(() => traceView?.showCard(mark.turnId));
	}

	/** A ticket's work on the trace: the trace on screen, the ticket lit, its newest card in view. */
	function showInTrace(id: string): void {
		boardOpen = false;
		inspectorExpanded = false;
		if (narrow) chooseSegment('trace');
		void tick().then(() => traceView?.showTicket(id));
	}

	/** The title row's 「需要你看」: the whole job's plan in the inspector, where what needs you is said. */
	function showWholeJob(): void {
		job.openStep = null;
		pickTicket(null);
		if (narrow) chooseSegment('spec');
		if (medium) specOpen = true;
	}

	/** A ticket named in the spec: picked, and the inspector turns to it. */
	function showTicketFromSpec(id: string): void {
		pickTicket(id);
		if (narrow) chooseSegment('board');
	}

	/** The spec's ticket states: the rail (or the board, if it is open) shows that status alone. */
	function showTickets(status: TicketStatus | 'all'): void {
		statusFilter = status;
		inspectorExpanded = false;
		if (narrow) chooseSegment('board');
	}

	function openTicketArtifacts(ticket: TicketWithArtifacts): void {
		const siblings = ticketArtifactAttachments(ticket);
		const target = firstPreviewable(siblings);
		if (!target || !onOpenArtifact) return;
		onOpenArtifact(target.workspace_relpath, target, target.message_id, true, job.currentId ?? taskId, siblings);
	}

	/** Narrow, a ticket's 「在要点里看」 turns to the spec's part, held to the ticket. */
	$effect(() => {
		if (!specHeld) return;
		untrack(() => {
			if (narrow && segment !== 'spec') chooseSegment('spec');
		});
	});

	/** On a phone Back puts a sheet away — a step's, a ticket's — before it leaves the job. */
	$effect(() => {
		if (host !== 'page' || !sheet) return;
		return holdBack(() => {
			if (inspectorView === 'step') job.openStep = null;
			else job.selectedTicket = null;
		});
	});

	/** A message asking for its card brings the trace up, narrow; not remembered as your choice. */
	let seenFocus = untrack(() => focusToken);
	$effect(() => {
		const token = focusToken;
		if (token === seenFocus) return;
		seenFocus = token;
		untrack(() => {
			if (focus) {
				segment = 'trace';
				boardOpen = false;
				inspectorExpanded = false;
			}
		});
	});

	/**
	 * What a tab was asked to show, once its job is the one on screen. A request is acted on once: the
	 * tab brought forward again still carries it, and acting on it again would take back whatever you
	 * picked since.
	 */
	let pendingAsk = $state<TraceViewAsk | null>(null);
	let seenAsk = 0;
	$effect(() => {
		const token = askToken;
		if (!token || token === seenAsk) return;
		seenAsk = token;
		untrack(() => {
			const key = view ?? 'trace';
			if (askSpent(sessionId, key, token)) return;
			spendAsk(sessionId, key, token);
			pendingAsk = ask;
		});
	});
	$effect(() => {
		const wanted = pendingAsk;
		if (!wanted || job.loading || !job.detail || (taskId !== null && job.currentId !== taskId)) return;
		pendingAsk = null;
		untrack(() => {
			if (wanted.column) statusFilter = wanted.column;
			if (!wanted.ticket || !job.detail?.tickets.some((row) => row.id === wanted.ticket)) return;
			pickTicket(wanted.ticket);
			if (view === 'spec') specHeld = true;
		});
	});

	onMount(() => {
		void job.load(taskId);
		/**
		 * One Escape, one step out: the switcher, then an unfolded model choice or a step's panel, then
		 * a picked ticket.
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
				header?.focusSwitcher();
				return;
			}
			// A model picker opened from a step's panel, a phone's sheet, or a prompt's editor over the window, answers its own Escape.
			if ((event.target as Element | null)?.closest?.('.mp-panel, .mp-sheet-layer, .bottom-sheet-layer') || document.querySelector('.prompt-editor-backdrop')) return;
			const closedRoute = traceView?.closeRoute() ?? false;
			if (closedRoute || job.openStep) {
				event.preventDefault();
				event.stopImmediatePropagation();
				job.openStep = null;
				return;
			}
			if (!job.selectedTicket) {
				// Medium, the spec over the trace is the last thing Escape puts away.
				if (!medium || (!specOpen && !specHeld)) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				specOpen = false;
				specHeld = false;
				return;
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			job.selectedTicket = null;
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
		const timer = setTimeout(() => void job.load(job.currentId ?? taskId), 150);
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
		if (next && next !== untrack(() => job.currentId)) untrack(() => void job.load(next));
	});

	/** A different conversation shows that conversation's job. */
	let loadedFor = untrack(() => sessionId);
	$effect(() => {
		const next = sessionId;
		if (next === loadedFor) return;
		loadedFor = next;
		untrack(() => void job.load(null));
	});
</script>

{#snippet specIcon()}
	<Icon name="file-text" size={12} />
{/snippet}

{#snippet traceIcon()}
	<Icon name="hierarchy" size={12} />
{/snippet}

{#snippet tasksIcon()}
	<Icon name="list" size={12} />
{/snippet}

<div
	class="job-pane"
	class:is-page={host === 'page'}
	class:is-narrow={narrow}
	class:is-medium={medium}
	class:is-resizing={resizing !== null}
	class:has-rail={hasTickets && lanes !== null}
	class:has-inspector={inspectorView !== null}
	class:has-sheet={sheet}
	class:board-open={boardOpen && job.detail !== null}
	class:inspector-wide={inspectorExpanded && !narrow}
	data-view={narrow ? segmentShown : 'all'}
	style:--job-rail-width="{railWidth}px"
	style:--job-inspector-width="{inspectorWidth}px"
	bind:clientWidth={measuredWidth}
>
	<JobHeader
		bind:this={header}
		{job}
		{line}
		{t}
		{place}
		{bots}
		{sessions}
		{deletedLabel}
		bind:switcherOpen
		onSelectJob={selectJob}
		{holds}
		{onStop}
		{onLift}
		{controlsDisabled}
		{onClose}
	>
		{#snippet end()}
			{#if medium && job.detail}
				<button type="button" class="job-chip is-toggle" aria-pressed={inspectorView === 'spec'} onclick={toggleSpec}>{t.plan.segmentSpec}</button>
			{/if}
			{#if attention > 0}
				<button type="button" class="job-chip is-attention" onclick={showWholeJob}>{t.plan.job.attention(attention)}</button>
			{/if}
			{#if engine}
				<button type="button" class="job-chip" title={t.plan.job.engine.title} disabled={!engine.onOpen} onclick={() => engine?.onOpen?.()}>{t.plan.job.engine.chip(engine.name)}</button>
			{/if}
			{#if onOpenMap && job.currentId && !line}
				{@const mapOf = job.currentId}
				<button type="button" class="job-chip" title={t.taskmap.openLong} onclick={() => onOpenMap(mapOf)}>{t.taskmap.open}</button>
			{/if}
		{/snippet}
		{#snippet middle()}
			{#if job.detail && narrow}
				<!-- Narrow, the job's three parts one at a time; on a narrow host the switch takes a row of its own. -->
				<div class="trace-views" role="tablist" aria-label={t.plan.views}>
					{#if hasTickets}
						<button type="button" role="tab" class="trace-view-tab" aria-selected={segmentShown === 'board'} onclick={() => chooseSegment('board')}>
							{@render tasksIcon()}
							<span>{t.plan.job.segmentTasks}</span>
							<span class="trace-view-count mono">{job.detail.tickets.length}</span>
						</button>
					{/if}
					<button type="button" role="tab" class="trace-view-tab" aria-selected={segmentShown === 'trace'} onclick={() => chooseSegment('trace')}>
						{@render traceIcon()}
						<span>{t.plan.segmentTrace}</span>
					</button>
					<button type="button" role="tab" class="trace-view-tab" aria-selected={segmentShown === 'spec'} onclick={() => chooseSegment('spec')}>
						{@render specIcon()}
						<span>{t.plan.segmentSpec}</span>
					</button>
				</div>
			{/if}
		{/snippet}
	</JobHeader>
	<div class="job-body">
		{#if hasTickets && lanes && job.detail}
			<section class="job-part job-rail" class:is-on={segmentShown === 'board'}>
				<TicketRail
					detail={job.detail}
					{lanes}
					{bots}
					{youLabel}
					{deletedLabel}
					{t}
					selectedId={job.selectedTicket}
					{statusFilter}
					onPick={pickTicket}
					onPickMark={pickMark}
					onClearFilter={() => (statusFilter = 'all')}
					onExpand={() => (boardOpen = true)}
				/>
				{#if !narrow}
					<button type="button" class="split-handle job-split is-rail" class:is-active={resizing === 'rail'} aria-label={t.plan.job.resizeRail} onpointerdown={(event) => startResize(event, 'rail')}></button>
				{/if}
			</section>
		{/if}
		<section class="job-part job-flow" class:is-on={segmentShown === 'trace'}>
			<TraceView
				bind:this={traceView}
				{api}
				{job}
				{taskId}
				{focus}
				{focusToken}
				{sessionId}
				{activeSessionId}
				{sessions}
				{bots}
				{providers}
				{youLabel}
				{deletedLabel}
				{t}
				{onJump}
				{onOpenArtifact}
			/>
		</section>
		{#if boardOpen && job.detail}
			<section class="job-part job-board" class:is-on={segmentShown === 'board'}>
				<div class="job-board-head">
					<button type="button" class="job-board-close" onclick={() => (boardOpen = false)}>{t.plan.job.collapseBoard}</button>
				</div>
				<div class="job-board-body">
					<TicketList
						{api}
						detail={job.detail}
						{providers}
						nodes={job.trace?.nodes ?? []}
						{bots}
						{youLabel}
						{deletedLabel}
						{t}
						selectedId={job.selectedTicket}
						onSelect={pickTicket}
						{onJump}
						onOpenArtifacts={openTicketArtifacts}
						onPatched={(ticket) => job.ticketPatched(ticket)}
						onConflict={() => job.reloadPlan()}
						bind:statusFilter
						onShowSpec={() => (specHeld = true)}
						onShowInTrace={showInTrace}
						{edits}
						details={false}
					/>
				</div>
			</section>
		{/if}
		{#if inspectorView !== null}
			<aside class="job-part job-inspector" class:is-on={segmentShown === 'spec'} class:is-sheet={sheet} aria-label={t.plan.job.inspector}>
				{#if !narrow}
					<button type="button" class="split-handle job-split is-inspector" class:is-active={resizing === 'inspector'} aria-label={t.plan.job.resizeInspector} onpointerdown={(event) => startResize(event, 'inspector')}></button>
				{/if}
				<JobInspector
					{api}
					{job}
					{edits}
					view={inspectorView}
					{stepGroup}
					nodes={job.trace?.nodes ?? []}
					{bots}
					{youLabel}
					{deletedLabel}
					{t}
					bind:specHeld
					bind:expanded={inspectorExpanded}
					canExpand={!narrow}
					onClose={medium ? () => { specOpen = false; specHeld = false; } : undefined}
					{callEditor}
					{onJump}
					onOpenArtifacts={openTicketArtifacts}
					onShowInTrace={showInTrace}
					onShowTickets={showTickets}
					onShowTicket={showTicketFromSpec}
					{lanes}
					{division}
					{engine}
				/>
			</aside>
		{/if}
	</div>
</div>

<style>
	/* Fills its host. Where it sits and what it sits on are the host's business. */
	.job-pane {
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

	.job-pane.is-resizing {
		cursor: col-resize;
		user-select: none;
	}

	/*
	 * Wide: the rail, the trace and the inspector side by side, each its own scroller. A part that
	 * has nothing to show takes no room: a job with no tickets has no rail, a line's own board has
	 * no inspector until a step is opened.
	 */
	.job-body {
		position: relative;
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: var(--job-rail-width) minmax(0, 1fr) var(--job-inspector-width);
		grid-template-rows: minmax(0, 1fr);
		grid-template-areas: 'rail flow inspector';
	}

	.job-pane:not(.has-rail) .job-body {
		grid-template-columns: 0 minmax(0, 1fr) var(--job-inspector-width);
	}

	.job-pane:not(.has-inspector) .job-body {
		grid-template-columns: var(--job-rail-width) minmax(0, 1fr) 0;
	}

	.job-pane:not(.has-rail):not(.has-inspector) .job-body {
		grid-template-columns: 0 minmax(0, 1fr) 0;
	}

	.job-part {
		position: relative;
		min-width: 0;
		min-height: 0;
	}

	.job-rail {
		grid-area: rail;
		border-right: 1px solid var(--line);
	}

	.job-flow {
		grid-area: flow;
	}

	/* The board opened out: in place of the rail and the trace, which stay where they are underneath. */
	.job-board {
		grid-column: 1 / 3;
		grid-row: 1;
		z-index: 2;
		display: flex;
		flex-direction: column;
		background: var(--pane);
		border-right: 1px solid var(--line);
	}

	.job-board-head {
		flex: none;
		display: flex;
		justify-content: flex-end;
		padding: 6px 10px 0;
	}

	.job-board-close {
		padding: 3px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--pane);
		color: var(--ink-secondary);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}

	.job-board-close:hover {
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.job-board-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.job-pane.board-open:not(.is-narrow) .job-rail,
	.job-pane.board-open:not(.is-narrow) .job-flow {
		visibility: hidden;
		pointer-events: none;
	}

	.job-inspector {
		grid-area: inspector;
		border-left: 1px solid var(--line);
		background: var(--pane);
	}

	/* Widened: the inspector over the whole tab, the rail and the trace kept where they are beneath. */
	.job-pane.inspector-wide .job-inspector {
		grid-column: 1 / -1;
		z-index: 3;
		border-left: 0;
	}

	.job-pane.inspector-wide .job-rail,
	.job-pane.inspector-wide .job-flow,
	.job-pane.inspector-wide .job-board {
		visibility: hidden;
		pointer-events: none;
	}

	/* The grip (`.split-handle`) lies over the border the column already draws on that edge. */
	.job-split {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 1px;
		background: transparent;
	}

	/* Past the padding edge, an absolute child's zero, by the border's one pixel. */
	.job-split.is-rail {
		right: -1px;
	}

	.job-split.is-inspector {
		left: -1px;
	}

	/*
	 * Medium: the rail and the trace side by side; the inspector lies over the trace's right edge,
	 * above the tools' row, while something is picked or the spec was asked for. The minimap moves
	 * to its left, as it once did for a step's panel.
	 */
	.job-pane.is-medium .job-body {
		grid-template-columns: var(--job-rail-width) minmax(0, 1fr);
		grid-template-areas: 'rail flow';
	}

	.job-pane.is-medium:not(.has-rail) .job-body {
		grid-template-columns: 0 minmax(0, 1fr);
	}

	.job-pane.is-medium .job-inspector {
		grid-area: auto;
		position: absolute;
		z-index: 5;
		top: 10px;
		right: 10px;
		bottom: 56px;
		width: min(var(--job-inspector-width), calc(100% - 40px));
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
	}

	.job-pane.is-medium.inspector-wide .job-inspector {
		inset: 0;
		width: auto;
		border: 0;
		border-radius: 0;
		box-shadow: none;
	}

	.job-pane.is-medium.has-inspector :global(.trace-minimap-dock) {
		right: calc(min(var(--job-inspector-width), 100% - 40px) + 20px);
	}

	/*
	 * Narrow: one part at a time, each with the whole body, the others hidden where they are. A
	 * ticket or a step picked comes up as a sheet over the bottom of the part it was picked in.
	 */
	.job-pane.is-narrow .job-body {
		display: block;
	}

	.job-pane.is-narrow .job-part {
		position: absolute;
		inset: 0;
		border: 0;
	}

	.job-pane.is-narrow .job-part:not(.is-on) {
		visibility: hidden;
		pointer-events: none;
	}

	.job-pane.is-narrow .job-inspector.is-sheet {
		top: auto;
		height: 62%;
		z-index: 5;
		visibility: visible;
		pointer-events: auto;
		overflow: hidden;
		border-top: 1px solid var(--line);
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
		box-shadow: var(--shadow-lg);
	}

	/* What the title row says of the job beside its stop menu: what needs you, and its engine. */
	.job-chip {
		padding: 2px 9px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--ink-secondary);
		font: inherit;
		font-size: 11.5px;
		white-space: nowrap;
		cursor: pointer;
	}

	.job-chip:hover:not(:disabled) {
		border-color: var(--line-hover);
		color: var(--ink);
	}

	.job-chip:disabled {
		cursor: default;
	}

	.job-chip.is-toggle[aria-pressed='true'] {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.job-chip.is-attention {
		border-color: var(--warn-line);
		background: var(--warn-bg);
		color: var(--warn-text);
		font-weight: 600;
	}

	/*
	 * The three parts of the job: one segmented switch, the part on screen raised out of the track.
	 * Teal is reserved for what you act on, so the raised tab is ink on the pane, not teal. It shows
	 * only narrow, on a row of its own under the title, each part an equal share of it.
	 */
	.trace-views {
		order: 3;
		flex: 1 0 100%;
		display: flex;
		max-width: 480px;
		align-items: center;
		gap: 2px;
		padding: 3px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
	}

	.trace-view-tab {
		flex: 1 1 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		min-width: 0;
		min-height: 32px;
		padding: 3px 12px;
		border: 0;
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--muted);
		font: 600 13px/1.2 var(--font);
		cursor: pointer;
		user-select: none;
		transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
	}

	.trace-view-tab:hover {
		color: var(--ink);
	}

	.trace-view-tab[aria-selected='true'] {
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-xs);
	}

	.trace-view-tab:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.trace-view-count {
		padding: 0 5px;
		border-radius: var(--radius-full);
		background: var(--line-subtle);
		color: var(--muted);
		font-size: 10px;
		font-weight: 700;
		line-height: 15px;
	}

	.trace-view-tab[aria-selected='true'] .trace-view-count {
		background: var(--accent-tint);
		color: var(--accent);
	}
</style>
