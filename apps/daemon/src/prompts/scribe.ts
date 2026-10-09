/**
 * The scribe (书记员, ADR 0040 P3): one tool-less short completion per line of yours once it is
 * filed under a plan (and per answer you give a Bot's question), which proposes what the line adds
 * to the requirements ledger. It answers with a patch — entries to add, entries said again, entries
 * changed — and never a whole list, so nothing it leaves out is lost; `store/scribe-patch.ts` checks
 * every item against the line before any of it lands.
 *
 * The prompt, the payload and the reading of the answer live here; the engine side is `scribe.ts`.
 */
import type { TicketStatus } from "@real-bot/protocol";
import { sessionLabel } from "../context";
import { extractJsonObject } from "../route-agent";
import { parsePlanSpec, SCRIBE_QUOTE_MIN, type Requirement, type ScribePatch, type Store, type Task, type UserQuote } from "../store";
import { takeCodePoints } from "../text";
import { fill } from "./fill";

export const SCRIBE_TEMPLATE = `你是书记员：把用户的一句话里提出的要求记进这件事的「需求台账」。不是回答用户，也不能发言；没有工具。

台账里每一条要求都站在用户自己的原话上。你只能提补丁，三种：
- adds：这句话新提出的要求。quote 必须原样摘自 said.body 里的一段（可以只摘一部分，不能改写、拼接、补字或翻译），摘到单看它就知道要求是什么，至少 ${SCRIBE_QUOTE_MIN} 个字（空格和标点不算字；整句不到 ${SCRIBE_QUOTE_MIN} 个字就摘整句；只说一个时长、分辨率、画幅或帧率的数可以更短，例如「90 秒」「4K」「16:9」）；restated 用一句话转述这条要求；category 是一个短的类别名（例如「时长」「分辨率」「角色设定」「背景连贯」「台词」「转场」），同一类要求用同一个类别名，open 里已有的类别能用就沿用；polarity 是 must（要这样）或 must_not（不能这样）；scope_hint 是 ticket（只关系到某个任务，targets 写那个任务的 id）、plan（这件事整体）或 project（这个会话里以后的每件事都该遵守，例如角色设定、工艺要求）；nature 是这条要求说的是什么：craft（作品怎么做才算做好的工艺，例如镜头之间要连贯、转场要有过渡、不要多手多指或畸形、不要用冻帧补时长、全片画风或色调要统一）、look（这部作品看起来或听起来是什么样的选择，例如色调偏冷、打光要硬、配音用男声）、series（一个系列里要一直保持的设定，例如角色造型、机械臂是左手）或 other（其余的，包括只说某一个镜头、片段、片头片尾的，以及具体的时长、分辨率这类数字）。
- raises：这句话在重复 open 里已有的某一条。requirement_id 写那一条的 id，quote 同样原样摘自 said.body。
- supersedes：这句话明确改掉了 open 里的某一条（例如先说「约 2 分钟」，这句说「改成 3 分钟」）。requirement_id 写被改掉的那条，quote 原样摘自 said.body（字数要求和 adds 一样），restated 写改后的要求，category 写改后要求的类别，nature 同 adds。只有用户明说改、换、不要原来那样时才写。它不会直接改掉那一条，只是提议替换，等用户确认。
- withdraws：只在 payload 里有 edit 时用。edit.before、edit.after 是用户改这句话之前和之后的样子，edit.earlier 是从这句话早先的字记下、还在台账里的条目。用户删掉了、或改得不再要求的那一条，把它的 id 写进 withdraws（requirement_id）；拿不准就不写。它不会直接退掉那一条，只是在看板上问用户退不退。有 edit 时 adds、raises、supersedes 都写空：改后新加的字另外会读。

没有删除，也没有整份列表：没提到的条目原样保留，不用列出来。新要求和旧的不冲突就是 add，不要用 supersede 代替 add。提问、催进度、叫停或继续、闲聊、表示同意，本身都不是要求；Bot 说过的话也不是用户的要求。via 是 answer 时，said.body 是用户对 asked 这个问题的回答。没有要求就输出 {"adds": [], "raises": [], "supersedes": []}。

{format}`;
/** The scribe's patch. Fixed: the parser reads it, so an edited prompt keeps it where `{format}` sits (ADR 0064). */
export const SCRIBE_FORMAT = `只输出一个 JSON 对象，不要 markdown 围栏，不要前言后语：
{"adds": [{"quote": "…", "restated": "…", "category": "…", "polarity": "must", "scope_hint": "plan", "nature": "other", "targets": []}], "raises": [{"requirement_id": "…", "quote": "…"}], "supersedes": [{"requirement_id": "…", "quote": "…", "restated": "…", "category": "…", "nature": "other"}], "withdraws": [{"requirement_id": "…"}]}`;
export const SCRIBE_SYSTEM = fill(SCRIBE_TEMPLATE, { format: SCRIBE_FORMAT });


/** Open entries the scribe is shown, one line each: enough for a plan and its project, bounded. */
export const SCRIBE_OPEN_MAX = 60;
export const SCRIBE_TICKETS_MAX = 40;
/** As much of the question behind an answer as the scribe sees; the answer itself is kept whole. */
const ASKED_PREVIEW = 300;

