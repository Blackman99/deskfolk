/**
 * The job's trace on its canvas, filling whatever it is put in. The job it draws (its trace, its
 * plan, the ticket and step picked in it) is the `JobState` it is handed, shared with the rail and
 * the inspector beside it; what is only the picture's (the camera, the folds, the measured cards,
 * the highlights) is its own.
 *
 * The camera is the messenger's `TraceCanvas`, run unchanged: a drag or two fingers become the
 * pointer events it reads (`trace-gestures.ts`), and a stand-in for the viewport element hands it
 * the box `onLayout` measured. The cards are views placed on a board that is moved and scaled by a
 * transform; the lines are a `Canvas` under them (`trace-edges.tsx`).
 *
 * Not carried over: the wheel (⌘/Ctrl + wheel to zoom, a plain wheel to pan), which NSH's views do
 * not hear; the zoom buttons, a pinch and a drag do the same work.
 */
import { Text, View, cleanup, computed, effect, signal, token, untracked, type ViewRef } from "nsh";
import type { Attachment, Bot, Provider, SessionSummary, TaskTraceNode, Ticket } from "@real-bot/protocol";
import { copy } from "../../runtime";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { actorFace, actorName, firstPreviewable, latestTurnOfTicket } from "../../m/overlays/plan-board.ts";
import { routeCardRow, type RouteLogRow } from "../../m/overlays/route-log.ts";
import type { JobState } from "../../m/overlays/job-state.svelte.ts";
import {
  TRACE_CARD_WIDTH,
  TRACE_STEP_WIDTH,
  TRACE_ZOOM_MAX,
  TRACE_ZOOM_MIN,
  backOnBoard,
  defaultFolded,
  filterTrace,
  focusMoveDue,
  focusNode,
  highlightOf,
  holdOnScreen,
  keepBoard,
  keptBoard,
  routeHighlightCounts,
  routeRepeats,
  traceFlow,
  traceRounds,
  wokenByName,
  type RouteHighlight,
  type TraceFlow,
  type TraceRound as TraceRoundRow,
  type TracePlacement as CardPlacement,
  type TraceStepPlacement as StepPlacement,
  type TraceBox,
  type TraceFocus,
} from "../../m/overlays/task-trace.ts";
import { loadTraceMinimap, saveTraceMinimap } from "../../m/overlays/trace-minimap.ts";
import { TraceCanvas } from "../../m/overlays/trace-canvas.svelte.ts";
import { anomalousCards, loadTraceSteps, saveTraceSteps, type StepsShown } from "../../m/overlays/trace-steps.ts";
import { Button } from "../Button";
import { TraceCard } from "./TraceCard";
import { TraceMinimap } from "./TraceMinimap";
import { TraceRound } from "./TraceRound";
import { TraceRouteDetail } from "./TraceRouteDetail";
import { TraceStepCard } from "./TraceStepCard";
import { traceGestures, viewportStandIn } from "./trace-gestures";
import { TraceEdges } from "./trace-edges";
import { TraceTools } from "./trace-tools";
import { minimapToneOf, placeOf, routeCompactOf, ticketLightOf, ticketOf } from "./trace-view-helpers";

/** What a host can ask of the board from beside it (the Svelte component's exported methods). */
export type TraceViewHandle = {
  /** A ticket seen where its work happened: picked, its rounds lit and open, the board slid to its newest card. */
  showTicket: (id: string) => Promise<void>;
  /** One card, asked for from beside the board (a mark on the rail): its round opened, the board slid to it. */
  showCard: (turnId: string) => Promise<void>;
  /** Escape, from the job around the board: an unfolded model choice closes first. True when one did. */
  closeRoute: () => boolean;
  /** Another job is about to be on screen: keep this one's board, take the next one up as it was left, or fresh. */
  switchBoard: (session: string, next: string | null) => void;
};

/** A box in the board pane's own points; the step panel lying over the board, for example. */
export type PaneBox = { x: number; y: number; width: number; height: number };

type Box = { x: number; y: number; width: number; height: number };

