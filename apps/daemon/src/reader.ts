/**
 * 读句 (ADR 0055), engine side: one short tool-less call on the default model reads a line for what
 * the app acts on, before it acts. A line of yours is read once per message, with the line it
 * answers and the few before it; a Bot's line once per text, on its own. Everything that asks about
 * the same line shares the one call: the control line, the status answer and the rework card read
 * one reading of yours; the closing check, the end contract, `send_message` and a words hand-over
 * one reading of the Bot's.
 *
 * When no model can read it — no default model, the call failed, ran past its time or answered
 * with something that is not a reading — the line is read by the old word lists instead
 * (`line-reading.ts`), and the work log says so.
 *
 * Which job a line of yours is about (ADR 0057) is a call of its own, made beside the first and
 * shown the jobs the line may be about. It has no word lists behind it: a line no model could
 * place is left for the Bot's desk, where the Bot chooses. Every reading goes into the work log
 * as `reader.answer`, with the model's answer as it came back; the call is billed as the
 * organizer's are, with its own purpose. Nothing here writes state but those two rows.
 */
import { createHash } from "node:crypto";
import { USER_MEMBER, type Message } from "@real-bot/protocol";
import { NO_ABLATION, type Ablation } from "./ablation";
import type { CompletionsClient, JudgeResult, MappedUsage } from "./completions";
import {
  botLineByWords,
  UNREAD_FILING,
  UNREAD_SCALE,
  type ScaleReading,
  userLineByWords,
  type BotLineContext,
  type BotLineReading,
  type FilingReading,
  type UserLineReading,
} from "./line-reading";
import type { OrganizerRouting } from "./organizer";
import {
  botLinePayload,
  filingPayload,
  parseBotLineAnswer,
  parseFilingAnswer,
  parseUserLineAnswer,
  parseScaleAnswer,
  scalePayload,
  userLinePayload,
} from "./prompts/reader";
import { promptPage } from "./prompts/book";
import { isStatusQuestion, statusQuestionShape } from "./status-question";
import type { Store } from "./store";

/**
 * How long the app waits for a reading, queueing for a slot included. A line of yours waits on it
 * before it wakes anyone, so past this it is read by the word lists rather than held up further.
 */
export const READER_TIMEOUT_MS = 20_000;
/** Room for a short JSON answer and the reasoning a thinking model spends before it (256 cut such answers off). */
export const READER_MAX_TOKENS = 1024;
/** The lines before yours a reading sees. */
const RECENT_LINES = 3;
/** Readings kept for lines asked about again; the oldest go first. */
const CACHE_MAX = 500;
/** As much of the model's answer as the work log keeps. */
const RAW_MAX = 1000;

/** The work log's writer for a reading. */
export const READER_WRITER = "reader";

export type ReaderDeps = {
  store: Store;
  completions: CompletionsClient;
  /**
   * The default endpoint's default model, resolved when a call is about to be made; null when none
   * is set. Its `thinkingLevel` is sent with the reading: the lightest the model lists, since a line
   * of yours waits on the reading before it wakes anyone.
   */
  routing: () => Promise<OrganizerRouting | null>;
  recordSpend: (input: { sessionId: string; target: OrganizerRouting; usage: MappedUsage | null; responded: boolean }) => void;
  draining: () => boolean;
  /** Benchmark switches (see `ablation.ts`): `reader` makes no call, as if it had failed. */
  ablation?: Ablation;
  timeoutMs?: number;
  log?: (line: string) => void;
};

export type Reader = {
  /** A line of yours, read once. Never rejects: what no model can read, the word lists do. */
  userLine: (message: Message) => Promise<UserLineReading>;
  /** Your answer to a Bot's question, read like a line of yours with nothing around it; `key` names it for the cache. */
  userText: (key: string, body: string, sessionId: string | null) => Promise<UserLineReading>;
  /** A Bot's line, read once per text and the line it answers (`context`). Never rejects. */
  botLine: (body: string, sessionId: string | null, context?: BotLineContext) => Promise<BotLineReading>;
  /**
   * Which job a line of yours is about (ADR 0057), read once. Null when there is nothing to read:
   * a locked signal places the line, it is only a stop or a go on, or no job is open for it. Never
   * rejects; what no model could read comes back `unread`, for the Bot's desk.
   */
  filing: (message: Message) => Promise<FilingReading | null>;
  /**
   * Whether a job is a large one (ADR 0060), read from your lines about it — and, when the signal
   * asks, the facts of how it has gone — once per `key`. Never rejects; what no model could read
   * comes back `unread`.
   */
  scale: (input: { key: string; sessionId: string | null; title: string; goal: string | null; said: readonly string[];
    facts?: { segments: number; handedBack: number } | null }) => Promise<ScaleReading>;
  /**
   * A line of yours was changed (ADR 0063): what it was read as, and which job it was read to be
   * about, are of words it no longer has. Anything that reads it from now on reads it as it is.
   */
  forget: (messageId: string) => void;
  /** Shutting down: calls in flight are abandoned, and read by the word lists. */
  stop: () => void;
};

