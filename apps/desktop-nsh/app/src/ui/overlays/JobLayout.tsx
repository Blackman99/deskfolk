/**
 * A job, whole, in one place (`overlays/JobLayout.svelte`, ADR 0086): its title row, then its
 * tickets in a rail, its trace in the middle and what is picked in it beside: the ticket, a step of
 * the app's own, or the job's spec when nothing is. One job and one pick for all three, so
 * switching the job switches every part and picking a ticket lights it everywhere.
 *
 * It lays out by its own width, not the window's. Narrow (a phone, a narrow pane) the three are one
 * at a time behind the switch in the title row, and a ticket or a step picked comes up as a sheet
 * over the bottom. Medium: the rail and the trace side by side, the inspector over the trace's right
 * edge. Wide: all three across. The parts not on screen are hidden where they are, at full size, so
 * the trace keeps its camera while you are away from it.
 *
 * Not carried over: the trace's minimap moving left of the inspector in the medium layout (the
 * minimap is the trace's own and has no placement from outside); `Escape` is one `keymap` binding
 * that steps out one level (the switcher, a route or step, a ticket, the medium spec) and, on a
 * page, with nothing left to put away, closes it.
 */
import type { JSX } from "nsh";
import { effect, keymap, signal, untracked, View } from "nsh";
import type { Attachment, Bot, BuiltinModelRole, Hold, Provider, SessionSummary, TaskDetail, TicketStatus, TicketWithArtifacts } from "@real-bot/protocol";
import { tick } from "../../lib/reactive";
import { copy } from "../../runtime";
import { holdBack } from "../../m/chat/message-text-pages.ts";
import type { StopChoice } from "../../m/chat/stop-menu.ts";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { engineHasNoJobs, engineOffSteps, sessionEngine, sessionsOnEngine } from "../../m/overlays/job-engine.ts";
import { jobInspectorWidth, jobLayoutMode, jobRailWidth } from "../../m/overlays/job-layout.ts";
import { JobState } from "../../m/overlays/job-state.svelte.ts";
import { attentionCount, planAttention } from "../../m/overlays/plan-attention.ts";
import { actorName, firstPreviewable, ticketArtifactAttachments } from "../../m/overlays/plan-board.ts";
import type { TraceFocus } from "../../m/overlays/task-trace.ts";
import { TicketEdits } from "../../m/overlays/ticket-edits.svelte.ts";
import { divisionOf, ticketLanes, type LaneMark, type TicketLanes } from "../../m/overlays/ticket-lanes.ts";
import { attachSteps } from "../../m/overlays/trace-steps.ts";
import { askSpent, loadTraceView, saveTraceView, spendAsk, type TraceViewAsk, type TraceViewKind } from "../../m/overlays/trace-view.ts";
import { Playbooks, playbookName } from "../../m/settings/playbooks.svelte.ts";
import { classifySession, youBotPeer } from "../../m/sidebar/session-groups.ts";
import { sessionTitle } from "../../m/sidebar/session-title.ts";
import { shadow } from "../styles";
import { JobHeader } from "./JobHeader";
import { JobInspector, type InspectorEngine, type InspectorView } from "./JobInspector";
import { BoardHead, JobChip, JobSegments, SplitHandle } from "./job-layout-parts";
import { TicketList } from "./TicketList";
import { TicketRail } from "./TicketRail";
import { TraceView, type PaneBox, type TraceViewHandle } from "./TraceView";

type Style = Record<string, unknown>;
const HIDDEN: Style = { visibility: "hidden", pointerEvents: "none" };
const FILL: Style = { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 };

