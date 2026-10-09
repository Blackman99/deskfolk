/**
 * The scribe (书记员, ADR 0040 P3), engine side. Once a line of yours is filed under a plan, or you
 * answer a Bot's question in one, one short tool-less call on the default model reads it against
 * the plan's open requirements and proposes a patch to the ledger, which `store/scribe-patch.ts`
 * checks item by item and applies. Nothing waits on it: it starts after the line has woken whom it
 * wakes, and no turn is held back for it.
 *
 * It files nothing it cannot check. With no default model, or a call that fails, stops at its cap or
 * answers with something that is not a patch, or a patch none of whose items survive the checks,
 * the one thing that can still land is the fallback capture: a complaint about a job that had
 * delivered when you said it, kept whole as a proposed entry. Every answer, whatever came of it,
 * goes into the work log as it came back (`scribe.answer`); the call is billed as the organizer's
 * are, keeping the job in order.
 *
 * One line at a time, in the order they were handed over: two answers read against the same open
 * entries would each add what the other already had.
 */
import { NO_ABLATION, type Ablation } from "./ablation";
import type { CompletionsClient, JudgeResult, MappedUsage } from "./completions";
import type { UserLineReading } from "./line-reading";
import type { OrganizerRouting } from "./organizer";
import { parseScribeAnswer, scribeEditPayload, scribePayload, type ScribePayload } from "./prompts/scribe";
import { promptPage } from "./prompts/book";
import { SCRIBE_WRITER, type ScribeOutcome, type Store, type Task, type UserQuote } from "./store";

/** The patch is short, and a line is only as urgent as the ledger it goes into. */
export const SCRIBE_TIMEOUT_MS = 60_000;
/** Room for a few entries and their quotes; a longer answer is a model rewriting, not noting. */
export const SCRIBE_MAX_TOKENS = 800;

export type ScribeDeps = {
  store: Store;
  completions: CompletionsClient;
  /** The default endpoint's default model, resolved when a call is about to be made; null when none is set. */
  routing: () => Promise<OrganizerRouting | null>;
  recordSpend: (input: { sessionId: string; target: OrganizerRouting; usage: MappedUsage | null; responded: boolean }) => void;
  draining: () => boolean;
  /** Where a line that came to nothing says why. Defaults to stderr. */
  log?: (line: string) => void;
  /** Benchmark switches (see `ablation.ts`): `scribe` makes no call, as if it had failed. */
  ablation?: Ablation;
  /** What landed from one line's answer, once it is in the ledger. */
  onFiled?: (quote: UserQuote, outcome: ScribeOutcome) => void;
  /**
   * A line of yours (or your answer), read for what it objects to (ADR 0055): what the fallback
   * capture judges whether it is a complaint by. Absent, the word lists judge it.
   */
  readQuote?: (quote: UserQuote) => Promise<UserLineReading>;
};

/** Which plans had handed something over when a line was said (see `plansHandedOver`). */
export type HandedOver = ReadonlySet<string> | null;

export type Scribe = {
  /**
   * Taken as a line of yours arrives, before its filing or a turn it wakes can send a ticket back
   * over it: what the fallback capture judges the line by, handed back to `noteLine`. Taken for
   * every line: whether the line complains is only known once it is read.
   */
  handedOverAt: () => HandedOver;
  /**
   * A line of yours went through filing and waking; resolves once it is in the ledger or came to
   * nothing. Never rejects. Called again when the line is filed later (a desk segment opening a job
   * for it, `work_on`, your correction): a line read against a plan once is not read again.
   */
  noteLine: (messageId: string, handedOver: HandedOver) => Promise<void>;
  /** You answered a Bot's question; the same, for the answer. Called as the answer lands, before the turn goes on. */
  noteAnswer: (askId: string) => Promise<void>;
  /**
   * You edited a line of yours: after the line's own words are read, the edit is read for the
   * entries it took back, which the board then asks you to retire or keep (ADR 0063, 2026-10-10).
   * Once per edit; no call when the line's earlier words stand behind nothing. Never rejects.
   */
  noteEdit: (editId: string) => Promise<void>;
  /** Shutting down: the call in flight is abandoned and lines still queued are dropped, with nothing written for them. */
  stop: () => void;
};

