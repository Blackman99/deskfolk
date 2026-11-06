/**
 * What the stage reads of the runtime for one conversation (the top of `ChatStage.svelte`'s
 * script), as accessors that stay live: the roster, the transcript composed from the snapshot, the
 * waiting cards, the rows' shared context. `stage-actions.ts` adds the handlers the rows call;
 * `ChatStage.tsx` builds the `TranscriptStage` object from both.
 */
import { computed, effect, signal, untracked } from "nsh";
import { USER_MEMBER, type Bot, type Message, type SessionSummary } from "@real-bot/protocol";
import { annotationsByMessage } from "../../m/annotations/model.ts";
import { ArrivalTracker } from "../../m/chat/arrivals.ts";
import { indexBotDmsByOrigin } from "../../m/chat/bot-dm-entries.ts";
import { buildMessageLookup, groupTranscript, restartAnnounced } from "../../m/chat/chat-view.ts";
import { composerLocked } from "../../m/chat/composer-mode.ts";
import { handedOverPaths } from "../../m/overlays/artifacts.ts";
import { messageDisplayBody } from "../../m/chat/message-body.ts";
import { INDEX_MIN_MARKS, messageIndexMarks } from "../../m/chat/message-index.ts";
import { ReadMark } from "../../m/chat/read-mark.ts";
import { composeTranscript, isLiveStatus } from "../../m/chat/transcript.ts";
import type { TranscriptStage } from "../../m/chat/transcript-stage.ts";
import { waitingCards } from "../../m/chat/waiting.ts";
import { classifySession, isFileDropSession, presentBotIds, youBotPeer } from "../../m/sidebar/session-groups.ts";
import { sessionTitle } from "../../m/sidebar/session-title.ts";
import { copy, runtime } from "../../runtime";
import { rosterLabelsOf, statusLabelsOf } from "./labels";

type MarkdownOpts = ReturnType<TranscriptStage["markdownOpts"]>;

