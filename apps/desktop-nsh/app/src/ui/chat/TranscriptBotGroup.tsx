/**
 * A Bot's replies in the transcript (`TranscriptBotGroup.svelte`), one or a run of parts, and its
 * working bubble while a turn runs (`transcript-stream`). A reply sits on the page like a document:
 * no bubble, the column's full width, with the quote, the Markdown body, the files, the annotation
 * cards, a foot that says what it ran, how long it took and when it came, the reactions, who is
 * thinking about it, and the Bot↔Bot direct it opened. The interface changes its turns made hang
 * under the run (`InterfaceChangeChip`).
 *
 * Differences from the Svelte group (which took DOM events): a secondary press, and the hover pill's
 * "more", go to `onContextMenu(message, position)` for the shell to open the message's menu; the
 * pill shows while the pointer is over a part (`transcript-parts`); a part's commands are read when
 * it mounts (the virtualised list mounts what is near) instead of when an observer sees it; the
 * found-line pulse is a still ring; `data-ui="bubble-bot"` (a profile CSS hook) has no counterpart.
 */
import { effect, signal, Text, untracked, View } from "nsh";
import type { Bot } from "@real-bot/protocol";
import { calculateBotDuration, formatDurationMs, formatFullTimestamp, formatMessageTime, type TranscriptGroup } from "../../m/chat/chat-view.ts";
import { transcriptItemKey, type TranscriptItem } from "../../m/chat/transcript.ts";
import type { TranscriptStage } from "../../m/chat/transcript-stage.ts";
import { copy, runtime } from "../../runtime";
import { AnnotationCards } from "../annotations/AnnotationCards";
import { Icon } from "../Icon";
import { MarkdownBody } from "../MarkdownBody";
import { tip } from "../tip";
import { BotDmEntry } from "./BotDmEntry";
import { CommandActivity } from "./CommandActivity";
import { InterfaceChangeChip } from "./InterfaceChangeChip";
import { MessageAttachments } from "./MessageAttachments";
import { QuoteRef } from "./QuoteRef";
import { ReactionRow } from "./ReactionRow";
import { ReplyingIndicator } from "./ReplyingIndicator";
import { StreamingReply } from "./transcript-stream";
import { arriveMotion, Badge, BotPortrait, MessageToolbar, ringStyle, SenderName, toolbarWanted, type MessageMenuHandler } from "./transcript-parts";

type MessageItem = Extract<TranscriptItem, { type: "message" }>;

export function TranscriptBotGroup(props: {
  group: TranscriptGroup;
  stage: TranscriptStage;
  /** A secondary press (right click, long press) on a part, or the pill's "more": the message's menu, at `position`. */
  onContextMenu?: MessageMenuHandler;
}) {
  const t = () => copy();
  const stage = () => props.stage;
  const bot = (): Bot | undefined => stage().botsById.get(props.group.author);
  const multi = () => props.group.items.length > 1;
  /** The turns this reply belongs to, for the interface changes they made. */
  const turnIds = () =>
    props.group.items.flatMap((i) => (i.type === "message" ? (i.message.turn_id ? [i.message.turn_id] : []) : i.type === "streaming" ? [i.turn.id] : []));
  const hasStreaming = () => props.group.items.some((i) => i.type === "streaming");

  return (
    <View testID="bubble-bot" class="flex-row items-start gap-[10px] w-full self-stretch">
      <If when={!stage().sidesSayWho}>
        <BotPortrait bot={bot()} author={props.group.author} stage={stage()} glow={hasStreaming()} />
      </If>
      <View class="flex-1 min-w-0">
        <If when={!stage().sidesSayWho}>
          <View class="flex-row items-center gap-[6px] mb-[4px] px-[2px] min-w-0">
            <SenderName bot={bot()} label={bot()?.name ?? stage().whoAuthor(props.group.author)} stage={stage()} />
            <If when={!stage().focus}>
              <Badge>{t().chat.botBadge}</Badge>
              <If when={bot()?.model}>
                {(model: () => string) => (
                  <View class="shrink px-[6px] py-[1px] rounded-(--radius-xs) bg-chip border border-line">
                    <Text testID="model-badge" class="text-[11px] font-mono text-ink-muted line-clamp-1">
                      {model()}
                    </Text>
                  </View>
                )}
              </If>
            </If>
          </View>
        </If>
        <View class="gap-2 w-full">
          <Each of={props.group.items} key={(item: TranscriptItem) => transcriptItemKey(item)}>
            {(item: () => TranscriptItem, index: () => number) => (
              <Part item={item()} last={index() === props.group.items.length - 1} multi={multi()} bot={bot()} stage={stage()} onContextMenu={props.onContextMenu} />
            )}
          </Each>
        </View>
        <InterfaceChangeChip turnIds={turnIds()} recent={stage().snapshot.interface?.recent ?? []} api={runtime.client} />
      </View>
    </View>
  );
}