type Asked<T> = {
  key: string;
  kind: "user_line" | "bot_line" | "filing" | "scale";
  sessionId: string | null;
  messageId: string | null;
  /** The built-in prompt the reading is asked with (ADR 0064): yours when you edited it. */
  prompt: "call.read_user_line" | "call.read_bot_line" | "call.read_filing" | "call.read_scale";
  payload: unknown;
  parse: (raw: string) => T | null;
  /** What the line reads as when no model read it: the word lists, or nothing at all for a filing. */
  fallback: () => T;
  /** How the log line ends when the fallback stands in. */
  fallbackNote: string;
};

export function createReader(deps: ReaderDeps): Reader {
  const { store } = deps;
  const ablation = deps.ablation ?? NO_ABLATION;
  const log = deps.log ?? ((line: string) => console.error(line));
  const timeoutMs = deps.timeoutMs ?? READER_TIMEOUT_MS;
  const cache = new Map<string, Promise<unknown>>();
  const inFlight = new Set<AbortController>();
  let stopped = false;

  function remember<T>(key: string, make: () => Promise<T>): Promise<T> {
    const known = cache.get(key) as Promise<T> | undefined;
    if (known) return known;
    const made = make();
    cache.set(key, made);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    return made;
  }

  function record<T extends { source: string }>(asked: Asked<T>, reading: T, fields: { model: string | null; fail: string | null; raw: string | null }): void {
    try {
      store.recordWorkEvent({
        kind: "reader.answer",
        actor: READER_WRITER,
        sessionId: asked.sessionId,
        payload: {
          read: asked.kind,
          ...(asked.messageId ? { message_id: asked.messageId } : {}),
          source: reading.source,
          model: fields.model,
          fail: fields.fail,
          reading,
          raw: fields.raw === null ? null : fields.raw.slice(0, RAW_MAX),
        },
      });
    } catch {
      // the work log is a record; the reading still counts
    }
  }

  async function read<T extends { source: string }>(asked: Asked<T>): Promise<T> {
    const byWords = (fail: string, model: string | null, raw: string | null): T => {
      const reading = asked.fallback();
      record(asked, reading, { model, fail, raw });
      return reading;
    };
    if (ablation.has("reader")) return byWords("ablated", null, null);
    if (deps.draining()) return byWords("draining", null, null);
    const routing = await deps.routing().catch(() => null);
    if (!routing) return byWords("no_model", null, null);
    const prompt = promptPage(store, "zh").resolve(asked.prompt);
    const controller = new AbortController();
    inFlight.add(controller);
    // The whole wait, a slot included: the call's own timer only starts once it has one.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let result: JudgeResult | null = null;
    let threw: string | null = null;
    try {
      result = await deps.completions.judge({
        baseUrl: routing.baseUrl,
        apiKey: routing.apiKey,
        apiFormat: routing.apiFormat,
        model: routing.model,
        prompt: prompt.ref,
        messages: [
          { role: "system", content: prompt.text },
          { role: "user", content: JSON.stringify(asked.payload) },
        ],
        signal: controller.signal,
        timeoutMs,
        maxTokens: READER_MAX_TOKENS,
        ...(routing.thinkingLevel ? { thinkingLevel: routing.thinkingLevel } : {}),
        lane: "reading",
      });
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
      inFlight.delete(controller);
    }
    if (result && asked.sessionId) {
      try {
        deps.recordSpend({ sessionId: asked.sessionId, target: routing, usage: result.usage,
          responded: result.failKind === null || result.failKind === "incomplete" });
      } catch {
        // the ledger of spend is best-effort
      }
    }
    const fail = threw !== null ? "call_error"
      : controller.signal.aborted ? (stopped ? "stopped" : "timeout")
        : result!.failKind && result!.failKind !== "incomplete" ? result!.failKind
          : null;
    const raw = result?.content ?? null;
    const reading = fail ? null : asked.parse(raw ?? "");
    if (!reading) {
      const why = fail ?? (result!.truncated ? "truncated" : "unreadable");
      if (why === "unreadable") {
        store.notePromptParseFailure({ prompt: prompt.ref.id, locale: prompt.ref.locale, revision: prompt.ref.revision_id, reason: why, sessionId: asked.sessionId });
      }
      log(`[reader] ${asked.kind} ${asked.messageId ?? asked.key}: ${why}, ${asked.fallbackNote}`);
      return byWords(why, routing.model, raw);
    }
    record(asked, reading, { model: routing.model, fail: null, raw });
    return reading;
  }

  function authorOf(message: Pick<Message, "kind" | "author">): string {
    if (message.kind === "user" || message.author === USER_MEMBER) return "user";
    try {
      return store.getBot(message.author).name;
    } catch {
      return message.kind;
    }
  }

  function userLine(message: Message): Promise<UserLineReading> {
    return remember(`user:${message.id}`, () => {
      let where: "group" | "direct" = "group";
      try {
        where = store.getSession(message.session_id).kind === "direct" ? "direct" : "group";
      } catch {
        where = "group";
      }
      let replyingTo: { author: string; text: string } | null = null;
      if (message.parent_id) {
        try {
          const parent = store.getMessage(message.parent_id);
          replyingTo = { author: authorOf(parent), text: parent.body };
        } catch {
          replyingTo = null;
        }
      }
      const recent = store.db
        .query<{ kind: Message["kind"]; author: string; body: string }, [string, string, string, number]>(
          `SELECT kind, author, body FROM messages WHERE session_id = ? AND created_at <= ? AND id != ? AND kind IN ('user', 'bot')
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(message.session_id, message.created_at, message.id, RECENT_LINES)
        .reverse()
        .map((line) => ({ author: authorOf(line), text: line.body }));
      return read({
        key: `user:${message.id}`,
        kind: "user_line",
        sessionId: message.session_id,
        messageId: message.id,
        prompt: "call.read_user_line",
        payload: userLinePayload({ body: message.body, where, replyingTo, recent }),
        // Only a line of the shape a status question has is read as one, however the model read its words.
        parse: (raw) => {
          const reading = parseUserLineAnswer(raw, message.body);
          return reading && { ...reading, statusOnly: reading.statusOnly && statusQuestionShape(message) };
        },
        fallback: () => userLineByWords(message.body, { statusQuestion: isStatusQuestion(message) }),
        fallbackNote: "read by the word lists",
      });
    });
  }

  function userText(key: string, body: string, sessionId: string | null): Promise<UserLineReading> {
    return remember(`user:${key}`, () => read({
      key,
      kind: "user_line",
      sessionId,
      messageId: null,
      prompt: "call.read_user_line",
      payload: userLinePayload({ body, where: "direct", replyingTo: null, recent: [] }),
      parse: (raw) => parseUserLineAnswer(raw, body),
      fallback: () => userLineByWords(body, { statusQuestion: false }),
      fallbackNote: "read by the word lists",
    }));
  }

  function botLine(body: string, sessionId: string | null, context?: BotLineContext): Promise<BotLineReading> {
    const answering = context?.answering?.trim() ? context.answering : null;
    const hash = createHash("sha256").update(body);
    if (answering) hash.update("\u0000").update(answering);
    const key = `bot:${hash.digest("hex")}`;
    return remember(key, () => {
      // Nothing to read: no call for it.
      if (!body.trim()) return Promise.resolve(botLineByWords(body));
      return read({
        key,
        kind: "bot_line",
        sessionId,
        messageId: null,
        prompt: "call.read_bot_line",
        payload: botLinePayload(body, answering),
        parse: (raw) => parseBotLineAnswer(raw, body, answering),
        fallback: () => botLineByWords(body, answering),
        fallbackNote: "read by the word lists",
      });
    });
  }

  function filing(message: Message): Promise<FilingReading | null> {
    return remember(`filing:${message.id}`, () => {
      let line: ReturnType<Store["lineToFile"]> = null;
      try {
        line = store.lineToFile(message.id);
      } catch {
        line = null;
      }
      if (!line) return Promise.resolve(null);
      const { payload, refs } = filingPayload(line);
      return read<FilingReading>({
        key: `filing:${message.id}`,
        kind: "filing",
        sessionId: message.session_id,
        messageId: message.id,
        prompt: "call.read_filing",
        payload,
        parse: (raw) => parseFilingAnswer(raw, refs),
        // No word list guesses where a line goes: the Bot chooses at its desk.
        fallback: () => UNREAD_FILING,
        fallbackNote: "left for the Bot's desk",
      });
    });
  }

  function scale(input: Parameters<Reader["scale"]>[0]): Promise<ScaleReading> {
    return remember(input.key, () => read<ScaleReading>({
      key: input.key,
      kind: "scale",
      sessionId: input.sessionId,
      messageId: null,
      prompt: "call.read_scale",
      payload: scalePayload(input),
      parse: (raw) => parseScaleAnswer(raw, input.said),
      // No word list says how big a thing is: an unread job is only the signal's to call large.
      fallback: () => UNREAD_SCALE,
      fallbackNote: "left unread",
    }));
  }

  return {
    userLine,
    userText,
    botLine,
    filing,
    scale,
    forget(messageId) {
      cache.delete(`user:${messageId}`);
      cache.delete(`filing:${messageId}`);
    },
    stop() {
      stopped = true;
      for (const controller of inFlight) controller.abort();
    },
  };
}
