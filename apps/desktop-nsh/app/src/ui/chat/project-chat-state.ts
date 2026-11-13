/**
 * What a project session's conversation reads of the runtime (the script of `ProjectChat.svelte`
 * apart from its composer's keys and scrolling): the lines, the run going on and the approval it
 * waits on, the agent's whose session it is, the tuning of its account, model and thinking level,
 * plan mode, what it runs beside its reply (tasks, commands, steps), what Stop offers, where a
 * path the agent cites opens, and the annotations a line of yours sent (ADR 0095 decision 28).
 * Accessors that stay live; the pieces of the screen read them.
 */
import { computed, effect, signal, untracked } from "nsh";
import {
  isHiddenTranscriptKind,
  PLAN_APPROVAL_KIND,
  PROJECT_AGENT_CAPS,
  USER_MEMBER,
  type AgentRunTask,
  type Annotation,
  type Attachment,
  type Message,
  type PatchProjectSessionRequest,
  type SessionSummary,
} from "@real-bot/protocol";
import { annotationsByMessage } from "../../m/annotations/model.ts";
import { ProjectCitedPaths } from "../../m/chat/project-cited-path.ts";
import { accountChoices, claudeStatus, loadAgentsStatus, loadClaudeStatus } from "../../m/chat/project-agent-options.svelte.ts";
import { isCommandTask, placeTasks, sessionTasks, taskCommandRow, taskStepRow, type TaskStopItem } from "../../m/chat/project-tasks.ts";
import { describeStep, stepRow, type StepRow } from "../../m/chat/turn-activity.ts";
import { loadClaudeModels } from "../../m/claude-models.svelte.ts";
import { isLiveRun, projectAgentOf } from "../../m/sidebar/project-groups.ts";
import { showToast } from "../../m/toast.svelte.ts";
import { copy, runtime } from "../../runtime";
import { citedOnDisk, onThisComputer, type FileOnDisk } from "../file-on-disk";

export type LineKind = "you" | "agent" | "app";

export function lineOf(message: Message): LineKind {
  if (message.kind === "system" || message.author === "app") return "app";
  return message.author === USER_MEMBER ? "you" : "agent";
}