function Part(props: { item: TranscriptItem; last: boolean; multi: boolean; bot: Bot | undefined; stage: TranscriptStage; onContextMenu?: MessageMenuHandler }) {
  const streaming = () => (props.item.type === "streaming" ? props.item : null);
  const message = () => (props.item.type === "message" ? props.item : null);
  const arrive = arriveMotion(() => props.stage.arriving.has(transcriptItemKey(props.item)));
  return (
    <>
      <If when={streaming()}>
        {(live: () => Extract<TranscriptItem, { type: "streaming" }>) => {
          // The row keeps its object through the turn's tokens (`stage-rows.ts`): what it has said is read here, live.
          const turn = () => {
            const id = live().turn.id;
            return runtime.snapshot.turns.find((candidate) => candidate.id === id) ?? live().turn;
          };
          return (
            <View testID={`bot-part-${live().turn.id}`} class="w-full" style={{ opacity: arrive.opacity, transform: [...arrive.transform] }}>
              <StreamingReply turn={turn()} bot={props.bot} stage={props.stage} />
            </View>
          );
        }}
      </If>
      <If when={message()}>
        {(entry: () => MessageItem) => <Reply item={entry()} last={props.last} stage={props.stage} onContextMenu={props.onContextMenu} />}
      </If>
    </>
  );
}