export function createStageContext(selected: () => SessionSummary | null) {
  const snapshot = () => runtime.snapshot;
  const t = () => copy();
  /** This conversation's own state: its draft, reply, highlight, history cursor, send in flight. */
  const view = () => {
    const s = selected();
    return s ? runtime.sessionView(s.id) : null;
  };
  const sessionId = computed(() => selected()?.id ?? null);
  const locale = (): "en" | "zh" => (snapshot().settings.locale === "en" ? "en" : "zh");
  const botsById = computed(() => new Map(snapshot().bots.map((b) => [b.id, b] as const)));
  const connected = () => runtime.connection === "connected";
  const selectedKind = computed(() => {
    const s = selected();
    return s ? classifySession(s) : null;
  });
  const fileDrop = () => {
    const s = selected();
    return s ? isFileDropSession(s) : false;
  };
  const selectedPeer = () => {
    const s = selected();
    return s ? youBotPeer(s) : null;
  };
  const selectedPeerBot = () => {
    const peer = selectedPeer();
    return peer ? (botsById().get(peer) ?? null) : null;
  };
  const lockedComposer = () => composerLocked(selected(), botsById());
  /** Your own lines never carry a face or 你; in your direct the left is only ever that Bot. */
  const sidesSayWho = () => selectedKind() === "you-bot";
  const rosterLabels = () => rosterLabelsOf(t());
  const statusLabels = () => statusLabelsOf(t());
  const titleOf = (session: SessionSummary): string => sessionTitle(session, botsById(), rosterLabels());

  // A Bot's question about a job names the job and its ticket: the names load with the question.
  const workQuestionKey = computed(() =>
    snapshot()
      .messages.filter((row) => row.session_id === sessionId() && row.control?.kind === "work_question")
      .map((row) => `${row.id}:${row.control?.kind === "work_question" ? row.control.task_id : ""}`)
      .join("|"),
  );
  effect(() => {
    const id = sessionId();
    const questions = workQuestionKey();
    if (id && connected() && !fileDrop() && questions) {
      untracked(() => {
        const question = snapshot().messages.find((row) => row.session_id === id && row.control?.kind === "work_question");
        void runtime.loadAttributionPlans(id, question?.id);
      });
    }
  });
  // Stable scalar dependencies: streaming tokens and session.upsert do not re-read the thread.
  effect(() => {
    const id = sessionId();
    void runtime.delegationSnapshotEpoch;
    if (id && selectedKind() === "bot-bot" && connected()) untracked(() => void runtime.loadDelegations(id));
  });
  const delegations = computed(() =>
    selectedKind() === "bot-bot" ? snapshot().delegations.filter((row) => row.thread_session_id === sessionId()) : [],
  );
  const linkedDelegationMessages = computed(
    () => new Set(delegations().flatMap((row) => [row.request_message_id, row.result_message_id].filter((id): id is string => id !== null))),
  );
  const delegationsShown = () => {
    const s = selected();
    return Boolean(s && selectedKind() === "bot-bot" && !runtime.delegationUnsupported[s.id]);
  };

  // Keyed by the message that carries them, a separate collection.
  const annotationIndex = computed(() => annotationsByMessage(snapshot().annotations));
  const botDmIndex = computed(() => indexBotDmsByOrigin(snapshot().sessions, selected()?.id ?? null, snapshot().turns, botsById()));

  const stream = computed(() => {
    const s = selected();
    if (!s) return [];
    return composeTranscript(snapshot().messages, snapshot().turns, s.id, snapshot().pendingJudgements).filter(
      (item) => item.type !== "message" || !linkedDelegationMessages().has(item.message.id),
    );
  });

  /** Rows that have just arrived, so only they rise into place. */
  const arrivals = new ArrivalTracker();
  const arriving = computed(() => arrivals.observe(selected()?.id ?? null, stream()));
  /** The message the "New" line goes above, settled when the conversation opens. */
  const readMark = new ReadMark();
  const newMarkId = computed(() => readMark.observe(selected()?.id ?? null, selected()?.last_read_at, stream()));
  /** Approvals and questions here still waiting on you. */
  const waiting = computed(() => waitingCards(stream(), snapshot().approvals, snapshot().turns, runtime.notificationCapabilities.pending_ask_v1));
  /** The newest message, by id alone, so a read (which publishes a new snapshot) does not re-arm itself. */
  const lastMessageId = computed(() => {
    const items = stream();
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.type === "message") return item.message.id;
    }
    return null;
  });
  const announced = computed(() => restartAnnounced(stream().flatMap((item) => (item.type === "message" ? [item.message] : []))));
  const messageLookup = computed(() => buildMessageLookup(snapshot().messages));
  const groups = computed(() => groupTranscript(stream()));
  /** The reply each finished turn's commands go under: its last Bot message here. */
  const commandHosts = computed(() => {
    const running = new Set(snapshot().turns.filter((turn) => turn.status === "running").map((turn) => turn.id));
    const last = new Map<string, string>();
    for (const item of stream()) {
      if (item.type === "message" && item.message.kind === "bot" && item.message.turn_id && !running.has(item.message.turn_id)) {
        last.set(item.message.turn_id, item.message.id);
      }
    }
    return new Set(last.values());
  });
  const indexMarks = computed(() => messageIndexMarks(stream()));
  const showMessageIndex = () => indexMarks().length >= INDEX_MIN_MARKS || Boolean(view()?.hasOlderMessages);
  const liveTurnsHere = computed(() => {
    const s = selected();
    return s ? snapshot().turns.filter((turn) => turn.session_id === s.id && isLiveStatus(turn.status)) : [];
  });

  // The working bubbles' clock.
  const nowMs = signal(Date.now());
  effect(() => {
    if (liveTurnsHere().length === 0) return;
    const timer = setInterval(() => nowMs.set(Date.now()), 250);
    return () => clearInterval(timer);
  });

  const who = (message: Message): string => (message.author === USER_MEMBER ? t().common.you : (botsById().get(message.author)?.name ?? t().top.deleted));
  const whoAuthor = (author: string): string => (author === USER_MEMBER ? t().common.you : (botsById().get(author)?.name ?? t().top.deleted));
  const botNameOf = (id: string): string => botsById().get(id)?.name ?? t().top.deleted;

  /** Markdown options per bubble, reused as long as nothing in them changed. */
  const mentionMembers = computed((): Bot[] => {
    const s = selected();
    return s
      ? presentBotIds(s)
          .map((id) => botsById().get(id))
          .filter((b): b is Bot => Boolean(b))
      : snapshot().bots;
  });
  const markdownSignature = computed(() =>
    [snapshot().bots.map((bot) => `${bot.id}:${bot.name}`).join(","), mentionMembers().map((bot) => bot.id).join(","), t().stream.mentionUnresolved].join("|"),
  );
  let markdownOptsCache = new WeakMap<Message, MarkdownOpts>();
  let markdownOptsSignature = "";
  function markdownOpts(message?: Message, extra?: { streaming?: boolean }): MarkdownOpts {
    if (markdownOptsSignature !== markdownSignature()) {
      markdownOptsCache = new WeakMap();
      markdownOptsSignature = markdownSignature();
    }
    const build = (extraPaths: string[]): MarkdownOpts => ({
      streaming: extra?.streaming,
      extraPaths,
      mentionBots: snapshot().bots,
      mentionMembers: mentionMembers(),
      unresolvedMentionTitle: t().stream.mentionUnresolved,
    });
    if (!message) return build([]);
    const cached = markdownOptsCache.get(message);
    if (cached) return cached;
    const opts = build(message.attachments.map((att) => att.workspace_relpath));
    markdownOptsCache.set(message, opts);
    return opts;
  }
  const messageShowsAttachments = (message: Message): boolean =>
    handedOverPaths(message.body, message.attachments.map((att) => att.workspace_relpath)).length > 0;
  const messageBody = (message: Message): string => messageDisplayBody(message.body, message.attachments.map((att) => att.workspace_relpath));

  return {
    snapshot,
    view,
    sessionId,
    locale,
    botsById,
    connected,
    selectedKind,
    fileDrop,
    selectedPeerBot,
    lockedComposer,
    sidesSayWho,
    rosterLabels,
    statusLabels,
    titleOf,
    delegations,
    delegationsShown,
    annotationIndex,
    botDmIndex,
    stream,
    arriving,
    newMarkId,
    waiting,
    lastMessageId,
    announced,
    messageLookup,
    groups,
    commandHosts,
    indexMarks,
    showMessageIndex,
    liveTurnsHere,
    nowMs,
    who,
    whoAuthor,
    botNameOf,
    markdownOpts,
    messageShowsAttachments,
    messageBody,
  };
}

export type StageContext = ReturnType<typeof createStageContext>;
