/**
 * Who a message wakes. A direct wakes the other side, except a Bot's nod to a nod in a Bot↔Bot
 * direct (see `isNodToANod`); a group reads its `@mentions` against the roster and, naming no one,
 * treats a user line as a floor open to everyone present — the focused Bot hears it, the rest judge
 * whether it is theirs to join. `pendingJudges` tracks a judgement from the moment it is announced
 * to the moment it lands, so the sidebar can show a Bot as still deciding.
 */
import {
  USER_MEMBER,
  type ClientEvent,
  type Message,
  type PendingJudgement,
  type Turn,
} from "@real-bot/protocol";
import { ABLATED_JOIN_REASON, NO_ABLATION, type Ablation } from "../ablation";
import type { CompletionsClient } from "../completions";
import { assembleJudgementUser, extractJudgement } from "../context";
import { isoNow, ulid } from "../ids";
import { parseMentions } from "../mentions";
import { isBareRemark } from "../no-work";
import { JUDGEMENT_MAX_TOKENS, JUDGEMENT_SYSTEM, unknownMentionBody } from "../prompts";
import type { TurnAdmission } from "../quiesce";
import { sessionUpsertFields } from "../session-events";
import type { Store } from "../store";
import type { HeardItem } from "../turn-inbox";
import { mayWake, wakeOn, type WakeCause } from "./control";
import type { Routing } from "./routing";
import type { SpendTracker } from "./spend";
import type { Creds, InboxEntry } from "./types";

export type ParticipationDeps = {
  store: Store;
  publish: (event: ClientEvent) => void;
  publishMessage: (message: Message) => void;
  occurred: () => string;
  admission: TurnAdmission | undefined;
  completions: CompletionsClient;
  credentials: Routing["credentials"];
  targetFor: Routing["targetFor"];
  callOf: SpendTracker["callOf"];
  spendOwner: SpendTracker["spendOwner"];
  recordResponseSpend: SpendTracker["recordResponseSpend"];
  /** Late-bound: lifecycle.ts is built after this module. Null when a hold turns the wake away. */
  startTurn: (
    sessionId: string,
    botId: string,
    trigger: Message,
    mode: "redirect" | "fork",
    opts: { cause: WakeCause; routineId?: string | null; routineDueAt?: string | null; taskId?: string | null; ticketId?: string | null },
  ) => Turn | null;
  /** Late-bound: lifecycle.ts is built after this module. Null when a hold turns the wake away. */
  hearOrStart: (
    sessionId: string,
    botId: string,
    trigger: Message,
    entry: Omit<InboxEntry, "message">,
    opts: { cause: WakeCause; taskId?: string | null; ticketId?: string | null },
  ) => Turn | null;
  /** Benchmark switches (see `ablation.ts`): `judgement` has every Bot join without a call. */
  ablation?: Ablation;
};

export type Participation = {
  mentionsIn: (
    sessionId: string,
    body: string,
  ) => { parsed: ReturnType<typeof parseMentions>; nameById: Map<string, string>; presentNames: string[] };
  botsToWake: (message: Message) => string[];
  handleParticipation: (
    message: Message,
    opts: { fromUser: boolean; fork?: boolean; opened?: () => void },
  ) => Promise<void>;
  startPendingJudgement: (
    sessionId: string,
    messageId: string,
    botId: string,
    stage: NonNullable<PendingJudgement["stage"]>,
  ) => PendingJudgement;
  dropPendingJudgement: (pending: PendingJudgement, ended: boolean) => void;
  judge: (botId: string, message: Message, mentions: string[], everyone: boolean, pending: PendingJudgement) => Promise<void>;
  /** Live judgements, keyed by their own id; the public API's `pendingJudgements()` and `close()` read it. */
  pendingJudges: Map<string, PendingJudgement>;
};

