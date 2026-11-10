/**
 * Your lines in the transcript (`TranscriptUserGroup.svelte`), one bubble or a run of them, with
 * what hangs under each: the quote, the Markdown body, the files, the annotation cards, the time and
 * 「已编辑」, a queued line's row, the earlier versions, the buttons of a possible control, the
 * reactions, who is thinking about it, and a Bot↔Bot direct it opened. A withdrawn line is a notice
 * and the way back to its words; a line being changed is a field in place (`MessageEditor`).
 *
 * Differences from the Svelte row (which took DOM events): a secondary press, and the hover pill's
 * "more", go to `onContextMenu(message, position)` for the shell to open the message's menu; the
 * pill shows while the pointer is over the line (`transcript-parts`); the found-line pulse is a
 * still ring; the run's dashed divider is a solid hairline; `data-ui="bubble-you"` (a profile CSS
 * hook) has no counterpart.
 */
import { signal, Text, View } from "nsh";
import type { TranscriptGroup } from "../../m/chat/chat-view.ts";
import { transcriptItemKey, type TranscriptItem } from "../../m/chat/transcript.ts";
import type { TranscriptStage } from "../../m/chat/transcript-stage.ts";
import { copy, runtime } from "../../runtime";
import { AnnotationCards } from "../annotations/AnnotationCards";
import { MarkdownBody } from "../MarkdownBody";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { BotDmEntry } from "./BotDmEntry";
import { ControlActions } from "./ControlActions";
import { MessageAttachments } from "./MessageAttachments";
import { MessageEditor } from "./MessageEditor";
import { QuoteRef } from "./QuoteRef";
import { ReactionRow } from "./ReactionRow";
import { ReplyingIndicator } from "./ReplyingIndicator";
import { arriveMotion, MessageToolbar, ringStyle, toolbarWanted, type MessageMenuHandler } from "./transcript-parts";
import { LineButton, MessageFoot, QueuedRow, VersionsBlock } from "./transcript-user-parts";

export function TranscriptUserGroup(props: {
  group: TranscriptGroup;
  stage: TranscriptStage;
  /** A secondary press (right click, long press) on a line, or the pill's "more": the message's menu, at `position`. */
  onContextMenu?: MessageMenuHandler;
}) {
  const t = () => copy();
  const multi = () => props.group.items.length > 1;
  return (
    <View testID="bubble-you" class="flex-row items-start justify-end gap-[10px] w-full">
      <View class="flex-1 min-w-0">
        <If when={multi() && !props.stage.focus}>
          <View class="flex-row justify-end items-center gap-[6px] mb-[4px] px-[2px]">
            <View class="px-[6px] py-[1px] rounded-full bg-chip border border-line">
              <Text testID="segment-count" class="text-[10px] font-mono font-semibold text-ink-muted">
                {t().chat.messageCount(props.group.items.length)}
              </Text>
            </View>
          </View>
        </If>
        <View class="gap-4 w-full items-end">
          <Each of={props.group.items} key={(item: TranscriptItem) => transcriptItemKey(item)}>
            {(item: () => TranscriptItem, index: () => number) => (
              <If when={item().type === "message" ? (item() as Extract<TranscriptItem, { type: "message" }>) : null}>
                {(entry) => <Segment item={entry} first={index() === 0} multi={multi()} stage={props.stage} onContextMenu={props.onContextMenu} />}
              </If>
            )}
          </Each>
        </View>
      </View>
    </View>
  );
}

type MessageItem = Extract<TranscriptItem, { type: "message" }>;

