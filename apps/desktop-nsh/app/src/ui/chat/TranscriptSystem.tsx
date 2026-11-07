/**
 * A line from the app or about a turn (a stop, a failure, a hand-over's card) in the transcript
 * (`TranscriptSystem.svelte`): the app's mark or the Bot's portrait, the name and its tag, and a
 * quiet card with the words, a work question, the files and buttons it carries, and a Continue
 * button where a turn can go on.
 *
 * The Svelte row's text-selection handlers (`mousedown`, `touchstart`, `contextmenu` through the
 * stage) took DOM events; here a secondary press goes to `onContextMenu` with where it was, for
 * the shell to open the message's menu. A row that has just arrived rises into place; a found line
 * keeps its ring without the pulse.
 */
import { Text, View } from "nsh";
import type { Message, WorkQuestionControl } from "@real-bot/protocol";
import {
  canContinueInterrupt,
  formatFullTimestamp,
  formatMessageTime,
  isAppLine,
  isInterruptNote,
  isUnreachableNote,
  type TranscriptGroup,
} from "../../m/chat/chat-view.ts";
import type { TranscriptStage } from "../../m/chat/transcript-stage.ts";
import { copy, runtime } from "../../runtime";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { tip } from "../tip";
import { ControlActions } from "./ControlActions";
import { MessageAttachments } from "./MessageAttachments";
import { ReplyingIndicator } from "./ReplyingIndicator";
import { WorkQuestionCard } from "./WorkQuestionCard";
import { arriveMotion, Badge, BotPortrait, ringStyle, SenderName, type MessageMenuHandler } from "./transcript-parts";

export function TranscriptSystem(props: {
  group: TranscriptGroup;
  stage: TranscriptStage;
  /** A secondary press (right click, long press) on the row: the message's menu, at `position`. */
  onContextMenu?: MessageMenuHandler;
}) {
  const message = (): Message | null => {
    const item = props.group.items[0];
    return item && item.type === "message" ? item.message : null;
  };
  return <If when={message()}>{(msg: () => Message) => <Row message={msg} stage={props.stage} item={props.group.items[0]!} onContextMenu={props.onContextMenu} />}</If>;
}

