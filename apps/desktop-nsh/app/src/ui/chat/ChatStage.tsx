/**
 * A conversation's body (`ChatStage.svelte`): the transcript, the welcome of an empty one, and the
 * composer under it. The transcript is a virtualised, bottom-anchored `List` of the ported groups
 * (`TranscriptBotGroup`, `TranscriptUserGroup`, `TranscriptSystem`, `TranscriptAsk`,
 * `TranscriptApproval`) with the date and "New" lines, the delegation records of a Bot↔Bot direct and
 * the line that says an earlier page is on its way. Scrolling to the top pages older messages in
 * (`runtime.loadOlderMessages`); a reader at the newest line stays there as lines stream in; away
 * from it the scroll-to-bottom button and, for a card waiting on you out of sight, the waiting
 * chip appear (both on the composer). The message's menu, the picture enlarged and the file opened
 * from its chip are `stage-overlays.tsx`. The parts: `stage-context` (what is read of the runtime),
 * `stage-actions` (what the rows ask), `stage-object` (the rows' `TranscriptStage`), `stage-scroll`,
 * `stage-rows`, `stage-reading`, `stage-parts`.
 *
 * Differences from the Svelte stage, all from the platform: no history window (the list mounts only
 * what is near); the composer sits under the list in the column instead of floating over it (no
 * backdrop blur to see the transcript through), so no room is kept for it; the index strip's active
 * tick and the waiting chip read which rows are viewable instead of measuring rectangles; a secondary
 * press is `onContextMenu` of the groups; the selected text of the menu is not read (NSH has no
 * selection to ask for); the file overlay has no preview inside (see `stage-overlays`).
 */
import { cleanup, computed, List, signal, View, type ViewRef } from "nsh";
import type { Attachment, SessionSummary } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { Button } from "../Button";
import { EmptyState } from "../EmptyState";
import { narrowWindow } from "../Modal";
import { workspaceDropTarget } from "../workspace-drag";
import { ChatWelcome } from "./ChatWelcome";
import { Composer, type ComposerHandle } from "./Composer";
import { MessageIndex } from "./MessageIndex";
import { buildStage } from "./stage-object";
import { createStageActions } from "./stage-actions";
import { createStageContext } from "./stage-context";
import { StageOverlays } from "./stage-overlays";
import { DelegationBlock, HistoryLoading, StageRowView } from "./stage-parts";
import { trackReading } from "./stage-reading";
import { activeMessageId, createRowKeeper, hiddenWaitingFromRows, inverseIndexOf, invertedRows, stageRows } from "./stage-rows";
import { createStageScroll } from "./stage-scroll";
import { settled } from "../workbench/drag-settle";
import { onGlassCard } from "../glass";