function Segment(props: {
  item: () => MessageItem;
  first: boolean;
  multi: boolean;
  stage: TranscriptStage;
  onContextMenu?: MessageMenuHandler;
}) {
  const t = () => copy();
  const stage = props.stage;
  const msg = () => props.item().message;
  const hovered = signal(false);
  const editing = () => stage.editingHere(msg());
  const arrive = arriveMotion(() => stage.arriving.has(transcriptItemKey(props.item())));
  const ringed = () => stage.highlightedId === msg().id || stage.selectedMessageId === msg().id;
  const replying = () => props.item().replying ?? [];
  const botDm = () => (!msg().withdrawn_at && !stage.focus ? stage.botDmIndex.get(msg().id) : undefined);
  const annotations = () => stage.annotationIndex.get(msg().id);
  const grouped = () => props.multi && !props.first;

  return (
    <>
      <View
        testID={`msg-${msg().id}`}
        onMouseEnter={() => hovered.set(true)}
        onMouseLeave={() => hovered.set(false)}
        onContextMenu={(e) => props.onContextMenu?.(msg(), e.pagePosition)}
        class={`relative items-end ${editing() ? "w-full" : narrowWindow() ? "max-w-full" : "max-w-[80%]"} ${ringed() ? "rounded-[16px]" : ""} ${
          grouped() ? "mt-[4px] pt-[8px] border-t border-line-subtle" : ""
        }`}
        style={{ ...ringStyle(ringed()), opacity: arrive.opacity, transform: [...arrive.transform] }}
      >
        <If
          when={!msg().withdrawn_at}
          else={
            <>
              {/* Taken back before any Bot read it (ADR 0069): the words wait for you, not for a Bot. */}
              <View testID="msg-withdrawn" class="flex-row items-baseline justify-end gap-[10px] px-[2px] py-[2px]">
                <Text class="text-[12px] text-ink-muted">{t().chat.lineWithdrawn}</Text>
                <If when={!stage.lockedComposer}>
                  <LineButton testID="msg-re-edit" label={t().chat.reEditLine} onPress={() => stage.reEditLine(msg())} />
                </If>
              </View>
              <MessageFoot message={msg()} stage={stage} />
            </>
          }
        >
          <View
            testID="msg-bubble"
            selectable
            class={`max-w-full px-[14px] py-[10px] border ${editing() ? "w-full bg-pane border-accent-border" : "bg-you border-transparent"} ${
              grouped()
                ? "rounded-tl-(--radius-lg) rounded-tr-(--radius-md) rounded-br-(--radius-lg) rounded-bl-(--radius-lg)"
                : "rounded-tl-(--radius-lg) rounded-tr-(--radius-xs) rounded-br-(--radius-lg) rounded-bl-(--radius-lg)"
            }`}
            style={editing() ? undefined : { boxShadow: shadow("xs") }}
          >
            <If when={hovered() && !editing() && toolbarWanted()}>
              <MessageToolbar
                message={msg()}
                stage={stage}
                side="you"
                onMenu={props.onContextMenu}
                onEdit={stage.editable(msg()) ? () => stage.startEdit(msg()) : undefined}
              />
            </If>
            <QuoteRef message={msg()} selected={stage.selected} messageLookup={stage.messageLookup} who={stage.who} inverted={!editing()} />
            <If
              when={editing() && stage.view && stage.selected ? { view: stage.view!, id: stage.selected!.id } : null}
              else={
                <MarkdownBody
                  source={stage.messageBody(msg())}
                  options={stage.markdownOpts(msg())}
                  copyLabel={t().chat.copyCode}
                  copiedLabel={t().chat.copied}
                  inverted
                  onOpenArtifact={(path) => stage.onOpenArtifact(path, undefined, msg().id)}
                  onOpenImage={(path, from) => stage.openBodyImage(msg(), path, from as never)}
                  loadArtifactImage={stage.loadBodyImage}
                  onOpenProfile={stage.onOpenProfile}
                />
              }
            >
              {(edit) => (
                <MessageEditor
                  value={edit().view.editDraft}
                  saving={edit().view.editSaving}
                  error={stage.editErrorText}
                  onInput={(value) => {
                    edit().view.editDraft = value;
                    edit().view.editError = null;
                  }}
                  onSave={() => void runtime.saveEdit(edit().id)}
                  onCancel={() => runtime.cancelEdit(edit().id)}
                />
              )}
            </If>
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
          <MessageFoot message={msg()} stage={stage} />
          <QueuedRow message={msg()} stage={stage} />
          <VersionsBlock message={msg()} stage={stage} />
          {/* What the reader made of your line (passed, rework) is not said under it (2026-10-14): the job's flow shows it. */}
          <If when={msg().control?.kind === "possible_control" && !stage.lockedComposer}>
            <ControlActions
              control={msg().control}
              holds={stage.snapshot.holds}
              botName={stage.botNameOf}
              align="end"
              disabled={!stage.connected}
              onAct={(action, taskId) => runtime.controlAction(msg().id, action, taskId)}
            />
          </If>
          <ReactionRow message={msg()} right lockedComposer={stage.lockedComposer} />
          <If when={replying().length > 0}>
            <View role="text" class="max-w-full items-end gap-[5px] mt-[5px]">
              <ReplyingIndicator
                entries={replying()}
                botsById={stage.botsById}
                isUser
                thinkingText={stage.statusLabels.running}
                deletedText={t().top.deleted}
                onOpenProfile={stage.onOpenProfile}
              />
            </View>
          </If>
        </If>
      </View>
      {/* Outside the bubble's column, across the whole conversation, so it centres there and not under your words. */}
      <If when={botDm()}>
        {(sessions) => (
          <View class="self-stretch gap-[5px] mt-[5px]">
            <BotDmEntry
              sessions={sessions()}
              botsById={stage.botsById}
              turns={stage.snapshot.turns}
              approvals={stage.snapshot.approvals}
              pendingJudgements={stage.snapshot.pendingJudgements}
              isUser
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
    </>
  );
}
