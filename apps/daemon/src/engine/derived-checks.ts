/**
 * Checks from your words, on the engine's side (ADR 0040 P3). The store keeps them in line with
 * what you said and what was delivered (`store/derived-checks.ts`); this decides when to ask it —
 * once a line or an answer of yours is filed, once a turn of the plan ends, and (through the local
 * API) after you edit the plan on the board or confirm or remove one there — says what changed in
 * the plan's conversation, and measures each as soon as it has a file (an offer's result is shown,
 * never a block). A number read from your words is an offer, and nothing becomes a gate but your 确认
 * — on the board, or on the required-items card that shows what it measured. Only a number that differs from a gate
 * in force asks you on a card of its own, with 确认 / 改 / 不要: until you choose, the gate holds the
 * Bots to the number you said before. Any other offer, said again or not, asked you to confirm what
 * you had just said, so it no longer has a card (2026-10-04); nor has a gate finding its file. 改 is
 * your composer, since your words are what a check stands on.
 */
import { USER_MEMBER, type AcceptanceCheck, type ControlActionResult, type Message, type Turn } from "@real-bot/protocol";
import { editDraft, replacementCardBody } from "../derived-checks";
import { HttpError } from "../errors";
import { derivedChanged, type DerivedChecksChange, type Store } from "../store";

export type DerivedChecksDeps = {
  store: Store;
  publishMessage: (message: Message) => void;
  /** Runs these checks of the plan (the plan-checks runner). */
  run: (taskId: string, checkIds: string[]) => Promise<void>;
  track: <T>(promise: Promise<T>) => Promise<T>;
  renderMirrors: (taskId: string) => void;
  log?: (line: string) => void;
};

export type DerivedChecks = {
  /** Brings the plan's checks from your words in line, tells you what changed, runs what is newly due. */
  sync: (taskId: string) => void;
  /** A line or an answer of yours was filed: its plan's checks may have a new number. */
  noteLine: (messageId: string) => void;
  /** A turn ended: its plan may have a final deliverable now, or your line may be filed by it. */
  noteTurnEnded: (turn: Turn) => void;
  /** You confirmed one (the board): in force, run at once when it has a file, then synced. */
  confirm: (checkId: string) => void;
  /** A button on the app's line about these checks. */
  act: (message: Message, input: { action: unknown }) => ControlActionResult;
};

/** Who a line of the app's is filed under: the Bot in a direct, else you (it shows as the app's either way). */
export function appLineAuthor(store: Store, sessionId: string): string {
  try {
    if (store.getSession(sessionId).kind === "direct") return store.presentBotIds(sessionId)[0] ?? USER_MEMBER;
  } catch {
    // gone; nothing is said there
  }
  return USER_MEMBER;
}