function Reply(props: { item: MessageItem; last: boolean; stage: TranscriptStage; onContextMenu?: MessageMenuHandler }) {
  const t = () => copy();
  const stage = props.stage;
  const msg = () => props.item.message;
  const hovered = signal(false);
  const arrive = arriveMotion(() => stage.arriving.has(transcriptItemKey(props.item)));
  const ringed = () => stage.highlightedId === msg().id || stage.selectedMessageId === msg().id;
  /** The turn whose commands this part hosts, if it is this part. */
  const ranIn = () => (msg().turn_id && stage.commandHosts.has(msg().id) ? msg().turn_id : null);
  const duration = () => calculateBotDuration(msg(), stage.snapshot.messages, stage.snapshot.turns, stage.messageLookup);
  const took = () => {
    const d = duration();
    return d ? formatDurationMs(d.ms, t().chat.spanPart) : null;
  };
  const commands = () => {
    const id = ranIn();
    return id ? runtime.commandsOf(id) : [];
  };
  /**
   * A part before the last whose end would hold nothing but its time gives that line up: the time
   * shows with the hover actions, so the parts of one reply sit close together. Focus mode does
   * that for every part, and leaves the commands it ran out.
   */
  const quietFoot = () => stage.focus || (!props.last && !(ranIn() && commands().length));
  // What a finished turn ran stays under its last reply, read when it comes near.
  effect(() => {
    const id = ranIn();
    if (!id || (quietFoot() && stage.focus)) return;
    untracked(() => runtime.loadTurnCommands(id));
  });
  const annotations = () => stage.annotationIndex.get(msg().id);
  const botDm = () => (!stage.focus ? stage.botDmIndex.get(msg().id) : undefined);
  const replying = () => props.item.replying ?? [];

  /** On the right: how long it took, then when it came, last, a faint dot between. */
  const tail = () => (
    <View testID="msg-when" class="flex-row items-center gap-[6px] shrink-0 ml-auto">
      <If when={took()}>
        {(span: () => string) => (
          <>
            <View class="flex-row items-center gap-[6px]" tooltip={tip(t().chat.replyTime(span()))}>
              <Icon name="clock" size={12} class="tint-ink-muted" />
              <Text class="text-[12px] text-ink-muted">{span()}</Text>
            </View>
            <Text class="text-[12px] text-line-hover dark:text-muted-light" accessible={false}>
              ·
            </Text>
          </>
        )}
      </If>
      <View tooltip={tip(formatFullTimestamp(msg().created_at))}>
        <Text class="text-[12px] text-ink-muted">{formatMessageTime(msg().created_at)}</Text>
      </View>
    </View>
  );

  /** A middle part's time, beside the hover actions instead of on a line of its own. */
  const peek = () => (
    <If when={quietFoot()}>
      <View testID="msg-when-peek" class="flex-row items-center gap-[6px] mx-[4px]">
        <If when={took() && !stage.focus}>
          <Text class="text-[12px] text-ink-muted">{took()}</Text>
          <Text class="text-[12px] text-line-hover dark:text-muted-light" accessible={false}>
            ·
          </Text>
        </If>
        <View tooltip={tip(formatFullTimestamp(msg().created_at))}>
          <Text class="text-[12px] text-ink-muted">{formatMessageTime(msg().created_at)}</Text>
        </View>
      </View>
    </If>
  );

  return (
    <View
      testID={`msg-${msg().id}`}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      onContextMenu={(e) => props.onContextMenu?.(msg(), e.pagePosition)}
      class={`relative w-full ${ringed() ? "rounded-[16px]" : ""}`}
      style={{ ...ringStyle(ringed()), opacity: arrive.opacity, transform: [...arrive.transform] }}
    >
      <View testID="msg-reply" selectable class="w-full px-[2px]">
        <If when={hovered() && toolbarWanted()}>
          <MessageToolbar message={msg()} stage={stage} side="bot" onMenu={props.onContextMenu} extra={peek()} />
        </If>
        <QuoteRef message={msg()} selected={stage.selected} messageLookup={stage.messageLookup} who={stage.who} />
        <MarkdownBody
          source={stage.messageBody(msg())}
          options={stage.markdownOpts(msg())}
          copyLabel={t().chat.copyCode}
          copiedLabel={t().chat.copied}
          onOpenArtifact={(path) => stage.onOpenArtifact(path, undefined, msg().id)}
          onOpenImage={(path) => stage.openBodyImage(msg(), path)}
          loadArtifactImage={stage.loadBodyImage}
          onOpenProfile={stage.onOpenProfile}
        />
        <If when={stage.messageShowsAttachments(msg())}>
          <MessageAttachments
            attachments={msg().attachments}
            body={msg().body}
            api={runtime.client}
            onPreview={(att) => stage.onOpenArtifact(att.workspace_relpath, att, msg().id)}
            onOpenImage={(att, from) => stage.openInlineImage(att, att.workspace_relpath, from as never)}
          />
        </If>
        <If when={annotations()}>
          {(rows) => (
            <AnnotationCards
              annotations={rows()}
              locale={stage.locale}
              bots={stage.botsById}
              onOpen={stage.openAnnotation}
              onToggleStatus={stage.lockedComposer ? undefined : (row, status) => void stage.toggleAnnotation(msg().id, row, status)}
              error={stage.cardErrors[msg().id] ?? null}
              sourceLabel={stage.annotationSourceLabel(msg())}
              onOpenSource={() => stage.openAnnotationSource(msg())}
            />
          )}
        </If>
      </View>
      {/* The end of the message says what it ran, when it came and how long it took: one line while they fit, wrapping where they do not. */}
      <If when={!quietFoot()}>
        <View testID="msg-foot" class="mt-[12px] w-full px-[2px]">
          <If
            when={commands().length}
            else={
              <View class="flex-row flex-wrap items-center gap-x-[14px] gap-y-[6px] max-w-full">{tail()}</View>
            }
          >
            <CommandActivity rows={commands()} beside={tail()} />
          </If>
        </View>
      </If>
      <ReactionRow message={msg()} lockedComposer={stage.lockedComposer} />
      <If when={replying().length > 0}>
        <View role="text" class="max-w-full gap-[5px] mt-[5px]">
          <ReplyingIndicator
            entries={replying()}
            botsById={stage.botsById}
            isUser={false}
            thinkingText={stage.statusLabels.running}
            deletedText={t().top.deleted}
            onOpenProfile={stage.onOpenProfile}
          />
        </View>
      </If>
      <If when={botDm()}>
        {(sessions) => (
          <View class="gap-[5px] mt-[5px]">
            <BotDmEntry
              sessions={sessions()}
              botsById={stage.botsById}
              turns={stage.snapshot.turns}
              approvals={stage.snapshot.approvals}
              pendingJudgements={stage.snapshot.pendingJudgements}
              statusLabels={stage.statusLabels}
              rosterLabels={stage.rosterLabels}
              openedText={t().chat.botDmOpened}
              onOpen={(id) => void runtime.selectSession(id)}
              traceLabel={msg().task_id ? t().chat.showTrace : undefined}
              onShowTrace={msg().task_id ? () => stage.showMessageTrace(msg()) : undefined}
            />
          </View>
        )}
      </If>
    </View>
  );
}