export function JobLayout(props: {
  api: MessengerApi | null;
  /** The job to open on. Null asks the session for its most recent one. */
  taskId: string | null;
  /** A line of yours filed under no job, drawn as a flow of its own (ADR 0083): no tickets, no spec. */
  line?: string | null;
  /** A built-in call's model and prompts, changed in a step's panel by its 「改这个调用」. */
  callEditor?: (role: BuiltinModelRole) => JSX.Element;
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
  reloadToken: number;
  /** A page fills the screen and has its own close button; a pane is closed by its tab. */
  host?: "pane" | "page";
  /** Absent in a pane: a pane is closed by its own tab, not by a button inside the content. */
  onClose?: () => void;
  onJump: (sessionId: string, messageId: string) => void;
  /** The job actually on screen, so the address follows the switcher. */
  onTask?: (taskId: string) => void;
  /** What a tab saved before the job was one tab asks to open on: the board opened out, or the spec beside the trace. */
  view?: TraceViewKind | null;
  /** What a tab was asked to show (a ticket, a column) and which request. A new `askToken` is a new request. */
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
    siblings?: Attachment[] | null,
  ) => void;
  /** Roles, on the engine the job runs under. Left out, the job names its engine without a way there. */
  onOpenRoles?: (playbookId: string) => void;
  /** This job's task map (ADR 0097), opened beside the flow; absent where no workbench holds it. */
  onOpenMap?: (taskId: string) => void;
  /** A width to lay out by instead of measuring one: stories and tests. */
  width?: number;
}) {
  const t = () => copy();
  const host = () => props.host ?? "pane";
  const line = () => props.line ?? null;
  const providers = () => props.providers ?? [];
  let traceHandle: TraceViewHandle | null = null;
  const switcherOpen = signal(false);

  // --- The job on screen and its edits ---
  const specHeld = signal(false);
  const statusFilter = signal<TicketStatus | "all">("all");
  const job = new JobState({
    api: () => props.api,
    sessionId: () => props.sessionId,
    taskId: () => props.taskId,
    line: () => line(),
    onTask: (id) => props.onTask?.(id),
    onSwitch: (session, next) => {
      traceHandle?.switchBoard(session, next);
      statusFilter.set("all");
      specHeld.set(false);
    },
  });
  /** Every edit to the job's tickets, from the board opened out or the inspector, through one queue. */
  const edits = new TicketEdits({
    api: () => props.api,
    detail: () => job.detail!,
    t: () => copy(),
    providers,
    onPatched: (ticket) => job.ticketPatched(ticket),
    onConflict: () => job.reloadPlan(),
  });
  effect(() => {
    if (job.detail) edits.loadModels();
  });

  // --- How it lays out ---
  /** Its own width once measured; before that a page is narrow and a pane is wide. */
  const measuredWidth = signal(0);
  const bodySize = signal({ width: 0, height: 0 });
  const flowSize = signal({ width: 0, height: 0 });
  const width = () => props.width ?? measuredWidth();
  const mode = () => jobLayoutMode(width(), host());
  const narrow = () => mode() === "narrow";
  const medium = () => mode() === "medium";
  /** Medium: the spec over the trace's right edge, asked for from the title row's 要点. */
  const specOpen = signal(false);
  /** Narrow, the part on screen: the tickets, the trace or the spec. Remembered per install. */
  const segment = signal<TraceViewKind>(props.view ?? (props.focus ? "trace" : loadTraceView()));
  /** The board of five columns in place of the rail and the trace. */
  const boardOpen = signal(props.view === "board");
  /** Wide: the inspector over the whole tab, for reading or editing the spec at length. */
  const inspectorExpanded = signal(false);

  const hasTickets = () => (job.detail?.tickets.length ?? 0) > 0;
  /** Who does what in the job: each Bot's tickets as written down beside the turns it ran. */
  const division = () => (job.detail && job.trace ? divisionOf(job.trace.nodes, job.detail.tickets) : []);
  /** What in the plan needs you, said in the title row too. */
  const attention = () => (job.detail ? attentionCount(planAttention(job.detail)) : 0);

  /** The engines, read once per daemon, so the job can say which one its own calls run under. */
  const playbooks = new Playbooks(() => props.api);
  let playbooksFor: MessengerApi | null = null;
  effect(() => {
    const client = props.api;
    if (!client || client === playbooksFor) return;
    playbooksFor = client;
    untracked(() => void playbooks.load());
  });
  const engine = (): InspectorEngine | null => {
    if (!job.detail || !playbooks.list) return null;
    const sessions = props.sessions;
    const known = (id: string) => Boolean(playbooks.find(id));
    const { id, why } = sessionEngine(sessions, job.detail.session_id, playbooks.defaultId, known);
    const item = playbooks.find(id);
    return {
      name: playbookName(item, t().playbooks.builtin) || id,
      why,
      off: engineOffSteps(item).map((step) => t().playbooks.steps[step]?.name ?? step),
      stopped: engineHasNoJobs(item),
      sessions: sessionsOnEngine(sessions, id, playbooks.defaultId, known),
      onOpen: props.onOpenRoles ? () => props.onOpenRoles?.(id) : undefined,
    };
  };
  const lanes = () => (job.detail && job.trace ? ticketLanes(job.trace.nodes, job.detail.tickets) : null);
  /**
   * The plan and its lanes as the parts read them: while a part is on its way out (the plan went
   * away under it) it still reads the last one it had, and never a null.
   */
  let lastDetail: TaskDetail | null = null;
  let lastLanes: TicketLanes | null = null;
  const planNow = (): TaskDetail => (lastDetail = job.detail ?? lastDetail)!;
  const lanesNow = (): TicketLanes => (lastLanes = lanes() ?? lastLanes)!;
  const stepGroup = () => {
    const id = job.openStep;
    const trace = job.trace;
    if (!id || !trace?.steps?.length) return null;
    return attachSteps(trace.nodes, trace.steps).groups.find((group) => group.id === id) ?? null;
  };
  const ticketPicked = () => job.selectedTicket !== null && Boolean(job.detail?.tickets.some((row) => row.id === job.selectedTicket));
  /**
   * What the inspector shows. Wide: a step, else the ticket, else the spec. Medium the same, except
   * that with nothing picked the spec waits to be asked for. Narrow, the part on screen decides: a
   * step over the trace, the ticket over the rail, and the spec as the spec's part, held to the
   * picked ticket when its 「在要点里看」 brought you there.
   */
  const inspectorView = (): InspectorView | null => {
    if (narrow()) {
      if (segment() === "trace") return stepGroup() ? "step" : null;
      if (segment() === "board") return ticketPicked() ? "ticket" : null;
      return job.detail ? "spec" : null;
    }
    if (stepGroup()) return "step";
    if (medium()) {
      if (ticketPicked() && !specHeld()) return "ticket";
      return job.detail && (specOpen() || specHeld()) ? "spec" : null;
    }
    if (ticketPicked() && !specHeld()) return "ticket";
    return job.detail ? "spec" : null;
  };
  /** Narrow, a step or a ticket comes up over the bottom of the part it was picked in. */
  const sheet = () => narrow() && segment() !== "spec" && inspectorView() !== null;
  const segmentShown = (): TraceViewKind => (!job.detail || (segment() === "board" && !hasTickets()) ? "trace" : segment());

  // --- The widths of the rail and the inspector, kept per install ---
  const railStore = jobRailWidth();
  const inspectorStore = jobInspectorWidth();
  const railPreferred = signal(railStore.load());
  const inspectorPreferred = signal(inspectorStore.load());
  const railWidth = () => railStore.clamp(railPreferred(), width() || Number.POSITIVE_INFINITY);
  const inspectorWidth = () => inspectorStore.clamp(inspectorPreferred(), width() || Number.POSITIVE_INFINITY);
  /** Which edge is in hand: it keeps its tint while the pointer runs off it. */
  const resizing = signal<"rail" | "inspector" | null>(null);
  let resizeOrigin = 0;
  const startResize = (which: "rail" | "inspector") => {
    resizing.set(which);
    resizeOrigin = which === "rail" ? railWidth() : inspectorWidth();
  };
  const moveResize = (which: "rail" | "inspector", dx: number) => {
    if (which === "rail") railPreferred.set(railStore.clamp(resizeOrigin + dx, width()));
    else inspectorPreferred.set(inspectorStore.clamp(resizeOrigin - dx, width()));
  };
  const endResize = (which: "rail" | "inspector") => {
    resizing.set(null);
    if (which === "rail") railStore.save(railPreferred());
    else inspectorStore.save(inspectorPreferred());
  };

  // --- What the parts ask of each other ---
  /** Medium, the title row's 要点: the spec over the trace (held to the picked ticket), or put away. */
  function toggleSpec(): void {
    if (inspectorView() === "spec") {
      specOpen.set(false);
      specHeld.set(false);
      return;
    }
    job.openStep = null;
    if (ticketPicked()) specHeld.set(true);
    else specOpen.set(true);
  }

  function chooseSegment(next: TraceViewKind): void {
    segment.set(next);
    saveTraceView(next);
  }

  const botsById = () => new Map(props.bots.map((bot) => [bot.id, bot]));
  const sessionsById = () => new Map(props.sessions.map((session) => [session.id, session]));
  const nameOf = (actor: string) => actorName(actor, botsById(), props.youLabel, props.deletedLabel);

  /** Where the job's own conversation is, for the title row, said as the trace's cards say it. */
  const place = (): string | null => {
    const id = job.trace?.session_id;
    if (!id) return null;
    const session = sessionsById().get(id);
    if (!session) return t().trace.sessionUnknown;
    if (session.kind === "group") return t().trace.sessionGroup(session.name ?? session.id);
    if (classifySession(session) === "you-bot") {
      const peer = youBotPeer(session);
      return t().trace.sessionDirect(peer ? nameOf(peer) : props.deletedLabel);
    }
    return t().trace.sessionDirect(
      sessionTitle(session, botsById(), { deleted: props.deletedLabel, archived: props.deletedLabel, fileDrop: t().sidebar.fileDrop, projectUntitled: t().project.untitled }),
    );
  };

  function selectJob(id: string): void {
    switcherOpen.set(false);
    job.selectJob(id);
  }

  /** A ticket picked on the rail, or put down. */
  function pickTicket(id: string | null): void {
    job.selectedTicket = id;
    specHeld.set(false);
    inspectorExpanded.set(false);
  }

  /** A card on a lane: its ticket picked, and the trace slides to it. */
  function pickMark(ticketId: string | null, mark: LaneMark): void {
    if (ticketId) pickTicket(ticketId);
    if (narrow()) chooseSegment("trace");
    void tick().then(() => traceHandle?.showCard(mark.turnId));
  }

  /** A ticket's work on the trace: the trace on screen, the ticket lit, its newest card in view. */
  function showInTrace(id: string): void {
    boardOpen.set(false);
    inspectorExpanded.set(false);
    if (narrow()) chooseSegment("trace");
    void tick().then(() => traceHandle?.showTicket(id));
  }

  /** The title row's 「需要你看」: the whole job's plan in the inspector, where what needs you is said. */
  function showWholeJob(): void {
    job.openStep = null;
    pickTicket(null);
    if (narrow()) chooseSegment("spec");
    if (medium()) specOpen.set(true);
  }

  /** A ticket named in the spec: picked, and the inspector turns to it. */
  function showTicketFromSpec(id: string): void {
    pickTicket(id);
    if (narrow()) chooseSegment("board");
  }

  /** The spec's ticket states: the rail (or the board, if it is open) shows that status alone. */
  function showTickets(status: TicketStatus | "all"): void {
    statusFilter.set(status);
    inspectorExpanded.set(false);
    if (narrow()) chooseSegment("board");
  }

  function openTicketArtifacts(ticket: TicketWithArtifacts): void {
    const siblings = ticketArtifactAttachments(ticket);
    const target = firstPreviewable(siblings);
    if (!target || !props.onOpenArtifact) return;
    props.onOpenArtifact(target.workspace_relpath, target, target.message_id, true, job.currentId ?? props.taskId, siblings);
  }

  /** Narrow, a ticket's 「在要点里看」 turns to the spec's part, held to the ticket. */
  effect(() => {
    if (!specHeld()) return;
    untracked(() => {
      if (narrow() && segment() !== "spec") chooseSegment("spec");
    });
  });

  /** On a phone Back puts a sheet away (a step's, a ticket's) before it leaves the job. */
  effect(() => {
    if (host() !== "page" || !sheet()) return;
    return holdBack(() => {
      if (inspectorView() === "step") job.openStep = null;
      else job.selectedTicket = null;
    });
  });

  /** A message asking for its card brings the trace up, narrow; not remembered as your choice. */
  let seenFocus = props.focusToken ?? 0;
  effect(() => {
    const token = props.focusToken ?? 0;
    if (token === seenFocus) return;
    seenFocus = token;
    untracked(() => {
      if (props.focus) {
        segment.set("trace");
        boardOpen.set(false);
        inspectorExpanded.set(false);
      }
    });
  });

  /**
   * What a tab was asked to show, once its job is the one on screen. A request is acted on once: the
   * tab brought forward again still carries it, and acting on it again would take back whatever you
   * picked since.
   */
  const pendingAsk = signal<TraceViewAsk | null>(null);
  let seenAsk = 0;
  effect(() => {
    const token = props.askToken ?? 0;
    if (!token || token === seenAsk) return;
    seenAsk = token;
    untracked(() => {
      const key = props.view ?? "trace";
      if (askSpent(props.sessionId, key, token)) return;
      spendAsk(props.sessionId, key, token);
      pendingAsk.set(props.ask ?? null);
    });
  });
  effect(() => {
    const wanted = pendingAsk();
    if (!wanted || job.loading || !job.detail || (props.taskId !== null && job.currentId !== props.taskId)) return;
    pendingAsk.set(null);
    untracked(() => {
      if (wanted.column) statusFilter.set(wanted.column);
      if (!wanted.ticket || !job.detail?.tickets.some((row) => row.id === wanted.ticket)) return;
      pickTicket(wanted.ticket);
      if (props.view === "spec") specHeld.set(true);
    });
  });

  void job.load(props.taskId);
  /**
   * One Escape, one step out: the switcher, then an unfolded model choice or a step's panel, then a
   * picked ticket, then the medium spec; a page with nothing left to put away closes. One binding,
   * so what goes first is decided here and not by which of two listeners mounted first.
   */
  keymap.bind("escape", () => {
    if (switcherOpen()) {
      switcherOpen.set(false);
      return;
    }
    const closedRoute = traceHandle?.closeRoute() ?? false;
    if (closedRoute || job.openStep) {
      job.openStep = null;
      return;
    }
    if (job.selectedTicket) {
      job.selectedTicket = null;
      return;
    }
    if (medium() && (specOpen() || specHeld())) {
      specOpen.set(false);
      specHeld.set(false);
      return;
    }
    if (host() === "page") props.onClose?.();
  });

  /**
   * A live plan reloads on every turn, message, filing and ticket move. A fan-out lands several of
   * those within a frame; one read a moment later shows all of them.
   */
  effect(() => {
    const token = props.reloadToken;
    if (token === 0) return;
    const timer = setTimeout(() => void job.load(untracked(() => job.currentId) ?? props.taskId), 150);
    return () => clearTimeout(timer);
  });

  /**
   * Pointed at another job from outside: a card, a link, the conversation's own button. The job
   * picked in here comes back through `onTask` and lands as the same value, so it is not fetched twice.
   */
  let requestedTask = props.taskId;
  effect(() => {
    const next = props.taskId;
    if (next === requestedTask) return;
    requestedTask = next;
    if (next && next !== untracked(() => job.currentId)) untracked(() => void job.load(next));
  });

  /** A different conversation shows that conversation's job. */
  let loadedFor = props.sessionId;
  effect(() => {
    const next = props.sessionId;
    if (next === loadedFor) return;
    loadedFor = next;
    untracked(() => void job.load(null));
  });

  // --- Where each part sits ---
  const rail = () => hasTickets() && lanes() !== null && job.detail !== null;
  const covered = () => (boardOpen() && job.detail !== null && !narrow()) || (inspectorExpanded() && !narrow());
  const railStyle = (): Style =>
    narrow()
      ? { ...FILL, ...(segmentShown() === "board" ? {} : HIDDEN) }
      : { width: railWidth(), ...(covered() ? HIDDEN : {}) };
  const flowStyle = (): Style =>
    narrow() ? { ...FILL, ...(segmentShown() === "trace" ? {} : HIDDEN) } : { flexGrow: 1, flexShrink: 1, flexBasis: 0, ...(covered() ? HIDDEN : {}) };
  /** The board opened out lies over the rail and the trace, which stay where they are underneath. */
  const boardStyle = (): Style => {
    if (narrow()) return { ...FILL, zIndex: 2, ...(segmentShown() === "board" ? {} : HIDDEN) };
    const beside = !medium() && inspectorView() !== null ? inspectorWidth() : 0;
    return { position: "absolute", left: 0, top: 0, bottom: 0, right: beside, zIndex: 2, ...(inspectorExpanded() ? HIDDEN : {}) };
  };
  const inspectorStyle = (): Style => {
    if (narrow()) {
      if (sheet()) return { position: "absolute", left: 0, right: 0, bottom: 0, height: bodySize().height * 0.62, zIndex: 5, boxShadow: shadow("lg") };
      return { ...FILL, ...(segmentShown() === "spec" ? {} : HIDDEN) };
    }
    if (inspectorExpanded()) return { ...FILL, zIndex: 3 };
    if (medium()) {
      return {
        position: "absolute",
        zIndex: 5,
        top: 10,
        right: 10,
        bottom: 56,
        width: Math.min(inspectorWidth(), width() - 40),
        overflow: "hidden",
        boxShadow: shadow("lg"),
      };
    }
    return { width: inspectorWidth() };
  };
  const inspectorBox = () =>
    narrow() && sheet()
      ? "border-t border-line rounded-t-(--radius-lg) overflow-hidden"
      : !narrow() && medium() && !inspectorExpanded()
        ? "border border-line rounded-(--radius-md)"
        : narrow() || inspectorExpanded()
          ? ""
          : "border-l border-line";

  /** Where the step's panel lies over the trace, in the trace's own points, so its card can slide out from under it. */
  const coverBox = (): PaneBox | null => {
    if (inspectorView() !== "step") return null;
    const flow = flowSize();
    if (narrow()) {
      if (!sheet()) return null;
      const height = bodySize().height * 0.62;
      return { x: 0, y: flow.height - height, width: flow.width, height };
    }
    if (!medium() || inspectorExpanded()) return null;
    const wide = Math.min(inspectorWidth(), width() - 40);
    return { x: flow.width - 10 - wide, y: 10, width: wide, height: Math.max(0, flow.height - 10 - 56) };
  };

  return (
    <View
      testID="job-pane"
      accessibilityLabel={narrow() ? `job-narrow:${segmentShown()}` : medium() ? "job-medium" : "job-wide"}
      onLayout={(e) => measuredWidth.set(e.bounds.size.width)}
      class="relative flex-1 w-full h-full min-w-0 min-h-0 bg-pane overflow-hidden"
    >
      <JobHeader
        job={job}
        line={line()}
        place={place()}
        bots={props.bots}
        sessions={props.sessions}
        deletedLabel={props.deletedLabel}
        switcherOpen={switcherOpen()}
        onSwitcherOpenChange={(open) => switcherOpen.set(open)}
        onSelectJob={selectJob}
        holds={props.holds}
        onStop={props.onStop}
        onLift={props.onLift}
        controlsDisabled={props.controlsDisabled}
        onClose={props.onClose}
        end={() => (
          <>
            <If when={medium() && job.detail}>
              <JobChip testID="job-chip-spec" tone="toggle" label={t().plan.segmentSpec} pressed={inspectorView() === "spec"} onPress={toggleSpec} />
            </If>
            <If when={attention() > 0}>
              <JobChip testID="job-chip-attention" tone="attention" label={t().plan.job.attention(attention())} onPress={showWholeJob} />
            </If>
            <If when={engine()}>
              {(info) => (
                <JobChip
                  testID="job-chip-engine"
                  label={t().plan.job.engine.chip(info().name)}
                  title={t().plan.job.engine.title}
                  disabled={!info().onOpen}
                  onPress={() => info().onOpen?.()}
                />
              )}
            </If>
            <If when={props.onOpenMap && job.currentId && !line()}>
              <JobChip
                testID="job-chip-map"
                label={t().taskmap.open}
                title={t().taskmap.openLong}
                onPress={() => job.currentId && props.onOpenMap?.(job.currentId)}
              />
            </If>
          </>
        )}
        middle={() => (
          <If when={job.detail && narrow()}>
            {/* Narrow, the job's three parts one at a time; on a narrow host the switch takes a row of its own. */}
            <JobSegments shown={segmentShown()} hasTickets={hasTickets()} tickets={job.detail?.tickets.length ?? 0} onChoose={chooseSegment} />
          </If>
        )}
      />
      <View
        testID="job-body"
        class="relative flex-1 min-w-0 min-h-0"
        style={{ flexDirection: narrow() ? "column" : "row" }}
        onLayout={(e) => bodySize.set({ width: e.bounds.size.width, height: e.bounds.size.height })}
      >
        <If when={rail()}>
          <View testID="job-rail" class={`relative min-w-0 min-h-0 ${narrow() ? "" : "border-r border-line"}`} style={railStyle()}>
            <TicketRail
                detail={planNow()}
                lanes={lanesNow()}
                bots={props.bots}
                youLabel={props.youLabel}
                deletedLabel={props.deletedLabel}
                selectedId={job.selectedTicket}
                statusFilter={statusFilter()}
                onPick={pickTicket}
                onPickMark={pickMark}
                onClearFilter={() => statusFilter.set("all")}
                onExpand={() => boardOpen.set(true)}
              />
            <If when={!narrow()}>
              <SplitHandle
                side="rail"
                label={t().plan.job.resizeRail}
                active={resizing() === "rail"}
                onStart={() => startResize("rail")}
                onMove={(dx) => moveResize("rail", dx)}
                onEnd={() => endResize("rail")}
              />
            </If>
          </View>
        </If>
        <View
          testID="job-flow"
          class="relative min-w-0 min-h-0"
          style={flowStyle()}
          onLayout={(e) => flowSize.set({ width: e.bounds.size.width, height: e.bounds.size.height })}
        >
          <TraceView
            api={props.api}
            job={job}
            taskId={props.taskId}
            focus={props.focus}
            focusToken={props.focusToken}
            sessionId={props.sessionId}
            activeSessionId={props.activeSessionId}
            sessions={props.sessions}
            bots={props.bots}
            providers={providers()}
            youLabel={props.youLabel}
            deletedLabel={props.deletedLabel}
            onJump={props.onJump}
            onOpenArtifact={props.onOpenArtifact}
            onHandle={(handle) => (traceHandle = handle)}
            coverBox={coverBox}
          />
        </View>
        <If when={boardOpen() && job.detail}>
          <View testID="job-board" class="min-w-0 min-h-0 bg-pane border-r border-line" style={boardStyle()}>
            <BoardHead onClose={() => boardOpen.set(false)} />
            <View class="flex-1 min-h-0 overflow-hidden">
              <TicketList
                  api={props.api}
                  detail={planNow()}
                  providers={providers()}
                  nodes={job.trace?.nodes ?? []}
                  bots={props.bots}
                  youLabel={props.youLabel}
                  deletedLabel={props.deletedLabel}
                  selectedId={job.selectedTicket}
                  onSelect={pickTicket}
                  onJump={props.onJump}
                  onOpenArtifacts={openTicketArtifacts}
                  onPatched={(ticket) => job.ticketPatched(ticket)}
                  onConflict={() => job.reloadPlan()}
                  statusFilter={statusFilter()}
                  onStatusFilterChange={(status) => statusFilter.set(status)}
                  onShowSpec={() => specHeld.set(true)}
                  onShowInTrace={showInTrace}
                  edits={edits}
                  details={false}
                />
            </View>
          </View>
        </If>
        <If when={inspectorView() !== null}>
          <View
            role="region"
            testID="job-inspector"
            accessibilityLabel={t().plan.job.inspector}
            class={`relative min-w-0 min-h-0 bg-pane ${inspectorBox()}`}
            style={inspectorStyle()}
          >
            <If when={!narrow()}>
              <SplitHandle
                side="inspector"
                label={t().plan.job.resizeInspector}
                active={resizing() === "inspector"}
                onStart={() => startResize("inspector")}
                onMove={(dx) => moveResize("inspector", dx)}
                onEnd={() => endResize("inspector")}
              />
            </If>
            <JobInspector
                api={props.api}
                job={job}
                edits={edits}
                view={inspectorView() ?? "spec"}
                stepGroup={stepGroup()}
                nodes={job.trace?.nodes ?? []}
                bots={props.bots}
                youLabel={props.youLabel}
                deletedLabel={props.deletedLabel}
                specHeld={specHeld()}
                onSpecHeldChange={(held) => specHeld.set(held)}
                expanded={inspectorExpanded()}
                onExpandedChange={(next) => inspectorExpanded.set(next)}
                canExpand={!narrow()}
                onClose={medium() ? () => { specOpen.set(false); specHeld.set(false); } : undefined}
                callEditor={props.callEditor}
                onJump={props.onJump}
                onOpenArtifacts={openTicketArtifacts}
                onShowInTrace={showInTrace}
                onShowTickets={showTickets}
                onShowTicket={showTicketFromSpec}
                lanes={lanes()}
                division={division()}
                engine={engine()}
              />
          </View>
        </If>
      </View>
    </View>
  );
}
