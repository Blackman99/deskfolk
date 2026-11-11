/**
 * The spec panel's state and the calls it makes (`overlays/PlanSpecPanel.svelte`'s script): which
 * field is being edited and its draft, saving a field or the name, the job's scale, the checks'
 * run-all, and the spec's version history. Every call goes through the runtime client and the plan
 * comes back whole (`onSaved`).
 */
import { signal, type ViewRef } from "nsh";
import type { Bot, TaskDetail, TaskSpecRevision, TicketStatus } from "@real-bot/protocol";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { parseSpecLines, specLines, specWithGoal, specWithLines, type SpecListField } from "../../m/overlays/plan-board.ts";
import { copy } from "../../runtime";
import { doneFoldedByDefault, errorStatus, type Editing } from "./plan-spec-panel";

export type PlanSpecPanelProps = {
  api: MessengerApi | null;
  /** `detail.spec` may be null: the organizer has not run yet. */
  detail: TaskDetail;
  /** The saved plan comes back whole; the parent replaces its copy. */
  onSaved: (detail: TaskDetail) => void;
  /** A 409: the parent reloads the plan. */
  onConflict: () => void;
  onJump: (sessionId: string, messageId: string) => void;
  /**
   * The ticket picked on the board. Every ticket meets this spec; with one picked, the lines held
   * to it alone stand out and those held to another ticket alone step back.
   */
  selectedTicket?: string | null;
  /** Show one ticket in the tickets panel, picked: a line held to it names it. */
  onShowTicket?: (ticketId: string) => void;
  /** Put the picked ticket down. */
  onClearTicket?: () => void;
  /** Open the tickets panel, on one status or on all. */
  onShowTickets?: (status: TicketStatus | "all") => void;
  /** The Bots, for the name on a retrospective (ADR 0062). */
  bots?: readonly Bot[];
  deletedLabel?: string;
  /**
   * Scroll the proposed requirements group (the one 「待你确认」 names) into view: the panel never
   * scrolls itself, so its parent does, given the group's view. Absent, the line is plain text.
   */
  onScrollToProposed?: (target: ViewRef) => void;
};

export type PlanSpecState = ReturnType<typeof createPlanSpecState>;

export function createPlanSpecState(props: PlanSpecPanelProps) {
  const t = () => copy();
  const editing = signal<Editing | null>(null);
  const draft = signal("");
  const saving = signal(false);
  const saveError = signal<string | null>(null);

  const historyOpen = signal(false);
  const historyLoading = signal(false);
  const historyFailed = signal(false);
  const history = signal<TaskSpecRevision[]>([]);
  let historyKey: string | null = null;

  const addingCheck = signal(false);
  const runningAll = signal(false);
  const runError = signal<string | null>(null);

  /** Just renamed: the goal, which the Bots work to, said beside the new name until you edit it or leave. */
  const renamed = signal(false);
  const scaleSaving = signal(false);

  /** Null while nobody pressed the fold: it follows what is open. */
  const doneOpen = signal<boolean | null>(null);
  const doneShown = () => doneOpen() ?? !doneFoldedByDefault(props.detail.spec);

  function startEditTitle(): void {
    editing.set("title");
    draft.set(props.detail.title);
    saveError.set(null);
  }

  function startEditGoal(): void {
    if (!props.detail.spec) return;
    renamed.set(false);
    editing.set("goal");
    draft.set(props.detail.spec.goal);
    saveError.set(null);
  }

  function startEditField(field: SpecListField): void {
    if (!props.detail.spec) return;
    editing.set(field);
    draft.set(specLines(props.detail.spec, field).join("\n"));
    saveError.set(null);
  }

  function cancelEdit(): void {
    editing.set(null);
    draft.set("");
    saveError.set(null);
  }

  /** Your new name for the job: only the name, never the spec, so no revision guard is needed. */
  async function saveTitle(): Promise<void> {
    if (!props.api || editing() !== "title" || saving()) return;
    if (!draft().trim()) {
      saveError.set(t().plan.saveFailed);
      return;
    }
    saving.set(true);
    saveError.set(null);
    try {
      props.onSaved(await props.api.renamePlan(props.detail.id, { title: draft() }));
      editing.set(null);
      draft.set("");
      renamed.set(Boolean(props.detail.spec?.goal.trim()));
    } catch {
      saveError.set(t().plan.saveFailed);
    } finally {
      saving.set(false);
    }
  }

  /** Your word on the job's size (ADR 0060): large, laid out with a sample first; or no need. */
  async function setScale(scale: "large" | "single"): Promise<void> {
    if (!props.api || scaleSaving()) return;
    scaleSaving.set(true);
    saveError.set(null);
    try {
      props.onSaved(await props.api.setPlanScale(props.detail.id, { scale }));
    } catch {
      saveError.set(t().plan.saveFailed);
    } finally {
      scaleSaving.set(false);
    }
  }

  async function save(): Promise<void> {
    const field = editing();
    if (field === "title") return saveTitle();
    const spec = props.detail.spec;
    if (!props.api || !spec || field === null || saving()) return;
    const nextSpec = field === "goal" ? specWithGoal(spec, draft()) : specWithLines(spec, field, parseSpecLines(draft()));
    saving.set(true);
    saveError.set(null);
    try {
      props.onSaved(await props.api.patchTaskSpec(props.detail.id, { spec: nextSpec, if_revision: props.detail.revision }));
      editing.set(null);
      draft.set("");
    } catch (err) {
      if (errorStatus(err) === 409) {
        saveError.set(t().plan.conflict);
        props.onConflict();
      } else {
        saveError.set(t().plan.saveFailed);
      }
    } finally {
      saving.set(false);
    }
  }

  async function toggleHistory(): Promise<void> {
    if (!props.api) return;
    historyOpen.set(!historyOpen());
    if (!historyOpen()) return;
    const key = `${props.detail.id}:${props.detail.revision}`;
    if (historyKey === key) return;
    historyKey = key;
    historyLoading.set(true);
    historyFailed.set(false);
    try {
      history.set(await props.api.taskSpecRevisions(props.detail.id));
    } catch {
      historyFailed.set(true);
    } finally {
      historyLoading.set(false);
    }
  }

  async function runAllChecks(): Promise<void> {
    if (!props.api || runningAll()) return;
    runningAll.set(true);
    runError.set(null);
    try {
      props.onSaved(await props.api.runChecks(props.detail.id));
    } catch {
      runError.set(t().plan.checks.runFailed);
    } finally {
      runningAll.set(false);
    }
  }

  function openAddCheck(): void {
    addingCheck.set(true);
    runError.set(null);
  }

  function checkSaved(result: TaskDetail): void {
    addingCheck.set(false);
    props.onSaved(result);
  }

  return {
    editing,
    draft,
    saving,
    saveError,
    historyOpen,
    historyLoading,
    historyFailed,
    history,
    addingCheck,
    runningAll,
    runError,
    renamed,
    scaleSaving,
    doneOpen,
    doneShown,
    startEditTitle,
    startEditGoal,
    startEditField,
    cancelEdit,
    saveTitle,
    setScale,
    save,
    toggleHistory,
    runAllChecks,
    openAddCheck,
    checkSaved,
  };
}