export function createScribe(deps: ScribeDeps): Scribe {
  const store = deps.store;
  const log = deps.log ?? ((line: string) => console.error(line));
  const ablation = deps.ablation ?? NO_ABLATION;
  let chain: Promise<void> = Promise.resolve();
  /** Bumped by `stop`, so a line queued or in flight before it writes nothing after it. */
  let generation = 0;
  const inFlight = new Set<AbortController>();
  /** Quotes this run has read against a plan (or captured), so a later filing of the same line reads it no second time. */
  const read = new Set<string>();
  /** Edits this run has read, the same way. */
  const editsRead = new Set<string>();

  function handedOverAt(): HandedOver {
    return store.plansHandedOver();
  }

  function enqueue(read: () => UserQuote | readonly UserQuote[] | null, handedOver: HandedOver): Promise<void> {
    const mine = generation;
    const run = chain.then(async () => {
      if (mine !== generation) return;
      try {
        for (const quote of [read() ?? []].flat()) {
          if (mine !== generation) return;
          await scribeOne(quote, mine, handedOver);
        }
      } catch (error) {
        log(`[scribe] ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    chain = run;
    return run;
  }

  /** The fallback capture, when the scribe filed nothing for the line. */
  async function capture(quote: UserQuote, handedOver: HandedOver): Promise<void> {
    const objects = deps.readQuote ? (await deps.readQuote(quote)).objections.length > 0 : undefined;
    const kept = store.captureComplaint(quote, handedOver, objects);
    if (kept) log(`[scribe] quote ${quote.id}: nothing filed, kept the complaint as proposed entry ${kept.id}`);
  }

  function landed(outcome: ScribeOutcome): boolean {
    return outcome.added.length + outcome.raised.length + outcome.proposed.length > 0;
  }

  async function scribeOne(quote: UserQuote, mine: number, handedOver: HandedOver): Promise<void> {
    if (!quote.task_id || quote.redacted_at || !quote.body.trim()) return;
    let task: Task;
    try {
      task = store.getTask(quote.task_id);
    } catch {
      return;
    }
    if (deps.draining()) return;
    // Once per line: filed when it arrived and again later, or noted twice, it is read once (its
    // answer is in the work log as `scribe.answer`, which a restart keeps).
    if (read.has(quote.id) || store.quoteScribed(quote.id)) return;
    read.add(quote.id);
    if (ablation.has("scribe")) return capture(quote, handedOver);
    const routing = await deps.routing().catch(() => null);
    if (mine !== generation) return;
    if (!routing) return capture(quote, handedOver);
    const { payload, offered } = scribePayload(store, quote, task);
    const answer = await ask({ routing, payload, sessionId: quote.session_id, taskId: task.id, mine, about: { quote: quote.id } });
    if (!answer) return;
    const { patch, fail } = answer;
    if (!patch) {
      log(`[scribe] quote ${quote.id}: ${fail ? `the call failed (${fail})` : "the answer did not read as a patch"}, nothing filed`);
      return capture(quote, handedOver);
    }
    // Read again: what you said may have been erased, or filed elsewhere, while the call was out.
    const now = store.getQuote(quote.id);
    if (!now || now.redacted_at || now.task_id !== quote.task_id) return;
    const outcome = store.applyScribePatch({ quote: now, offered: offered.map((entry) => entry.id), patch });
    if (!landed(outcome)) return capture(now, handedOver);
    deps.onFiled?.(now, outcome);
  }

  /**
   * One scribe call on `payload`, its spend recorded and its answer logged as `scribe.answer` (with
   * `about`, which says what it read); null when `stop` came while it was out.
   */
  async function ask(input: {
    routing: OrganizerRouting;
    payload: ScribePayload;
    sessionId: string | null;
    taskId: string;
    mine: number;
    about: { quote: string } | { edit: string };
  }): Promise<{ patch: ReturnType<typeof parseScribeAnswer>; fail: string | null } | null> {
    const { routing } = input;
    const prompt = promptPage(store, "zh").resolve("call.scribe");
    const controller = new AbortController();
    inFlight.add(controller);
    let result: JudgeResult | null = null;
    let threw: string | null = null;
    try {
      result = await deps.completions.judge({
        baseUrl: routing.baseUrl,
        apiKey: routing.apiKey,
        apiFormat: routing.apiFormat,
        workspaceId: routing.workspaceId,
        model: routing.model,
        prompt: prompt.ref,
        messages: [
          { role: "system", content: prompt.text },
          { role: "user", content: JSON.stringify(input.payload) },
        ],
        signal: controller.signal,
        timeoutMs: SCRIBE_TIMEOUT_MS,
        maxTokens: SCRIBE_MAX_TOKENS,
      });
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    } finally {
      inFlight.delete(controller);
    }
    if (input.mine !== generation) return null;
    if (result && input.sessionId) {
      try {
        deps.recordSpend({
          sessionId: input.sessionId,
          target: routing,
          usage: result.usage,
          responded: result.failKind === null || result.failKind === "incomplete",
        });
      } catch {
        // the ledger of spend is best-effort; the answer still counts
      }
    }
    const fail = threw !== null
      ? "call_error"
      : result!.failKind && result!.failKind !== "incomplete"
        ? result!.failKind
        : result!.truncated
          ? "truncated"
          : null;
    const patch = fail ? null : parseScribeAnswer(result!.content ?? "");
    if (!fail && !patch) {
      store.notePromptParseFailure({ prompt: prompt.ref.id, locale: prompt.ref.locale, revision: prompt.ref.revision_id, reason: "unreadable", sessionId: input.sessionId, taskId: input.taskId });
    }
    store.recordWorkEvent({
      kind: "scribe.answer",
      actor: SCRIBE_WRITER,
      taskId: input.taskId,
      sessionId: input.sessionId,
      payload: { ...input.about, model: routing.model, fail: fail ?? (patch ? null : "unreadable"), raw: result?.content ?? null },
    });
    return { patch, fail };
  }

  /** One edit of yours, read for the entries it took back (see `noteEdit`). */
  async function scribeEdit(editId: string, mine: number): Promise<void> {
    const edit = store.getMessageEdit(editId);
    if (!edit || editsRead.has(editId) || store.editScribed(editId)) return;
    let task: Task;
    let sessionId: string | null;
    try {
      const line = store.getMessage(edit.message_id);
      if (!line.task_id) return;
      sessionId = line.session_id;
      task = store.getTask(line.task_id);
    } catch {
      return;
    }
    if (deps.draining()) return;
    const earlier = store.editEarlierEntries(edit.message_id);
    editsRead.add(editId);
    if (earlier.length === 0 || ablation.has("scribe")) return;
    const routing = await deps.routing().catch(() => null);
    if (mine !== generation || !routing) return;
    const payload = scribeEditPayload(store, { edit: { before: edit.body_before, after: edit.body_after, at: edit.created_at }, sessionId, task, earlier });
    const answer = await ask({ routing, payload, sessionId, taskId: task.id, mine, about: { edit: editId } });
    if (!answer?.patch) {
      if (answer) log(`[scribe] edit ${editId}: ${answer.fail ? `the call failed (${answer.fail})` : "the answer did not read as a patch"}, nothing marked`);
      return;
    }
    const marked = store.proposeEditWithdrawals({ edit, taskId: task.id, sessionId, offered: earlier.map((entry) => entry.id), withdraws: answer.patch.withdraws ?? [] });
    if (marked.length > 0) log(`[scribe] edit ${editId}: asked about ${marked.length} entr${marked.length === 1 ? "y" : "ies"} its words took back`);
  }

  return {
    handedOverAt,
    // Every quote of the line, oldest first: the line as you sent it, then the words you changed in it
    // (ADR 0063). Each is read once, so a change that lands before the line's turn in the queue
    // leaves nothing of the line unread.
    noteLine: (messageId, handedOver) => enqueue(() => store.listQuotes({ messageId }).filter((quote) => quote.via === "message"), handedOver),
    noteAnswer: (askId) => {
      // Read here: the turn the answer resumes has not run on yet.
      const answer = store.quoteOfMessage(askId, "ask_answer");
      return enqueue(() => store.quoteOfMessage(askId, "ask_answer"), answer ? handedOverAt() : null);
    },
    noteEdit: (editId) => {
      const mine = generation;
      const run = chain.then(async () => {
        if (mine !== generation) return;
        try {
          await scribeEdit(editId, mine);
        } catch (error) {
          log(`[scribe] ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      chain = run;
      return run;
    },
    stop() {
      generation += 1;
      for (const controller of inFlight) controller.abort();
    },
  };
}