export function ChatStage(props: {
  selected: SessionSummary | null;
  onOpenProfile: (botId: string) => void;
  onOpenArtifact: (relpath: string, att?: Attachment, messageId?: string, forceTree?: boolean) => void;
  onCreateBot: () => void;
}) {
  const t = () => copy();
  /** On a glass card (`glass.ts`) this leaves its ground to the card, as `content-glass.css` does. */
  const glassCard = onGlassCard();
  const selected = () => props.selected;
  const ctx = createStageContext(selected);
  const view = ctx.view;
  const highlightedId = () => view()?.highlightedMessageId ?? null;

  let composer: ComposerHandle | null = null;
  // Files dragged in from the workspace tree land on the composer's box, as `Composer.svelte` registered
  // its element (the shared `Composer` leaves the registering to its host, which owns the frame).
  let composerBox: ViewRef | null = null;
  cleanup(
    workspaceDropTarget(() => composerBox, {
      accepts: () => composer?.takesWorkspaceItems() ?? false,
      drop: (items) => composer?.stageWorkspaceItems(items),
    }),
  );
  const width = signal(0);
  const stageHeight = signal(0);

  const hasOlder = () => Boolean(view()?.hasOlderMessages);
  const rows = () => stageRows(ctx.groups(), { earlier: hasOlder(), delegations: ctx.delegationsShown(), newMarkId: ctx.newMarkId() });
  /** Newest first, each row the object it was while it shows the same (the list rebuilds a new one). */
  const keepRows = createRowKeeper();
  const inverted = computed(() => keepRows(invertedRows(rows())));

  const scroll = createStageScroll({
    sessionId: ctx.sessionId,
    highlightedId,
    highlightToken: () => view()?.searchHighlightToken ?? 0,
    indexOf: (id) => inverseIndexOf(inverted(), id),
    activeFor: (viewable, atEnd) => activeMessageId(inverted(), viewable, atEnd, ctx.lastMessageId()),
    hasOlder,
    olderLoading: () => Boolean(view()?.olderLoading),
    loadOlder: () => void runtime.loadOlderMessages(selected()?.id),
  });
  const toBottom = () => {
    scroll.scrollToBottom(false);
    setTimeout(() => scroll.scrollToBottom(false), 120);
  };
  const actions = createStageActions(ctx, {
    selected,
    onOpenArtifact: (...args) => props.onOpenArtifact(...args),
    focusComposer: () => composer?.focus(),
    toBottom,
  });
  const stage = buildStage(ctx, actions, {
    selected,
    highlightedId,
    onOpenProfile: (id) => props.onOpenProfile(id),
    onOpenArtifact: (...args) => props.onOpenArtifact(...args),
  });
  trackReading({ sessionId: ctx.sessionId, lastMessageId: ctx.lastMessageId, atLatest: scroll.stick, report: true });

  const hidden = () => hiddenWaitingFromRows(ctx.waiting(), inverted(), scroll.viewable());
  const empty = () => ctx.stream().length === 0;
  /** What the body shows: the list, the skeleton of a history on its way, or the welcome of an empty conversation. */
  const mode = (): "none" | "loading" | "welcome" | "list" => {
    if (!selected()) return "none";
    if (empty() && view()?.historyLoading) return "loading";
    if (empty() && ctx.delegations().length === 0) return "welcome";
    return "list";
  };
  const phone = settled(() => width() > 0 && width() <= 680);
  const sideRoom = () => (ctx.showMessageIndex() && !narrowWindow() ? 40 : phone() ? 12 : 24);
  const openArtifact = (path: string, messageId?: string) => props.onOpenArtifact(path, undefined, messageId);

  return (
    <View
      testID="chat-stage"
      class={`flex-1 min-h-0 relative overflow-hidden ${glassCard() ? "" : "bg-pane"}`}
      onLayout={(e) => {
        width.set(e.bounds.size.width);
        stageHeight.set(e.bounds.size.height);
      }}
    >
      <View class="flex-1 min-h-0">
        <If when={mode() === "none"}>
          <EmptyState title={t().top.pickSession} hint={t().top.pickSessionHint}>
            <Button variant="primary" icon="user-plus" onPress={props.onCreateBot}>
              {t().sidebar.addBot}
            </Button>
          </EmptyState>
        </If>
        <If when={mode() === "loading" || mode() === "welcome"}>
          <View class="flex-1 min-h-0">
            <If when={ctx.delegationsShown() ? selected() : null}>
              {(session: () => SessionSummary) => <DelegationBlock ctx={ctx} session={session()} onOpenArtifact={openArtifact} />}
            </If>
            <If when={mode() === "loading"} else={<StageWelcome ctx={ctx} stage={actions} onOpenProfile={props.onOpenProfile} selected={selected()} />}>
              <HistoryLoading />
            </If>
          </View>
        </If>
        <If when={mode() === "list"}>
          {/* Another conversation is another list: it opens at its newest line. */}
          <Each of={[ctx.sessionId()]} key={(id: string | null) => id ?? ""}>
            {() => (
              <List
                testID="transcript"
                ref={scroll.ref}
                each={inverted()}
                inverted
                keyExtractor={(row) => row.id}
                class={`flex-1 ${glassCard() ? "" : "bg-pane"}`}
                contentClass="py-5 gap-4"
                contentStyle={{ paddingLeft: sideRoom(), paddingRight: sideRoom(), paddingTop: phone() ? 14 : 20 }}
                estimatedItemSize={96}
                onScroll={scroll.onScroll}
                onViewableItemsChange={(info) => scroll.onViewable(info.viewableItems.map((token) => token.index))}
                onLoadMore={scroll.onLoadMore}
              >
                {(row) => (
                  <StageRowView
                    row={row()}
                    stage={stage}
                    ctx={ctx}
                    loadingEarlier={Boolean(view()?.olderLoading)}
                    onContextMenu={actions.openMenu}
                    onOpenArtifact={openArtifact}
                  />
                )}
              </List>
            )}
          </Each>
        </If>
        <If when={ctx.showMessageIndex() && selected()}>
          <Each of={[ctx.sessionId()]} key={(id: string | null) => id ?? ""}>
            {() => (
              <MessageIndex
                marks={ctx.indexMarks()}
                activeId={scroll.active()}
                locale={ctx.locale()}
                label={t().stream.messageIndex}
                emptyLabel={t().stream.messageIndexEmpty}
                sender={(mark) => (mark.kind === "system" ? (ctx.locale() === "zh" ? "系统" : "System") : ctx.whoAuthor(mark.author))}
                hasEarlier={hasOlder()}
                loading={Boolean(view()?.olderLoading)}
                earlierLabel={view()?.olderLoading ? t().stream.loadingEarlier : t().stream.loadEarlier}
                onLoadEarlier={() => void runtime.loadOlderMessages(selected()?.id)}
                onJump={scroll.jumpToIndexMark}
                maxHeight={Math.max(120, stageHeight() - 220)}
              />
            )}
          </Each>
        </If>
      </View>
      <View ref={(node: ViewRef | null) => (composerBox = node)} testID="composer-drop">
        <Composer
          selected={selected()}
          showScrollBottom={scroll.showBottom()}
          onScrollToBottom={() => scroll.scrollToBottom(true)}
          onSend={actions.sendFromComposer}
          onPickPrompt={actions.pickStarterPrompt}
          onEditLast={actions.editLastLine}
          hiddenWaiting={hidden()}
          onJumpWaiting={(id) => scroll.jumpToIndexMark({ id })}
          onHandle={(handle) => (composer = handle)}
        />
      </View>
      <StageOverlays ctx={ctx} actions={actions} selected={selected()} onOpenProfile={props.onOpenProfile} onOpenArtifact={props.onOpenArtifact} />
    </View>
  );
}

/** The welcome of an empty conversation, picking a starter fills the draft. */
function StageWelcome(props: {
  ctx: ReturnType<typeof createStageContext>;
  stage: ReturnType<typeof createStageActions>;
  selected: SessionSummary | null;
  onOpenProfile: (botId: string) => void;
}) {
  return (
    <If when={props.selected}>
      {(session: () => SessionSummary) => (
        <ChatWelcome
          selected={session()}
          selectedKind={props.ctx.selectedKind()}
          selectedPeerBot={props.ctx.selectedPeerBot()}
          locale={props.ctx.locale()}
          fileDrop={props.ctx.fileDrop()}
          lockedComposer={props.ctx.lockedComposer()}
          onOpenProfile={props.onOpenProfile}
          pickStarterPrompt={props.stage.pickStarterPrompt}
          titleOf={props.ctx.titleOf}
        />
      )}
    </If>
  );
}