export type ScribePayload = {
  session: { id: string | null; where: string | null };
  said: { via: "message" | "answer"; body: string; asked?: string; at: string };
  plan: { id: string; goal: string; tickets: Array<{ id: string; seq: number; title: string; status: TicketStatus }> };
  open: Array<{ id: string; category: string | null; quote: string; restated?: string; holds_for: string; times_raised: number }>;
  /** An edit of yours to the line, read only for what it took back: the line before and after, and the entries its earlier words stand on. */
  edit?: { before: string; after: string; earlier: Array<{ id: string; quote: string; restated?: string; status: string; holds_for: string }> };
};

function holdsFor(entry: Requirement, seqOf: ReadonlyMap<string, number>): string {
  if (entry.scope === "ticket") {
    const seq = entry.scope_id ? seqOf.get(entry.scope_id) : undefined;
    return seq === undefined ? "ticket" : `ticket ${String(seq).padStart(2, "0")}`;
  }
  return entry.scope;
}

/** What the scribe reads for one quote of yours filed under `task`, and the entries it was shown. */
export function scribePayload(store: Store, quote: UserQuote, task: Task): { payload: ScribePayload; offered: Requirement[] } {
  const tickets = store.listTickets(task.id).slice(0, SCRIBE_TICKETS_MAX);
  const seqOf = new Map(tickets.map((ticket) => [ticket.id, ticket.seq]));
  const offered = store.openRequirementsFor(task.id, SCRIBE_OPEN_MAX);
  let asked: string | undefined;
  if (quote.via === "ask_answer" && quote.message_id) {
    try {
      asked = takeCodePoints(store.getMessage(quote.message_id).body, ASKED_PREVIEW).text;
    } catch {
      asked = undefined; // the question went with a cleared transcript; the answer still stands
    }
  }
  const goal = parsePlanSpec(task.spec)?.goal;
  return {
    payload: {
      session: { id: quote.session_id, where: quote.session_id ? sessionLabel(store, quote.session_id, null, "zh") : null },
      said: { via: quote.via === "ask_answer" ? "answer" : "message", body: quote.body, ...(asked ? { asked } : {}), at: quote.created_at },
      plan: {
        id: task.id,
        goal: goal || task.title,
        tickets: tickets.map((ticket) => ({ id: ticket.id, seq: ticket.seq, title: ticket.title, status: ticket.status })),
      },
      open: offered.map((entry) => ({
        id: entry.id,
        category: entry.category,
        quote: entry.quote,
        ...(entry.restated ? { restated: entry.restated } : {}),
        holds_for: holdsFor(entry, seqOf),
        times_raised: entry.times_raised,
      })),
    },
    offered,
  };
}

/**
 * What the scribe reads for one edit of yours to a line filed under `task`: the line as it now
 * reads, and the edit with the entries it can have taken back (`earlier`, chosen by structure in
 * `editEarlierEntries`) — those, and only those, are what it may name in `withdraws`.
 */
export function scribeEditPayload(
  store: Store,
  input: { edit: { before: string; after: string; at: string }; sessionId: string | null; task: Task; earlier: readonly Requirement[] },
): ScribePayload {
  const tickets = store.listTickets(input.task.id).slice(0, SCRIBE_TICKETS_MAX);
  const seqOf = new Map(tickets.map((ticket) => [ticket.id, ticket.seq]));
  const goal = parsePlanSpec(input.task.spec)?.goal;
  return {
    session: { id: input.sessionId, where: input.sessionId ? sessionLabel(store, input.sessionId, null, "zh") : null },
    said: { via: "message", body: input.edit.after, at: input.edit.at },
    plan: {
      id: input.task.id,
      goal: goal || input.task.title,
      tickets: tickets.map((ticket) => ({ id: ticket.id, seq: ticket.seq, title: ticket.title, status: ticket.status })),
    },
    open: [],
    edit: {
      before: input.edit.before,
      after: input.edit.after,
      earlier: input.earlier.map((entry) => ({
        id: entry.id,
        quote: entry.quote,
        ...(entry.restated ? { restated: entry.restated } : {}),
        status: entry.status,
        holds_for: holdsFor(entry, seqOf),
      })),
    },
  };
}

/**
 * The scribe's answer as a patch, each list as written (the items are checked when it is applied),
 * or null when it is not one: no JSON object, or one with none of its lists — an answer meant
 * for another call. `"none"`, `{"none": true}` and empty lists are all an empty patch.
 */
export function parseScribeAnswer(raw: string): ScribePatch | null {
  if (/^\s*"?none"?\s*$/i.test(raw)) return { adds: [], raises: [], supersedes: [], withdraws: [] };
  const parsed = extractJsonObject(raw);
  if (!parsed) return null;
  const lists = ["adds", "raises", "supersedes", "withdraws"] as const;
  if (!lists.some((key) => key in parsed) && parsed.none !== true) return null;
  const list = (key: (typeof lists)[number]): unknown[] => (Array.isArray(parsed[key]) ? (parsed[key] as unknown[]) : []);
  return { adds: list("adds"), raises: list("raises"), supersedes: list("supersedes"), withdraws: list("withdraws") };
}