function Row(props: {
  message: () => Message;
  stage: TranscriptStage;
  item: TranscriptGroup["items"][number];
  onContextMenu?: MessageMenuHandler;
}) {
  const t = () => copy();
  const msg = props.message;
  const stage = props.stage;
  const bot = () => stage.botsById.get(msg().author);
  const appLine = () => isAppLine(msg());
  const isUnreachable = () => isUnreachableNote(msg());
  const isInterrupt = () => isInterruptNote(msg());
  const showContinue = () =>
    msg().control?.kind !== "work_question" &&
    canContinueInterrupt(msg(), stage.snapshot.turns, {
      locked: stage.lockedComposer,
      readOnly: stage.selectedKind === "bot-bot",
      hasLiveTurnForBot: stage.liveTurnsHere.some((turn) => turn.bot_id === msg().author),
      announced: stage.announced,
    });
  const continueHint = () =>
    isInterrupt() ? t().stream.continueInterruptHint : isUnreachable() ? t().stream.continueUnreachableHint : t().stream.continueFailedHint;
  const arrive = arriveMotion(() => stage.arriving.has(msg().id));
  const ringed = () => stage.highlightedId === msg().id || stage.selectedMessageId === msg().id;
  const replying = () => {
    const item = props.item;
    return item.type === "message" ? (item.replying ?? []) : [];
  };

  return (
    <View
      testID={`system-row-${msg().id}`}
      onContextMenu={(e) => props.onContextMenu?.(msg(), e.pagePosition)}
      class={`flex-row items-start gap-[10px] self-start w-full ${narrowWindow() ? "" : "max-w-[84%]"} ${ringed() ? "rounded-(--radius-md)" : ""}`}
      style={{ ...ringStyle(ringed()), opacity: arrive.opacity, transform: [...arrive.transform] }}
    >
      <If when={appLine() || !stage.sidesSayWho}>
        <If
          when={appLine()}
          else={<BotPortrait bot={bot()} author={msg().author} stage={stage} />}
        >
          <View class="shrink-0 items-center">
            <View
              testID="app-avatar"
              accessible={false}
              class="w-[32px] h-[32px] rounded-full items-center justify-center bg-pane border border-line"
              style={{ boxShadow: shadow("xs") }}
            >
              <BrandMark size={20} />
            </View>
          </View>
        </If>
      </If>
      <View class="flex-1 min-w-0">
        <View class="flex-row items-center gap-[6px] mb-[4px] px-[2px] min-w-0">
          <If
            when={appLine()}
            else={
              <If when={!stage.sidesSayWho}>
                <SenderName bot={bot()} label={stage.who(msg())} stage={stage} />
                <Badge>{t().chat.botBadge}</Badge>
              </If>
            }
          >
            <Text class="text-[13px] font-semibold text-ink">{t().chat.appName}</Text>
            <Badge>{t().chat.appBadge}</Badge>
          </If>
          <If when={!stage.focus}>
            <View tooltip={tip(formatFullTimestamp(msg().created_at))} class={`shrink-0 ${narrowWindow() ? "ml-auto" : "ml-[2px]"}`}>
              <Text class="text-[11px] font-mono text-ink-muted">{formatMessageTime(msg().created_at)}</Text>
            </View>
          </If>
        </View>
        <View
          testID="system-card"
          role="region"
          accessibilityLabel={appLine() ? t().chat.appLineLabel : undefined}
          selectable
          class={`self-start max-w-full items-start gap-[6px] border rounded-(--radius-md) ${
            showContinue() ? "px-[14px] py-[10px] bg-pane border-line" : isUnreachable() ? "px-[12px] py-[8px] bg-warn-bg border-warn-line" : "px-[12px] py-[8px] bg-line-subtle border-line"
          }`}
          style={showContinue() ? { boxShadow: shadow("xs") } : undefined}
        >
          <If
            when={msg().control?.kind === "work_question" ? (msg().control as WorkQuestionControl) : null}
            else={
              <>
                {/*
                  The icon sits in the text's left margin rather than beside it in a row: NSH 0.4 sizes
                  wrapping text in a row inside a box that hugs its content at the text's one-line width,
                  so a long note ran out of its card over what follows (PORTING.md).
                */}
                <View class="max-w-full" style={{ paddingLeft: isUnreachable() ? 24 : isInterrupt() ? 20 : 0 }}>
                  <If when={isUnreachable()} else={<If when={isInterrupt()}><Icon name="square" size={12} class="absolute left-0 top-[3px] tint-ink-muted" /></If>}>
                    <Icon name="alert-circle" size={16} class="absolute left-0 top-[1px] tint-warn" />
                  </If>
                  <Text testID="system-body" class={`text-[13px] leading-[1.4] ${isUnreachable() ? "text-warn-text" : "text-ink-secondary"}`}>
                    {msg().body}
                  </Text>
                </View>
                {/* A card about a hand-over carries its files: what you approve is right there to open. */}
                <If when={stage.messageShowsAttachments(msg())}>
                  <MessageAttachments
                    attachments={msg().attachments}
                    body={msg().body}
                    api={runtime.client}
                    onPreview={(att) => stage.onOpenArtifact(att.workspace_relpath, att, msg().id)}
                    onOpenImage={(att, from) => stage.openInlineImage(att, att.workspace_relpath, from as never)}
                    onOpenFile={appLine() ? (att) => stage.openInlineFile(att, msg().id) : undefined}
                    cards={appLine()}
                  />
                </If>
                <If when={msg().control}>
                  <ControlActions
                    control={msg().control}
                    holds={stage.snapshot.holds}
                    botName={stage.botNameOf}
                    disabled={!stage.connected}
                    onAct={(action, taskId, note) => stage.pressControl(msg(), action, taskId, note)}
                  />
                </If>
              </>
            }
          >
            {(question: () => WorkQuestionControl) => {
              const plan = () => runtime.attributionPlans[msg().session_id]?.find((row) => row.id === question().task_id);
              return (
                <WorkQuestionCard
                  control={question()}
                  botName={bot()?.name ?? msg().author}
                  planName={plan()?.title ?? question().task_id}
                  ticketName={question().ticket_id ? (plan()?.tickets.find((row) => row.id === question().ticket_id)?.title ?? question().ticket_id!) : null}
                  disabled={!stage.connected || stage.lockedComposer}
                  readOnly={stage.selectedKind === "bot-bot" || Boolean(stage.selected?.archived_at)}
                  onAnswer={(body) => runtime.answerWorkQuestion(msg().id, body)}
                />
              );
            }}
          </If>
          <If when={showContinue()}>
            <View class="flex-row items-center mt-[2px]">
              <View
                role="button"
                testID="continue-turn"
                accessibilityLabel={t().stream.continueInterrupt}
                tooltip={tip(continueHint())}
                disabled={!stage.connected || stage.view?.sending}
                onPress={() => void runtime.continueInterrupt(msg().id, stage.selected?.id)}
                class="group flex-row items-center gap-[6px] h-[28px] px-[12px] bg-accent-tint border border-accent-border rounded-(--radius-sm) hover:bg-brand hover:border-brand active:bg-accent-active disabled:opacity-50"
              >
                <Icon name="play" size={12} class="shrink-0 tint-brand group-hover:tint-on-accent" />
                <Text class="text-[12px] font-medium text-brand group-hover:text-on-accent">{t().stream.continueInterrupt}</Text>
              </View>
            </View>
          </If>
        </View>
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
      </View>
    </View>
  );
}