export function createProjectState(selected: () => SessionSummary, onOpenArtifact: (relpath: string, att?: Attachment, messageId?: string) => void) {
  const t = () => copy();
  const snapshot = () => runtime.snapshot;
  const sessionId = computed(() => selected().id);
  const view = () => runtime.sessionView(selected().id);
  const locale = (): "en" | "zh" => (snapshot().settings.locale === "en" ? "en" : "zh");
  const connected = () => runtime.connection === "connected";
  const run = () => snapshot().agentRuns[selected().id] ?? null;
  const live = () => isLiveRun(run());
  const waiting = () => {
    const r = run();
    return r?.status === "waiting_approval" && r.approval ? r.approval : null;
  };
  const planWaiting = () => waiting()?.kind_key === PLAN_APPROVAL_KIND;

  /** Oldest first; what the app keeps out of a transcript stays out. */
  const lines = computed(() =>
    snapshot()
      .messages.filter((m) => m.session_id === selected().id && !isHiddenTranscriptKind(m.kind) && !m.withdrawn_at)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1)),
  );

  // The snapshot holds live runs and events carry changes; how the last run ended is read once here.
  effect(() => {
    const id = sessionId();
    if (connected()) untracked(() => void runtime.loadProjectRun(id));
  });

  // --- whose session it is, and its tuning ---
  const account = () => selected().project_config_dir ?? "";
  /** A Codex session has no account to pick and no plan mode (ADR 0099). */
  const agent = () => projectAgentOf(selected());
  const caps = () => PROJECT_AGENT_CAPS[agent()];
  const agentName = () => t().project.agentNames[agent()];
  // Asked once each; untracked, so what the asking writes does not ask again.
  effect(() => {
    const api = runtime.client;
    const codex = agent() === "codex";
    untracked(() => void (codex ? loadAgentsStatus(api) : loadClaudeStatus(api)));
  });
  effect(() => {
    const api = runtime.client;
    const dir = account() || null;
    if (agent() === "claude_code") untracked(() => void loadClaudeModels(api, dir));
  });
  const accountOptions = () => accountChoices(claudeStatus(), account(), t().project.defaultAccount);
  /** Picked only with a second account to pick, or the session already on one. */
  const accountShown = () => caps().accounts && accountOptions().length > 1;
  const tuneFailed = signal(false);
  const accountRefused = signal(false);
  async function tune(change: PatchProjectSessionRequest): Promise<void> {
    const failure = await runtime.tuneProjectSession(selected().id, change);
    accountRefused.set(failure?.status === 409 && change.config_dir !== undefined);
    tuneFailed.set(failure !== null && !accountRefused());
  }
  /** Plan mode (ADR 0098), the session's own: its runs start in it. */
  const planning = () => selected().project_mode === "plan";
  function togglePlan(): void {
    if (connected() && caps().plan) void tune({ mode: planning() ? null : "plan" });
  }

  // --- the working bubble's clock, commands and steps ---
  const nowMs = signal(Date.now());
  effect(() => {
    if (!live()) return;
    const timer = setInterval(() => nowMs.set(Date.now()), 250);
    return () => clearInterval(timer);
  });

  /** What it runs beside its reply (ADR 0095, 25): the run's own come with its events, the rest are read when that changes. */
  const tasksRead = signal<AgentRunTask[]>([]);
  const finishedTasks = () => (run()?.tasks ?? []).filter((task) => task.status !== "running").length;
  effect(() => {
    const api = runtime.client;
    const id = sessionId();
    void run()?.id;
    void run()?.status;
    void finishedTasks();
    if (!api || !connected()) return;
    let gone = false;
    void (async () => {
      try {
        const list = await api.projectTasks(id);
        if (!gone) tasksRead.set(list);
      } catch {
        // A daemon from before these: the run's own list still shows.
      }
    })();
    return () => {
      gone = true;
    };
  });
  const tasks = computed(() => sessionTasks(run(), tasksRead()));
  const taskCalls = computed(() => new Set(tasks().flatMap((task) => (task.tool_use_id ? [task.tool_use_id] : []))));
  const liveTasks = computed(() => {
    const r = run();
    return r && live() ? tasks().filter((task) => task.run_id === r.id) : [];
  });
  const goingTasks = computed(() => liveTasks().filter((task) => task.status === "running"));
  const agentLines = computed(() => lines().filter((message) => lineOf(message) === "agent"));
  const placed = computed(() => placeTasks(tasks(), agentLines(), live() ? (run()?.id ?? null) : null, view().hasOlderMessages ? (lines()[0]?.created_at ?? null) : null));
  const keptRow = (task: AgentRunTask) => taskCommandRow(task, t().project.taskStatus.stopped);
  /** A run over: what a line hosts of its commands, in its card. */
  const keptRows = (hosted: readonly AgentRunTask[]) => hosted.filter((task) => isCommandTask(task) && !liveTasks().includes(task)).map(keptRow);

  const stepLine = () => {
    void runtime.toolRevision;
    const r = run();
    // With its reply done the agent itself is doing nothing; a task's call is the list's, not the agent's step.
    const step = r && live() && !r.idle ? runtime.stepOf(r.id) : null;
    return step && !taskCalls().has(step.id) ? describeStep(step, t().chat.activity, nowMs()) : null;
  };
  const commandRows = () => {
    void runtime.activityRevision;
    const r = run();
    if (!r || !live()) return [];
    const own = runtime.activity.forTurn(r.id).filter((row) => !taskCalls().has(row.id.slice(r.id.length + 1)));
    return [...own, ...liveTasks().filter((task) => isCommandTask(task) && task.status !== "running").map(keptRow)];
  };

  const subagentOpen = signal<string | null>(null);
  const subagentShown = () => {
    const id = subagentOpen();
    return id ? (tasks().find((task) => task.id === id) ?? null) : null;
  };
  /** What a working bubble's last line opens onto: only what is going on now. */
  const stepsOpen = signal(false);
  const nowRows = (): StepRow[] => {
    void runtime.toolRevision;
    const r = run();
    if (!r || !live()) return [];
    const steps = r.idle ? [] : runtime.stepsOf(r.id).filter((step) => step.running && !taskCalls().has(step.id)).map((step) => stepRow(step, t().chat.activity, nowMs()));
    return [...steps, ...goingTasks().map((task) => taskStepRow(task, t().project.taskDoing[task.kind], nowMs(), task.kind === "subagent" ? () => subagentOpen.set(task.id) : undefined))];
  };
  const footOpens = () => goingTasks().length > 0 || nowRows().length > 1;

  /** Stop stays in the composer. With tasks going it is a menu: everything, or one of them. */
  const stopItems = (): TaskStopItem[] => {
    if (goingTasks().length === 0) return [];
    return [
      { key: "run", label: t().project.stopAll, task: null },
      ...goingTasks().map((task) => ({ key: `task:${task.id}`, label: t().project.stopTask(task.description || (task.command ?? task.id)), task })),
    ];
  };
  function pickStop(item: TaskStopItem): Promise<unknown> | void {
    const r = run();
    if (!r) return;
    return item.task ? runtime.stopAgentTask(item.task.run_id, item.task.id) : runtime.stopAgentRun(r.id);
  }

  // Another conversation starts clean.
  effect(() => {
    void sessionId();
    untracked(() => {
      tasksRead.set([]);
      stepsOpen.set(false);
      subagentOpen.set(null);
    });
  });

  // --- the approval it waits on, and Stop ---
  const answerFailed = signal(false);
  const answering = signal(false);
  async function answer(allow: boolean): Promise<void> {
    const r = run();
    if (!r || answering()) return;
    answering.set(true);
    answerFailed.set(false);
    const failure = await runtime.answerAgentRun(r.id, allow);
    answering.set(false);
    // null is also what a dropped link answers; the run's own event says what became of it.
    answerFailed.set(failure !== null);
  }
  async function stop(): Promise<void> {
    const r = run();
    if (r) answerFailed.set((await runtime.stopAgentRun(r.id)) !== null);
  }

  // --- a path the agent cites ---
  const citedPaths = new ProjectCitedPaths(() => runtime.client);
  /**
   * The agent's paths are relative to where it was working, not to the workspace, so the Mac says
   * where one is before it opens; one it cannot place is said, not opened.
   */
  function openCited(path: string, messageId?: string): void {
    const pending = citedPaths.resolve(selected().id, path);
    if (!pending) {
      onOpenArtifact(path, undefined, messageId);
      return;
    }
    void pending.then((answer) => {
      if (answer.path !== null) onOpenArtifact(answer.path, undefined, messageId);
      else showToast(answer.matches > 1 ? t().project.citedAmbiguous(path, answer.matches) : t().project.citedMissing(path), { tone: "info" });
    });
  }
  /**
   * Where a path the agent cites is on this computer, for its chip's menu: placed as `openCited`
   * places it. A lookup that failed answers the path as written, which says nowhere on its own.
   */
  async function locateCited(path: string): Promise<string | null> {
    const answer = (await citedPaths.resolve(selected().id, path)) ?? { path };
    const abs = answer.path === null ? null : await citedOnDisk(answer.path);
    if (abs === null) {
      const several = answer.path === null && answer.matches > 1;
      showToast(several ? t().project.citedAmbiguous(path, answer.matches) : t().project.citedMissing(path), { tone: "info" });
    }
    return abs;
  }
  const citedFiles: FileOnDisk = { locate: locateCited };
  /** The files the agent's lines name, where this window can open them (`MarkdownBody`'s `files`). */
  const files = (): FileOnDisk | undefined => (onThisComputer() ? citedFiles : undefined);

  // --- annotations: a batch you sent is a line of yours with its cards, as in a Bot's conversation ---
  const annotationIndex = computed(() => annotationsByMessage(snapshot().annotations));
  const annotationsOf = (messageId: string): Annotation[] | undefined => annotationIndex().get(messageId);
  const cardErrors = signal<Record<string, string>>({});
  /** Only you mark one handled here: the agent has no tool for it. */
  async function toggleAnnotation(messageId: string, row: Annotation, status: "open" | "resolved"): Promise<void> {
    const failed = await runtime.patchAnnotation(row.id, { status });
    const { [messageId]: _dropped, ...rest } = cardErrors();
    cardErrors.set(failed ? { ...rest, [messageId]: t().stream.annotationSaveFailed } : rest);
  }
  /** A card opens its file at the note, from the agent line it hangs on. */
  function openAnnotation(row: Annotation): void {
    // Through null, so opening the card that already has focus goes to it again.
    runtime.annotationFocusId = null;
    runtime.annotationFocusId = row.id;
    onOpenArtifact(row.relpath, undefined, row.target_message_id);
  }

  return {
    snapshot,
    sessionId,
    view,
    locale,
    connected,
    run,
    live,
    waiting,
    planWaiting,
    lines,
    account,
    agent,
    caps,
    agentName,
    accountOptions,
    accountShown,
    tuneFailed,
    accountRefused,
    tune,
    planning,
    togglePlan,
    nowMs,
    tasks,
    goingTasks,
    placed,
    keptRows,
    stepLine,
    commandRows,
    subagentOpen,
    subagentShown,
    stepsOpen,
    nowRows,
    footOpens,
    stopItems,
    pickStop,
    answerFailed,
    answering,
    answer,
    stop,
    openCited,
    files,
    annotationsOf,
    cardErrors,
    toggleAnnotation,
    openAnnotation,
  };
}

export type ProjectState = ReturnType<typeof createProjectState>;