export function createParticipation(deps: ParticipationDeps): Participation {
  const {
    store,
    publish,
    publishMessage,
    occurred,
    admission,
    completions,
    credentials,
    targetFor,
    callOf,
    spendOwner,
    recordResponseSpend,
    startTurn,
    hearOrStart,
  } = deps;
  const ablation = deps.ablation ?? NO_ABLATION;
  const pendingJudges = new Map<string, PendingJudgement>();

  /** A Bot's `@token` matched nobody present: say so in the transcript so the miss is visible. */
  async function noteUnknownMentions(message: Message, tokens: string[], members: string[]): Promise<void> {
    const locale = (await store.settings()).locale;
    if (admission?.draining) return;
    const note = store.insertMessage({
      sessionId: message.session_id,
      turnId: message.turn_id,
      parentId: null,
      kind: "system",
      author: message.author,
      body: unknownMentionBody(locale, tokens, members),
    });
    publishMessage(note);
  }

  /** Who a message names, read against the whole roster; present members' names may be shortened. */
  function mentionsIn(sessionId: string, body: string) {
    const roster = store.listBots();
    const nameById = new Map(roster.map((b) => [b.id, b.name] as const));
    const presentNames = store
      .presentBotIds(sessionId)
      .map((id) => nameById.get(id))
      .filter((name): name is string => typeof name === "string");
    const parsed = parseMentions(body, roster.map((b) => b.name), { lenient: presentNames });
    return { parsed, nameById, presentNames };
  }

  /**
   * The Bots a message is about to wake, before anything has opened: the other one in a direct;
   * in a group everyone it names (a named Bot outside the group is about to be added), or, naming
   * no one, everyone present — the focused Bot hears it and the rest judge. `handleParticipation`
   * decides for real once the message has been filed.
   */
  function botsToWake(message: Message): string[] {
    if (admission?.draining) return [];
    if (message.kind !== "user" && message.kind !== "bot") return [];
    try {
      const session = store.getSession(message.session_id);
      const present = store.presentBotIds(session.id);
      if (session.kind === "direct") return present.filter((id) => id !== message.author).slice(0, 1);
      const { parsed } = mentionsIn(session.id, message.body);
      const named = parsed.mentions
        .map((name) => store.findBotByName(name)?.id)
        .filter((id): id is string => typeof id === "string");
      const woken = parsed.everyone || named.length === 0 ? [...present, ...named] : named;
      return [...new Set(woken)].filter((id) => id !== message.author);
    } catch {
      return [];
    }
  }

  async function handleParticipation(
    message: Message,
    opts: {
      fromUser: boolean;
      fork?: boolean;
      /** Every turn and judgement this message opens has started; the judgements are still out. */
      opened?: () => void;
    },
  ): Promise<void> {
    if (admission?.draining) return;
    const session = store.getSession(message.session_id);
    if (message.kind !== "user" && message.kind !== "bot") return;

    if (session.kind === "direct") {
      const bots = store.presentBotIds(session.id);
      const target = bots.find((id) => id !== message.author);
      if (!target) return;
      if (!opts.fromUser && message.kind === "bot" && isNodToANod(message)) return;
      // Your new message forks by default, so you can ask two things at once. While the Bot is
      // already working, a line of yours goes into that turn's inbox instead of cutting it off
      // (ADR 0040 P4a): the composer stays open, and the turn reads it at its next step. With no
      // user in the room, a Bot's next message is heard the same way.
      const withYou = store.isPresent(session.id, USER_MEMBER);
      const working = store.listLiveTurns({ sessionId: session.id, botId: target }).some((turn) => turn.mode !== "readonly");
      const fork = opts.fork !== undefined ? opts.fork : withYou && !working;
      const cause = causeOf(message);
      if (fork) startTurn(session.id, target, message, "fork", { cause });
      else if (working || (!opts.fromUser && message.kind === "bot")) hearOrStart(session.id, target, message, { item: inboxItem(message) }, { cause });
      else startTurn(session.id, target, message, "redirect", { cause });
      return;
    }

    const { parsed, nameById, presentNames } = mentionsIn(session.id, message.body);
    if (!opts.fromUser && parsed.unresolved.length > 0) {
      const authorName = nameById.get(message.author);
      await noteUnknownMentions(message, parsed.unresolved, presentNames.filter((name) => name !== authorName));
    }
    if (admission?.draining) return;
    if (session.kind === "group") {
      for (const name of parsed.mentions) {
        const bot = store.findBotByName(name);
        if (!bot) continue;
        if (!store.isPresent(session.id, bot.id)) {
          const next = store.addMember(session.id, bot.id);
          publish({
            event: "session.upsert",
            occurred_at: occurred(),
            ...sessionUpsertFields(next),
          });
        }
      }
    }

    const present = store.presentBotIds(session.id);
    const mentionedIds = parsed.mentions
      .map((name) => store.findBotByName(name)?.id)
      .filter((id): id is string => typeof id === "string" && present.includes(id));
    const mandatory = new Set<string>();
    if (parsed.everyone) {
      for (const id of present) {
        if (id !== message.author) mandatory.add(id);
      }
    }
    for (const id of mentionedIds) {
      if (id !== message.author) mandatory.add(id);
    }

    const hasMention = parsed.everyone || mentionedIds.length > 0;
    const cause = causeOf(message);
    const opened = new Set<string>();
    if (opts.fromUser && !hasMention) {
      const focused = store.listLiveTurns({ sessionId: session.id })[0];
      if (focused) {
        const fork = opts.fork !== undefined ? opts.fork : true;
        startTurn(session.id, focused.bot_id, message, fork ? "fork" : "redirect", { cause });
        opened.add(focused.bot_id);
      }
    }

    for (const botId of mandatory) {
      // A Bot naming a Bot that is mid-task is heard in that task; your line still turns it around.
      if (opts.fork === true) startTurn(session.id, botId, message, "fork", { cause });
      else if (!opts.fromUser && message.kind === "bot") hearOrStart(session.id, botId, message, { item: inboxItem(message) }, { cause });
      else startTurn(session.id, botId, message, "redirect", { cause });
      opened.add(botId);
    }

    // User text with no @ is a group-wide ask: unmentioned bots judge. A user or
    // Bot @ / @everyone (including an auto-@ on a quote-reply) only opens the
    // named set. Bot text with no @ stays silent. Quote-replies still participate.
    if (!(opts.fromUser && !hasMention)) return;

    // A Bot a hold covers could only be turned away after its judgement, so it is not asked.
    const judges = present.filter(
      (id) =>
        id !== message.author &&
        !opened.has(id) &&
        !mandatory.has(id) &&
        mayWake(store, wakeOn(store, cause, { sessionId: session.id, botId: id, trigger: message })),
    );
    const pendingByBot = new Map<string, PendingJudgement>();
    for (const botId of judges) {
      pendingByBot.set(botId, startPendingJudgement(message.session_id, message.id, botId, "judging"));
    }
    opts.opened?.();
    await Promise.all(
      judges.map((botId) =>
        judge(botId, message, parsed.mentions, parsed.everyone, pendingByBot.get(botId)!),
      ),
    );
  }

  /**
   * In a Bot↔Bot direct every line wakes the other Bot, so two Bots with nothing left to do can
   * trade 「收到」「已对齐，本轮不发消息」 for ever: on 2026-09-29 视频导演 and 审片员 kept it up every
   * 20 s after the user had stopped both. A line is a nod to a nod when it and the other Bot's
   * line that opened its turn are both bare remarks, neither cites a file, and neither turn ran a
   * command or an MCP tool. It stays in the transcript but wakes nobody, which ends the exchange;
   * the opener's report-back takes it from there.
   */
  function isNodToANod(message: Message): boolean {
    if (!message.turn_id || message.attachments.length > 0 || !isBareRemark(message.body)) return false;
    try {
      if (store.turnRuns(message.turn_id).length > 0) return false;
      const trigger = store.getMessage(store.getTurn(message.turn_id).trigger_message_id);
      if (trigger.kind !== "bot" || trigger.author === message.author || !trigger.turn_id) return false;
      if (trigger.attachments.length > 0 || !isBareRemark(trigger.body)) return false;
      return store.turnRuns(trigger.turn_id).length === 0;
    } catch {
      return false;
    }
  }

  /** Your line, or a Bot's: what the work log says woke a Bot when a hold turns the wake away. */
  function causeOf(message: Message): WakeCause {
    return message.kind === "user" ? "user_line" : "mention";
  }

  function inboxItem(message: Message): HeardItem {
    let author = message.author;
    try {
      author = message.author === USER_MEMBER ? "user" : store.getBot(message.author).name;
    } catch {
      // a deleted Bot keeps its id as its name here
    }
    return { author, body: message.body, checkBack: false };
  }

  function startPendingJudgement(
    sessionId: string,
    messageId: string,
    botId: string,
    stage: NonNullable<PendingJudgement["stage"]>,
  ): PendingJudgement {
    const pending: PendingJudgement = {
      id: ulid(),
      session_id: sessionId,
      message_id: messageId,
      bot_id: botId,
      stage,
      created_at: isoNow(),
    };
    pendingJudges.set(pending.id, pending);
    publish({ event: "judgement.started", occurred_at: pending.created_at, ...pending });
    return pending;
  }

  function dropPendingJudgement(pending: PendingJudgement, ended: boolean): void {
    if (!pendingJudges.delete(pending.id)) return;
    if (ended) {
      publish({
        event: "judgement.ended",
        occurred_at: occurred(),
        id: pending.id,
        session_id: pending.session_id,
        message_id: pending.message_id,
        bot_id: pending.bot_id,
      });
    }
  }

  async function judge(
    botId: string,
    message: Message,
    mentions: string[],
    everyone: boolean,
    pending: PendingJudgement,
  ): Promise<void> {
    let settled = false;
    const finish = (row?: { id: string }): void => {
      dropPendingJudgement(pending, !row);
      settled = true;
    };
    try {
      if (ablation.has("judgement")) {
        // Off: every Bot the line would have asked joins, the way a "join" verdict does, unbilled.
        if (admission?.draining) return;
        let row;
        try {
          row = store.insertJudgement({
            sessionId: message.session_id,
            messageId: message.id,
            botId,
            decision: "join",
            reason: ABLATED_JOIN_REASON,
            error: null,
          });
        } catch {
          return;
        }
        startTurn(message.session_id, botId, message, "redirect", { cause: causeOf(message) });
        finish(row);
        publish({ event: "judgement.created", occurred_at: occurred(), ...row });
        return;
      }
      let creds: Creds | null;
      try {
        creds = await credentials();
      } catch {
        return;
      }
      if (admission?.draining) return;
      const target = creds ? (targetFor(botId, creds, message.body)?.target ?? null) : null;
      if (!creds || !target) {
        try {
          const row = store.insertJudgement({
            sessionId: message.session_id,
            messageId: message.id,
            botId,
            decision: "pass",
            error: "endpoint_error",
          });
          finish(row);
          publish({ event: "judgement.created", occurred_at: occurred(), ...row });
        } catch {
          return;
        }
        return;
      }
      let user: string;
      try {
        user = assembleJudgementUser(store, {
          sessionId: message.session_id,
          botId,
          message,
          mentions,
          everyone,
        });
      } catch {
        return;
      }
      const billed = { ...callOf(target), thinkingLevel: null };
      const owned = spendOwner(message.session_id, botId);
      const result = await completions.judge({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: target.model,
        messages: [
          { role: "system", content: JUDGEMENT_SYSTEM },
          { role: "user", content: user },
        ],
        signal: new AbortController().signal,
        maxTokens: JUDGEMENT_MAX_TOKENS,
      });
      // A cut-off verdict reads as a pass below; say so, since from the board it looks like a choice.
      if (result.truncated) {
        console.error(`[judgement] ${botId} on ${message.id}: the answer stopped at the ${JUDGEMENT_MAX_TOKENS}-token cap`);
      }
      if (admission?.draining) {
        recordResponseSpend({
          kind: "judgement",
          owner: owned,
          judgementId: pending.id,
          target: billed,
          usage: result.usage,
          responded: result.failKind === null || result.failKind === "incomplete",
        });
        return;
      }
      let decision: "join" | "pass" = "pass";
      let reason: string | null = null;
      let error: "timeout" | "invalid_output" | "endpoint_error" | null = null;
      if (result.failKind === "first_byte") error = "timeout";
      else if (result.failKind === "incomplete") {
        const extracted = extractJudgement(result.content, result.hadToolCalls);
        decision = extracted.decision;
        reason = extracted.reason;
        error = extracted.error ?? "invalid_output";
      } else if (result.failKind) error = "endpoint_error";
      else {
        const extracted = extractJudgement(result.content, result.hadToolCalls);
        decision = extracted.decision;
        reason = extracted.reason;
        error = extracted.error;
      }
      let row;
      try {
        row = store.insertJudgement({
          sessionId: message.session_id,
          messageId: message.id,
          botId,
          decision,
          reason,
          error,
        });
      } catch {
        recordResponseSpend({
          kind: "judgement",
          owner: owned,
          judgementId: pending.id,
          target: billed,
          usage: result.usage,
          responded: result.failKind === null || result.failKind === "incomplete",
        });
        return;
      }
      recordResponseSpend({
        kind: "judgement",
        owner: owned,
        judgementId: row.id,
        target: billed,
        usage: result.usage,
        responded: result.failKind === null || result.failKind === "incomplete",
      });
      if (decision === "join") startTurn(message.session_id, botId, message, "redirect", { cause: causeOf(message) });
      finish(row);
      publish({ event: "judgement.created", occurred_at: occurred(), ...row });
    } finally {
      if (!settled) finish();
    }
  }

  return { mentionsIn, botsToWake, handleParticipation, startPendingJudgement, dropPendingJudgement, judge, pendingJudges };
}
