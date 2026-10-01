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
import { soundsLikeComplaint } from "./complaint-words";
import type { CompletionsClient, JudgeResult, MappedUsage } from "./completions";
import type { OrganizerRouting } from "./organizer";
import { parseScribeAnswer, SCRIBE_SYSTEM, scribePayload } from "./prompts/scribe";
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
};

/** Which plans had handed something over when a line was said (see `plansHandedOver`); null when the line is no complaint. */
export type HandedOver = ReadonlySet<string> | null;

export type Scribe = {
  /**
   * Taken as a line of yours arrives, before its filing or a turn it wakes can send a ticket back
   * over it: what the fallback capture judges the line by, handed back to `noteLine`.
   */
  handedOverAt: (body: string) => HandedOver;
  /** A line of yours went through filing and waking; resolves once it is in the ledger or came to nothing. Never rejects. */
  noteLine: (messageId: string, handedOver: HandedOver) => Promise<void>;
  /** You answered a Bot's question; the same, for the answer. Called as the answer lands, before the turn goes on. */
  noteAnswer: (askId: string) => Promise<void>;
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

  function handedOverAt(body: string): HandedOver {
    return soundsLikeComplaint(body) ? store.plansHandedOver() : null;
  }

  function enqueue(read: () => UserQuote | null, handedOver: HandedOver): Promise<void> {
    const mine = generation;
    const run = chain.then(async () => {
      if (mine !== generation) return;
      try {
        const quote = read();
        if (quote) await scribeOne(quote, mine, handedOver);
      } catch (error) {
        log(`[scribe] ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    chain = run;
    return run;
  }

  /** The fallback capture, when the scribe filed nothing for the line. */
  function capture(quote: UserQuote, handedOver: HandedOver): void {
    const kept = store.captureComplaint(quote, handedOver);
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
    if (ablation.has("scribe")) return capture(quote, handedOver);
    const routing = await deps.routing().catch(() => null);
    if (mine !== generation) return;
    if (!routing) return capture(quote, handedOver);
    const { payload, offered } = scribePayload(store, quote, task);
    const controller = new AbortController();
    inFlight.add(controller);
    let result: JudgeResult | null = null;
    let threw: string | null = null;
    try {
      result = await deps.completions.judge({
        baseUrl: routing.baseUrl,
        apiKey: routing.apiKey,
        model: routing.model,
        messages: [
          { role: "system", content: SCRIBE_SYSTEM },
          { role: "user", content: JSON.stringify(payload) },
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
    if (mine !== generation) return;
    if (result && quote.session_id) {
      try {
        deps.recordSpend({
          sessionId: quote.session_id,
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
    store.recordWorkEvent({
      kind: "scribe.answer",
      actor: SCRIBE_WRITER,
      taskId: task.id,
      sessionId: quote.session_id,
      payload: { quote: quote.id, model: routing.model, fail: fail ?? (patch ? null : "unreadable"), raw: result?.content ?? null },
    });
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

  return {
    handedOverAt,
    noteLine: (messageId, handedOver) => enqueue(() => store.quoteOfMessage(messageId, "message"), handedOver),
    noteAnswer: (askId) => {
      // Read here: the turn the answer resumes has not run on yet.
      const answer = store.quoteOfMessage(askId, "ask_answer");
      return enqueue(() => store.quoteOfMessage(askId, "ask_answer"), answer ? handedOverAt(answer.body) : null);
    },
    stop() {
      generation += 1;
      for (const controller of inFlight) controller.abort();
    },
  };
}