export function createDerivedChecks(deps: DerivedChecksDeps): DerivedChecks {
  const { store, publishMessage, run, track, renderMirrors } = deps;
  const log = deps.log ?? ((line: string) => console.error(line));

  /**
   * The app's lines about a sync, in the plan's conversation when you are in it: one per offer that
   * would replace a gate in force, with its buttons. Everything else a sync changes shows on the
   * board and in the plan's situation, and asks nothing of you.
   */
  function tell(taskId: string, change: DerivedChecksChange): void {
    let sessionId: string | null;
    try {
      sessionId = store.getTask(taskId).session_id;
    } catch {
      return;
    }
    if (!sessionId || !store.isPresent(sessionId, USER_MEMBER)) return;
    const live = store.listChecks(taskId);
    const locale = store.settingsCached().locale;
    const say = (control: Extract<Message["control"], { kind: "check" }>, body: string): void => {
      publishMessage(
        store.insertMessage({
          sessionId: sessionId!,
          kind: "system",
          author: appLineAuthor(store, sessionId!),
          body,
          // For you: the Bots read the checks themselves in the plan's situation.
          hiddenFromBots: true,
          control,
        }),
      );
    };
    // By id, removed ones too: a gate a number replaced is named on the line that says so.
    const named = (ids: readonly string[]): AcceptanceCheck[] =>
      ids.flatMap((id) => {
        try {
          const check = store.getCheck(id);
          return check.measure ? [check] : [];
        } catch {
          return [];
        }
      });
    const gateOf = (check: AcceptanceCheck): AcceptanceCheck | null =>
      live.find((other) => other.id !== check.id && other.derived_state === "active" && other.measure?.dimension === check.measure?.dimension) ?? null;

    // One card per offer that differs from a gate in force, new or said again (with how many times).
    for (const check of named([...change.proposed, ...change.repeated])) {
      if (!live.some((other) => other.id === check.id)) continue;
      const gate = gateOf(check);
      if (!gate?.measure) continue;
      const times = change.counts[check.id] ?? 1;
      say(
        {
          kind: "check",
          event: "proposed",
          check_ids: [check.id],
          offer: ["confirm_check", "edit_check", "remove_check"],
          replacing: gate.id,
          edit_draft: editDraft(check.measure!.dimension, locale),
          ...(times >= 2 ? { times } : {}),
        },
        replacementCardBody(locale, [check.measure!], [gate.measure], times),
      );
    }
  }

  /**
   * Measures the plan's checks from your words among `ids` that have a file, offers as well as gates:
   * an offer's result is shown to you and the Bots (information, never a block).
   */
  function runDue(taskId: string, ids: readonly string[]): void {
    const due = new Set(ids);
    const bound = store
      .listChecks(taskId)
      .filter((check) => due.has(check.id) && check.origin === "derived" && check.bind_kind)
      .map((check) => check.id);
    if (bound.length > 0) void track(run(taskId, bound));
  }

  function sync(taskId: string): void {
    let change: DerivedChecksChange;
    try {
      change = store.syncDerivedChecks(taskId);
    } catch (error) {
      log(`[derived-checks] plan ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!derivedChanged(change)) return;
    try {
      renderMirrors(taskId);
    } catch (error) {
      log(`[derived-checks] plan ${taskId}: could not render mirrors: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      tell(taskId, change);
    } catch (error) {
      log(`[derived-checks] plan ${taskId}: could not say so: ${error instanceof Error ? error.message : String(error)}`);
    }
    // What got a file: each has something new to measure.
    runDue(taskId, change.bound);
  }

  function noteLine(messageId: string): void {
    let taskId: string | null;
    try {
      taskId = store.getMessage(messageId).task_id ?? null;
    } catch {
      return;
    }
    if (taskId) sync(taskId);
  }

  function noteTurnEnded(turn: Turn): void {
    if (turn.task_id) sync(turn.task_id);
  }

  function confirm(checkId: string): void {
    const { taskId, changed } = store.confirmDerivedCheck(checkId);
    if (changed) {
      try {
        renderMirrors(taskId);
      } catch {
        // the plan's folder is gone; the board still reads the store
      }
      runDue(taskId, [checkId]);
    }
    sync(taskId);
  }

  function act(message: Message, input: { action: unknown }): ControlActionResult {
    const control = message.control;
    if (control?.kind !== "check") throw new HttpError(422, "invalid_args", "this line is not about checks");
    const action = input.action;
    if ((action !== "remove_check" && action !== "confirm_check") || !control.offer.includes(action)) {
      throw new HttpError(422, "invalid_args", "this line does not offer that button");
    }
    // One press per line, as on every line with buttons.
    if ((control.acted ?? []).length > 0) return { made: [], lifted: [] };
    const plans = new Set<string>();
    if (action === "confirm_check") {
      // An offer a later number of yours already replaced is gone: the refusal says so, and the line waits.
      store.transaction(() => {
        for (const id of control.check_ids) plans.add(store.confirmDerivedCheck(id).taskId);
        store.setMessageControl(message.id, { ...control, acted: ["confirm_check"] });
      });
      for (const taskId of plans) {
        try {
          renderMirrors(taskId);
        } catch {
          // the plan's folder is gone; the board still reads the store
        }
        runDue(taskId, control.check_ids);
        sync(taskId);
      }
      return { made: [], lifted: [] };
    }
    store.transaction(() => {
      for (const id of control.check_ids) {
        try {
          plans.add(store.getCheck(id).task_id);
          store.removeCheckByUser(id);
        } catch (error) {
          // Removed already, on the board or from another line: nothing more to do for it.
          if (!(error instanceof HttpError) || (error.status !== 409 && error.status !== 404)) throw error;
        }
      }
      store.setMessageControl(message.id, { ...control, acted: ["remove_check"] });
    });
    // Turning down a replacement puts the gate it would replace back in force.
    for (const taskId of plans) sync(taskId);
    for (const taskId of plans) {
      try {
        renderMirrors(taskId);
      } catch {
        // the plan's folder is gone; the board still reads the store
      }
    }
    return { made: [], lifted: [] };
  }

  return { sync, noteLine, noteTurnEnded, confirm, act };
}