export function TraceView(props: {
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
  onJump: (sessionId: string, messageId: string) => void;
  onOpenArtifact?: (
    relpath: string,
    att?: Attachment,
    messageId?: string | null,
    forceTree?: boolean,
    taskId?: string | null,
    siblings?: Attachment[] | null,
  ) => void;
  /** Receives the board's handle once, for the host's `showTicket`, `showCard`, `closeRoute` and `switchBoard`. */
  onHandle?: (handle: TraceViewHandle) => void;
  /**
   * Where the step's panel lies over the board, in window points, or none where it sits beside it.
   * Where it covers the board, the card it is about slides out from under it once.
   */
  coverBox?: () => PaneBox | null;
}) {
  const job = props.job;
  const t = () => copy();
  const focusToken = () => props.focusToken ?? 0;
  const providers = () => props.providers ?? [];

  const notableOnly = signal(false);
  /** The minimap in the corner, until you put it away; kept per install, like the view. */
  const minimapShown = signal(loadTraceMinimap());
  /** The card whose model choice is unfolded under it. One at a time. */
  const openRoute = signal<string | null>(null);
  /** Which kind of model trouble the board is lighting up, if any. */
  const highlight = signal<RouteHighlight | null>(null);
  /** The app's own calls on the board (ADR 0083): the ones that went wrong or said no, unless you asked for all of them. */
  const stepsChoice = signal<StepsShown>(loadTraceSteps());
  /** The steps that went wrong lit, the rest of the board dimmed. */
  const stepsLit = signal(false);
  /** What each card measured to; the layout is fed the real boxes and redone when one changes. */
  const boxes = signal<Record<string, TraceBox>>({});
  /** Rounds you folded or unfolded yourself, over the board's own choice. */
  const foldChoice = signal<Record<string, boolean>>({});

  const shown = computed(() => (job.trace ? filterTrace(job.trace, notableOnly()) : null));
  const rounds = computed(() => (shown() ? traceRounds(shown()!.nodes) : []));
  /** The cards something that went wrong hangs under: lit, their rounds stay open. */
  const anomalous = computed(() => (shown() ? anomalousCards(shown()!.nodes, shown()!.steps ?? []) : new Set<string>()));
  const highlightCounts = computed(() => (job.trace ? routeHighlightCounts(job.trace.nodes) : { feedback: 0, blamed: 0 }));
  const lighting = computed<RouteHighlight | null>(() => (highlight() && highlightCounts()[highlight()!] > 0 ? highlight() : null));
  /**
   * A long job keeps its newest rounds open and folds the rest to a line each. A round stays open
   * while anything in it is still going, holds the card a message asked for, or holds a card a
   * ticket or a highlight is lighting: folding those away would hide the answer to the question.
   */
  const folded = computed(() => {
    const focus = props.focus ?? null;
    const asked = focus && shown() ? (focusNode(shown()!.nodes, focus)?.turn_id ?? null) : null;
    const next = defaultFolded(
      rounds(),
      (node) =>
        node.turn_id === asked ||
        (job.selectedTicket !== null && node.ticket_id === job.selectedTicket) ||
        highlightOf(node, lighting()) === "lit" ||
        (stepsLit() && anomalous().has(node.turn_id)),
    );
    for (const [root, shut] of Object.entries(foldChoice())) {
      if (shut) next.add(root);
      else next.delete(root);
    }
    return next;
  });
  /** A line's own board (a line filed under no job) is its steps and your card: all drawn, whatever the job boards are set to. */
  const isLineBoard = () => shown()?.id.startsWith("line:") ?? false;
  const stepsShown = (): StepsShown => (isLineBoard() ? "all" : stepsChoice());
  const flow = computed(() => (shown() ? traceFlow(shown()!, new Map(Object.entries(boxes())), { folded: folded(), steps: stepsShown() }) : null));
  /** The board, once there is a round to draw. */
  const board = computed(() => (flow() && flow()!.rounds.length > 0 ? flow() : null));
  const anomalyCount = () => flow()?.rounds.reduce((sum, round) => sum + round.anomalies, 0) ?? 0;

  // The viewport as `onLayout` measured it, and where its top left is in the window.
  const viewport = signal({ width: 0, height: 0 });
  const toolsHeight = signal(0);
  const origin = signal({ x: 0, y: 0 });
  const paneWidth = signal(0);
  let viewportRef: ViewRef | null = null;
  const hasTools = () => !!job.trace && job.trace.nodes.length > 0;
  const standIn = viewportStandIn(() => ({ ...viewport(), toolsHeight: hasTools() ? toolsHeight() : 0 }));

  const canvas = new TraceCanvas(props.sessionId, props.taskId, {
    sessionId: () => props.sessionId,
    flow: () => flow(),
    currentId: () => job.currentId,
    focus: () => props.focus ?? null,
    focusToken,
    boxes: () => boxes(),
    setBox: (id, box) => boxes.set({ ...boxes(), [id]: box }),
  });
  const gestures = traceGestures(canvas, () => origin());

  function measureOrigin(): void {
    void viewportRef?.measure().then((m) => {
      if (m && (m.pagePosition.x !== origin().x || m.pagePosition.y !== origin().y)) origin.set({ x: m.pagePosition.x, y: m.pagePosition.y });
    });
  }

  function viewportLayout(size: { width: number; height: number }): void {
    viewport.set({ width: size.width, height: size.height });
    canvas.viewportSize = { width: size.width, height: size.height };
    measureOrigin();
    if (!size.width || !size.height) return;
    if (!canvas.viewportEl) canvas.viewportEl = standIn;
    if (props.focus && focusMoveDue(focusToken(), canvas.placedFocus)) canvas.focusBoard();
  }

  /** A card measured: the layout is redone only when its size really changed. */
  function measured(id: string, size: { width: number; height: number }): void {
    canvas.recordBox(id, { offsetWidth: size.width, offsetHeight: size.height } as unknown as HTMLElement);
  }

  /**
   * A new message's request starts from a view that is not yours yet. Read when the token changes,
   * not while the board is being centred: writing `userMoved` there would re-run the effect that
   * just wrote it. A board that was already showing this job slides; one that is opening lands on
   * the card at once.
   */
  let seenFocus = focusToken();
  effect(() => {
    const token = focusToken();
    if (token === seenFocus) return;
    seenFocus = token;
    untracked(() => {
      // A message asking for its card opens the round it is in, even one you folded.
      const focus = props.focus ?? null;
      const asked = focus && shown() ? focusNode(shown()!.nodes, focus) : null;
      const root = asked ? rounds().find((round) => round.members.includes(asked))?.root : undefined;
      if (root && foldChoice()[root]) foldChoice.set({ ...foldChoice(), [root]: false });
      canvas.syncFocusToken();
    });
  });

  /**
   * Keep this job's board as it is, for when it comes back: its tab brought forward again, or the
   * job picked again in the switcher. The camera is only worth keeping once it has been placed.
   */
  function keepThisBoard(): void {
    if (!job.currentId || !job.boardSession || canvas.fitted !== job.currentId) return;
    keepBoard(job.boardSession, job.currentId, {
      ...canvas.leaving(),
      boxes: { ...boxes() },
      foldChoice: { ...foldChoice() },
      notableOnly: notableOnly(),
      selectedTicket: job.selectedTicket,
      highlight: highlight(),
      openRoute: openRoute(),
    });
  }
  cleanup(() => {
    keepThisBoard();
    canvas.stopGlide();
  });

  /**
   * Fold or unfold a round without losing your place. The layout changes under a view that stays
   * put, so the row you pressed is held where it was on screen, and a fold that leaves the viewport
   * on empty canvas slides the board back onto cards.
   */
  function toggleRound(root: string): void {
    const shutting = !folded().has(root);
    const was = flow()?.rounds.find((round) => round.root === root)?.header ?? null;
    foldChoice.set({ ...foldChoice(), [root]: shutting });
    // Pressing a row is using the view: neither the opening nor a message's card pulls it back now.
    canvas.userMoved = true;
    canvas.openedView = null;
    canvas.stopGlide();
    const now = flow()?.rounds.find((round) => round.root === root)?.header ?? null;
    if (!was || !now) return;
    canvas.view = holdOnScreen(canvas.view, was, now);
    const box = canvas.viewportBox();
    if (!shutting || !box.width || !box.height) return;
    const back = backOnBoard(canvas.view, canvas.boardBox(), { x: 12, y: 12, ...canvas.clearBox() });
    if (back.x !== canvas.view.x || back.y !== canvas.view.y) canvas.glideTo(back);
  }

  effect(() => {
    // A board opens showing all of itself; a message opens on its card. After that the view is
    // yours, until another message asks. The card's first real measurement still counts as that
    // opening, so the move lands on the card you see, not the guess that preceded it.
    const width = flow()?.width ?? 0;
    const id = job.currentId;
    const token = focusToken();
    const asked = props.focus ?? null;
    const drift = canvas.focusDrifted();
    if (!width || !id || !canvas.viewportEl) return;
    // The board keeps the previous job on screen, where it was, until the next one arrives.
    if (job.trace?.id !== id) return;
    // Nor until the job this message belongs to arrives: that would spend the request on the wrong picture.
    if (asked && props.taskId && job.trace?.id !== props.taskId && focusMoveDue(token, canvas.placedFocus)) return;
    // A job whose board you have been on comes back where you left it, not opened afresh.
    if (canvas.fitted !== id) untracked(() => canvas.resume(keptBoard(job.boardSession ?? props.sessionId, id), id));
    if (asked && (focusMoveDue(token, canvas.placedFocus) || (drift && !untracked(() => canvas.userMoved)))) {
      const centred = untracked(() => canvas.focusBoard());
      if (canvas.placedFocus !== token) return;
      if (!centred) {
        canvas.fitted = id;
        untracked(() => canvas.openBoard());
        return;
      }
    }
    if (canvas.fitted === id) {
      // Reading the view here would re-run this on every pan; it is only compared, once per layout.
      untracked(() => {
        if (canvas.stillOpened()) canvas.openBoard();
      });
      return;
    }
    canvas.fitted = id;
    // Centred on the card for this request already, here or by the viewport's first size.
    if (!(asked && canvas.anchored?.token === token)) untracked(() => canvas.openBoard());
  });

  // A step's panel that lies over the board: the card it is about slides out from under it once.
  effect(() => {
    const id = job.openStep;
    if (!id) return;
    void Promise.resolve().then(() => {
      const cover = props.coverBox?.() ?? null;
      const placed = flow()?.steps.find((row) => row.group.id === id);
      if (job.openStep !== id || !cover || !placed || !canvas.viewportEl) return;
      const rect = (box: Box) => ({ left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, width: box.width, height: box.height });
      const view = canvas.view;
      const card = rect({ x: view.x + placed.x * view.scale, y: view.y + placed.y * view.scale, width: placed.width * view.scale, height: placed.height * view.scale });
      const covering = rect({ x: cover.x - origin().x, y: cover.y - origin().y, width: cover.width, height: cover.height });
      const port = viewport();
      const overlaps = covering.left < port.width && covering.right > 0 && covering.top < port.height && covering.bottom > 0;
      if (overlaps) canvas.uncover({ getBoundingClientRect: () => card } as unknown as HTMLElement, { getBoundingClientRect: () => covering } as unknown as HTMLElement);
    });
  });

  const byId = computed(() => new Map((shown()?.nodes ?? []).map((node) => [node.turn_id, node])));
  /** The card this opening was asked to land on, while that request is the one on screen. */
  const focusedTurn = computed(() => {
    const focus = props.focus ?? null;
    return focus && canvas.placedFocus === focusToken() && shown() ? (focusNode(shown()!.nodes, focus)?.turn_id ?? null) : null;
  });
  /**
   * Measurements survive a reload of the same job: a live turn refetches the trace every few
   * seconds, and forgetting what the cards measured would drop the layout back to the fallback
   * height with no size change to correct it. Only a different job is a reason to forget.
   */
  let measuredJob: string | null = null;
  effect(() => {
    const id = job.trace?.id ?? null;
    if (id === measuredJob) return;
    measuredJob = id;
    // A job whose board was left starts from what its cards measured then.
    boxes.set({ ...(untracked(() => keptBoard(job.boardSession ?? props.sessionId, id)?.boxes) ?? {}) });
  });
  const botsById = computed(() => new Map(props.bots.map((bot) => [bot.id, bot])));
  const sessionsById = computed(() => new Map(props.sessions.map((session) => [session.id, session])));
  const ticketsById = computed(() => new Map((job.detail?.tickets ?? []).map((ticket) => [ticket.id, ticket])));
  const routeRepeated = computed(() => (shown() ? routeRepeats(shown()!.nodes) : new Set<string>()));

  const nameOf = (actor: string): string => actorName(actor, botsById(), props.youLabel, props.deletedLabel);
  const place = (node: { session_id: string }): string => placeOf(node, sessionsById(), botsById(), nameOf, props.deletedLabel);

  /**
   * Where a card from another conversation happened, said where the work moved there: a direct's
   * back and forth names the direct on its first card, not on every one (ADR 0094).
   */
  function placeShownOf(node: TaskTraceNode): string | null {
    if (node.session_id === shown()?.session_id) return null;
    const waker = node.woken_by_turn_id ? byId().get(node.woken_by_turn_id) : undefined;
    if (waker && waker.session_id === node.session_id) return null;
    return place(node);
  }

  /** A ticket and a model highlight both light cards; showing both at once would say nothing. */
  function selectTicket(id: string | null): void {
    job.selectedTicket = id;
    if (id) highlight.set(null);
    // What is lit has to be on the board: rounds you folded give way to it.
    if (id) foldChoice.set({});
  }

  function slideTo(turnId: string): void {
    const placed = flow()?.placements.find((placement) => placement.node.turn_id === turnId);
    if (!placed) return;
    const height = boxes()[placed.node.turn_id]?.height ?? 0;
    canvas.centreOn({ x: placed.x + TRACE_CARD_WIDTH / 2, y: placed.y + height / 2 }, true);
  }

  const handle: TraceViewHandle = {
    async showTicket(id) {
      const latest = latestTurnOfTicket(shown()?.nodes ?? [], id);
      selectTicket(id);
      await Promise.resolve();
      if (latest) slideTo(latest.turn_id);
    },
    async showCard(turnId) {
      const root = rounds().find((round) => round.members.some((node) => node.turn_id === turnId))?.root;
      if (root && folded().has(root)) foldChoice.set({ ...foldChoice(), [root]: false });
      await Promise.resolve();
      slideTo(turnId);
    },
    closeRoute() {
      if (!openRoute()) return false;
      openRoute.set(null);
      return true;
    },
    switchBoard(session, next) {
      keepThisBoard();
      const kept = keptBoard(session, next);
      openRoute.set(kept?.openRoute ?? null);
      job.selectedTicket = kept?.selectedTicket ?? null;
      foldChoice.set(kept?.foldChoice ?? {});
      if (kept) {
        notableOnly.set(kept.notableOnly);
        highlight.set(kept.highlight);
      }
    },
  };
  props.onHandle?.(handle);

  function toggleMinimap(): void {
    minimapShown.set(!minimapShown());
    saveTraceMinimap(minimapShown());
  }

  function toggleSteps(): void {
    stepsChoice.set(stepsChoice() === "all" ? "anomalous" : "all");
    saveTraceSteps(stepsChoice());
    // A step no longer drawn has no card for its panel to be about.
    if (job.openStep && !flow()?.steps.some((row) => row.group.id === job.openStep)) job.openStep = null;
  }

  function toggleStepsLit(): void {
    stepsLit.set(!stepsLit());
    if (stepsLit()) {
      highlight.set(null);
      job.selectedTicket = null;
      foldChoice.set({});
    }
  }

  function toggleHighlight(kind: RouteHighlight): void {
    highlight.set(lighting() === kind ? null : kind);
    if (highlight()) {
      stepsLit.set(false);
      job.selectedTicket = null;
      foldChoice.set({});
    }
  }

  const routeInput = () => ({
    bots: props.bots,
    providers: providers(),
    labels: {
      outcome: t().routes.outcome,
      fault: t().routes.fault,
      direction: t().routes.direction,
      signature: t().routes.signature,
      failReason: t().routes.failReason,
      thinking: t().routes.thinking,
      reasonCode: t().routes.reasonCode,
      unknownBot: props.deletedLabel,
    },
  });
  const routeOf = (node: TaskTraceNode): RouteLogRow | null => (node.route ? routeCardRow(node.route, routeInput()) : null);

  function openCard(node: TaskTraceNode): void {
    const messageId = node.approval?.message_id ?? node.ask?.message_id ?? node.focus_message_id;
    props.onJump(node.session_id, messageId);
  }

  /** A file a card handed over opens in the host's preview; the board itself shows no file. */
  function openNodeArtifacts(node: TaskTraceNode): void {
    if (node.artifacts.length === 0 || !props.onOpenArtifact) return;
    const isBundle = node.artifacts.length > 1;
    const siblings: Attachment[] = node.artifacts.map((file) => ({
      id: file.attachment_id,
      message_id: file.message_id,
      workspace_relpath: file.path,
      original_filename: file.path.split("/").pop() || file.path,
      created_at: node.created_at,
      ...(file.exists === undefined ? {} : { exists: file.exists }),
    }));
    const target = firstPreviewable(siblings);
    if (!target) return;
    props.onOpenArtifact(target.workspace_relpath, target, node.focus_message_id || node.trigger_message_id, isBundle, job.currentId ?? props.taskId, siblings);
  }

  const boardStyle = (width: number, height: number) => ({
    // Panned by its position and zoomed by a transform about its corner: the frame stays where the board is drawn.
    left: canvas.view.x,
    top: canvas.view.y,
    width,
    height,
    transformOrigin: "0 0",
    transform: `scale(${canvas.view.scale})`,
  });

  return (
    <View
      testID="trace-pane"
      class="relative w-full h-full min-w-0 min-h-0 overflow-hidden bg-pane"
      onLayout={(e) => paneWidth.set(e.bounds.size.width)}
    >
      {/* A fixed viewport. The board moves under it; every drag in it is a pan. */}
      <View
        testID="trace-viewport"
        role="group"
        accessibilityLabel={t().trace.title}
        class="absolute left-0 top-0 right-0 bottom-0 overflow-hidden"
        ref={(node: ViewRef) => (viewportRef = node)}
        onLayout={(e) => viewportLayout(e.bounds.size)}
        onMouseEnter={measureOrigin}
        {...gestures.panHandlers}
      >
        <If
          when={!(job.loading && !job.trace)}
          else={
            <View testID="trace-loading" role="progressbar" accessibilityLabel={t().trace.loading} class="absolute left-0 top-0 right-0 bottom-0 items-center justify-center" style={{ pointerEvents: "none" }}>
              <View class="w-[20px] h-[20px] rounded-full border-2 border-line" style={{ borderTopColor: token("brand") }} />
            </View>
          }
        >
          <If
            when={!job.failed}
            else={
              <View testID="trace-failed" class="flex-row flex-wrap items-center gap-[8px] px-[12px] py-[24px]">
                <Text class="text-[13px] text-ink-muted">{t().trace.failed}</Text>
                <Button testID="trace-retry" size="sm" variant="secondary" onPress={() => void job.load(job.currentId ?? props.taskId)}>
                  {t().trace.retry}
                </Button>
              </View>
            }
          >
            <If
              when={board()}
              else={
                <Text testID="trace-none" class="px-[12px] py-[24px] text-[13px] text-ink-muted">
                  {t().trace.none}
                </Text>
              }
            >
              {(f: () => TraceFlow) => (
              /* A board the size dagre measured, with the cards placed on it and the lines beneath. */
              <View testID="trace-flow" class="absolute" style={boardStyle(f().width, f().height)}>
                <TraceEdges edges={f().edges} width={f().width} height={f().height} />
                <Each of={f().rounds} key={(round: TraceRoundRow) => round.root}>
                  {(round: () => TraceRoundRow) => (
                    <If when={round().header}>
                      <TraceRound round={round()} ticketsById={ticketsById()} nameOf={nameOf} onToggle={() => toggleRound(round().root)} />
                    </If>
                  )}
                </Each>
                <Each of={f().steps} key={(placement: StepPlacement) => placement.group.id}>
                  {(placement: () => StepPlacement) => (
                    <View
                      class="absolute flex-col items-stretch gap-[8px]"
                      style={{ left: placement().x, top: placement().y, width: TRACE_STEP_WIDTH }}
                      onLayout={(e) => measured(placement().group.id, e.bounds.size)}
                    >
                      <TraceStepCard
                        group={placement().group}
                        open={job.openStep === placement().group.id}
                        lit={stepsLit() && placement().group.anomalous}
                        dim={(stepsLit() && !placement().group.anomalous) || lighting() !== null || job.selectedTicket !== null}
                        onToggle={() => (job.openStep = job.openStep === placement().group.id ? null : placement().group.id)}
                      />
                    </View>
                  )}
                </Each>
                <Each of={f().placements} key={(placement: CardPlacement) => placement.node.turn_id}>
                  {(placement: () => CardPlacement) => {
                    const node = () => placement().node;
                    const litKind = () => highlightOf(node(), lighting());
                    const ticketLight = () => ticketLightOf(node(), job.selectedTicket);
                    const route = computed(() => routeOf(node()));
                    return (
                      <View
                        class="absolute flex-col items-stretch gap-[8px]"
                        style={{ left: placement().x, top: placement().y, width: TRACE_CARD_WIDTH }}
                        onLayout={(e) => measured(node().turn_id, e.bounds.size)}
                      >
                        <TraceCard
                          node={node()}
                          here={node().session_id === props.activeSessionId}
                          focused={focusedTurn() === node().turn_id}
                          lit={litKind() === "lit" || ticketLight() === "lit"}
                          litBlamed={litKind() === "lit" && lighting() === "blamed"}
                          dim={litKind() === "dim" || ticketLight() === "dim" || stepsLit()}
                          name={nameOf(node().actor)}
                          avatar={actorFace(node().actor, botsById(), props.youLabel, props.deletedLabel)}
                          ticket={ticketOf(node(), byId(), ticketsById())}
                          from={node().woken_by_turn_id && byId().has(node().woken_by_turn_id!) ? null : wokenByName(node(), byId(), nameOf)}
                          place={placeShownOf(node())}
                          route={route()}
                          routeCompact={routeCompactOf(node(), route(), routeRepeated())}
                          routeOpen={openRoute() === node().turn_id}
                          onToggleRoute={() => openRoute.set(openRoute() === node().turn_id ? null : node().turn_id)}
                          onOpen={() => openCard(node())}
                          onOpenArtifacts={() => openNodeArtifacts(node())}
                        />
                        <If when={openRoute() === node().turn_id ? route() : null}>
                          {(row: () => RouteLogRow) => (
                            <TraceRouteDetail
                              node={node()}
                              route={row()}
                              providers={providers()}
                              onJump={props.onJump}
                              onClose={() => openRoute.set(null)}
                              onMarkModel={props.api ? async (marked: boolean) => void (await props.api!.markTurnModel(node().turn_id, marked)) : undefined}
                            />
                          )}
                        </If>
                      </View>
                    );
                  }}
                </Each>
              </View>
              )}
            </If>
          </If>
        </If>
      </View>
      <If when={hasTools()}>
        <TraceTools
          narrow={paneWidth() <= 560}
          notableOnly={notableOnly()}
          onNotableOnly={(on) => notableOnly.set(on)}
          highlightCounts={highlightCounts()}
          lighting={lighting()}
          onHighlight={toggleHighlight}
          hasSteps={(job.trace?.steps?.length ?? 0) > 0 && !isLineBoard()}
          stepsShown={stepsShown()}
          onSteps={toggleSteps}
          anomalyCount={anomalyCount()}
          stepsLit={stepsLit()}
          onStepsLit={toggleStepsLit}
          scale={canvas.view.scale}
          zoomMin={TRACE_ZOOM_MIN}
          zoomMax={TRACE_ZOOM_MAX}
          onZoom={(scale) => canvas.zoomTo(scale)}
          onFit={() => canvas.fitBoard()}
          minimapShown={minimapShown()}
          onMinimap={toggleMinimap}
          onHeight={(height) => toolsHeight.set(height)}
        />
      </If>
      {/* Over the corner, above the zoom: the board's ways around sit together. */}
      <If when={minimapShown() && board() && !job.failed && !(job.loading && !job.trace)}>
        <View class="absolute" style={{ right: 10, bottom: 46 }}>
          <TraceMinimap
            flow={board()!}
            view={canvas.view}
            viewport={canvas.viewportSize}
            toneOf={(node) => minimapToneOf(node, lighting(), job.selectedTicket, focusedTurn())}
            hint={t().trace.minimapHint}
            onCentre={(point, glide) => canvas.centreOn(point, glide)}
          />
        </View>
      </If>
    </View>
  );
}
