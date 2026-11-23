/**
 * A project session's conversation (`ProjectChat.svelte`, ADR 0095): you and the agent in a
 * directory, as in the agent's own desktop app. It has no Bot, so none of the Bot stage applies: your
 * lines on the right, the agent's on the left as Markdown, the app's centred. The run going on is a
 * Bot's working bubble at the end with the questions and the approval it waits on under it; Stop is
 * in the composer.
 * Pictures and files go with a line; Plan mode is a switch in the composer (Shift+Tab); typing `/`
 * lists the agent's commands (ADR 0098); what each agent has besides (accounts, plan mode, stopping one
 * task alone) is `PROJECT_AGENT_CAPS` (ADR 0099, 0111, 0115).
 * What it runs in the background and its subagents read as a Bot's work does. The header is the
 * pane's or the page's own.
 *
 * It follows a Bot's direct, so it is the same parts: the virtualised, bottom-anchored `List` (see
 * `ChatStage`, `stage-scroll`), the index strip, the reading report (`stage-reading`), the enlarged
 * picture, and the composer's box and buttons (`project-chat-composer`). The lines are
 * `project-chat-lines`, the run's bubble `project-chat-working`, what it reads `project-chat-state`.
 * Differences from the Svelte one are `ChatStage`'s: the composer sits under the list, the active
 * tick is read from the rows viewable.
 */
import { cleanup, Clipboard, computed, effect, List, Overlay, signal, Text, View, type Point, type ViewRef } from "nsh";
import type { Attachment, Message, SessionSummary } from "@real-bot/protocol";
import { focusMode } from "../../m/chat/focus-mode.svelte.ts";
import { INDEX_MIN_MARKS, messageIndexMarks, type IndexMark } from "../../m/chat/message-index.ts";
import { ReadMark } from "../../m/chat/read-mark.ts";
import { showToast } from "../../m/toast.svelte.ts";
import { USER_MEMBER } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { stepIn } from "../../platform/page-route";
import { BottomSheet, SheetItem } from "../BottomSheet";
import { EmptyState } from "../EmptyState";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { rovingMenu } from "../sidebar/menu-roving";
import { MENU_ITEM, MENU_SURFACE, shadow } from "../styles";
import { imageOrigin, type PressedPicture } from "./image-origin";
import { TranscriptClip } from "./message-pill";
import { MessageImageLightbox, type ImageOrigin } from "./MessageImageLightbox";
import { MessageIndex } from "./MessageIndex";
import { ProjectSubagentDialog } from "./ProjectSubagentDialog";
import { EarlierLine, ProjectAskGroup, ProjectLine, ProjectTasksEnd, type ProjectRow } from "./project-chat-lines";
import { ProjectComposer, type ProjectComposerHandle } from "./project-chat-composer";
import { workspaceDropTarget } from "../workspace-drag";
import type { ReadUris } from "./composer-drop";
import { createProjectState } from "./project-chat-state";
import { createProjectRowKeeper, lineRows, sameRows } from "./project-rows";
import { ProjectWorking } from "./project-chat-working";
import { HistoryLoading } from "./stage-parts";
import { trackReading } from "./stage-reading";
import { createStageScroll } from "./stage-scroll";
import { createSendFlight, SendFlightLayer, SendFlightOf } from "./send-flight";
import type { HiddenWaiting } from "./waiting-jump";
import { settled } from "../workbench/drag-settle";
import { PaneMenu } from "../workbench/pane-menu";
import { onGlassCard } from "../glass";

export function ProjectChat(props: {
  selected: SessionSummary;
  /** Opens a file the agent cites, as a Bot conversation's do; given the absolute path the Mac found. */
  onOpenArtifact: (relpath: string, att?: Attachment, messageId?: string) => void;
  /** Reads what files dropped from Finder name; by default through `fs` (a story brings its own). */
  readFiles?: ReadUris;
}) {
  const t = () => copy();
  /** On a glass card (`glass.ts`) this leaves its ground to the card, as `content-glass.css` does. */
  const glassCard = onGlassCard();
  /** In a pane, right-clicking blank transcript space opens the pane's menu (`pane-menu.ts`); lines open `project-line-menu`. */
  const paneMenu = PaneMenu();
  const selected = () => props.selected;
  const state = createProjectState(selected, (...args) => props.onOpenArtifact(...args));
  const view = state.view;
  const width = signal(0);
  const stageHeight = signal(0);
  /** Files from Finder dropped anywhere on the conversation go to the composer, as on a Bot's stage. */
  let composer: ProjectComposerHandle | null = null;
  const fileOver = signal(false);
  // Rows dragged from a file tree land on the box, as on a Bot's stage (`ChatStage`).
  let composerBox: ViewRef | null = null;
  cleanup(
    workspaceDropTarget(() => composerBox, {
      accepts: () => composer?.takesWorkspaceItems() ?? false,
      drop: (items) => composer?.stageWorkspaceItems(items),
    }),
  );
  const image = signal<{ sessionId: string; attachment: Attachment; origin: ImageOrigin | null; placeholder: string | null } | null>(null);
  const copiedId = signal<string | null>(null);
  const lineMenu = signal<{ message: Message; at: Point; selected: string } | null>(null);
  /** Most recent text selected inside the transcript's single selection container (used by Copy in `project-line-menu`). */
  let selectedText = "";
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(copyTimer));

  function copyLine(message: Message, text = message.body): void {
    void Clipboard.writeText(text).catch(() => {});
    copiedId.set(message.id);
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      if (copiedId() === message.id) copiedId.set(null);
    }, 1800);
  }
  function copyLineId(message: Message): void {
    void Clipboard.writeText(message.id).catch(() => {});
    showToast(t().chat.copied, { tone: "info" });
  }
  function openLineMenu(message: Message, at: Point): void {
    lineMenu.set({ message, at, selected: selectedText });
  }

  const hasOlder = () => Boolean(view().hasOlderMessages);
  const lines = state.lines;
  const readMark = new ReadMark();
  const newMarkId = computed(() =>
    readMark.observe(
      selected().id,
      selected().last_read_at,
      lines().map((message) => ({ type: "message" as const, message })),
    ),
  );
  /**
   * Oldest first: the earlier line, each line with its day line (questions asked together are one),
   * what a run started with no line to hang under, the run going on with the questions it waits on.
   */
  const rows = (): ProjectRow[] => {
    const out: ProjectRow[] = [];
    if (hasOlder()) out.push({ id: "earlier", kind: "earlier" });
    out.push(...lineRows(state.shownLines(), newMarkId()));
    if (state.placed().end.length > 0 && !focusMode.on) out.push({ id: "tasks", kind: "tasks" });
    if (state.run() && state.live()) out.push({ id: "working", kind: "working" });
    return out;
  };
  /** Newest first, each row the object it was while it shows the same, and the same list while no row changed (`project-rows.ts`). */
  const keepRows = createProjectRowKeeper();
  const inverted = computed(() => keepRows(rows().slice().reverse()), { equals: sameRows });

  /** The message index: a tick for each line, yours in the accent. Every line is a row, so a press only scrolls. */
  const indexMarks = () => messageIndexMarks(lines().map((message) => ({ type: "message" as const, message })));
  const showMessageIndex = () => indexMarks().length >= INDEX_MIN_MARKS || hasOlder();
  const indexSender = (mark: IndexMark) => {
    if (mark.author === USER_MEMBER) return t().common.you;
    if (mark.kind === "system" || mark.author === "app") return t().common.system;
    return state.agentName();
  };
  const lastLineId = () => lines().at(-1)?.id ?? null;

  const scroll = createStageScroll({
    sessionId: state.sessionId,
    highlightedId: () => null,
    highlightToken: () => 0,
    // A question is in its group's row, or at the run's end while the run waits on it.
    indexOf: (id) => {
      const rowsNow = inverted();
      const at = rowsNow.findIndex((row) => (row.kind === "line" && row.id === id) || (row.kind === "asks" && row.messages.some((message) => message.id === id)));
      return at >= 0 || !state.openAsks().some((message) => message.id === id) ? at : rowsNow.findIndex((row) => row.kind === "working");
    },
    activeFor: (viewable, atEnd) => {
      if (atEnd) return lastLineId();
      const rowsNow = inverted();
      const oldest = viewable.length > 0 ? Math.max(...viewable) : -1;
      for (let i = oldest; i >= 0 && viewable.includes(i); i--) {
        const row = rowsNow[i];
        if (row?.kind === "line") return row.id;
        if (row?.kind === "asks") return row.messages[0]!.id;
      }
      return null;
    },
    hasOlder,
    olderLoading: () => Boolean(view().olderLoading),
    loadOlder: () => void runtime.loadOlderMessages(selected().id),
  });
  trackReading({ sessionId: state.sessionId, lastMessageId: lastLineId, atLatest: scroll.stick });
  /** A line of words you send flies from the box into the transcript (`send-flight`). */
  let stageNode: ViewRef | null = null;
  let transcriptNode: ViewRef | null = null;
  const flight = createSendFlight({ frame: () => stageNode, list: () => transcriptNode, atLatest: scroll.stick, session: state.sessionId, newest: lastLineId });
  effect(() => flight.switched(state.sessionId()));
  cleanup(() => flight.dispose());

  const loadingHistory = () => lines().length === 0 && !state.live() && Boolean(view().historyLoading);
  const empty = () => lines().length === 0 && !state.live() && !view().historyLoading;
  const hiddenWaiting = (): HiddenWaiting => {
    const workingIdx = inverted().findIndex((row) => row.kind === "working");
    if (workingIdx < 0) return { items: [], above: false };
    const items: HiddenWaiting["items"] = [];
    if (state.waiting()) items.push({ id: "working", kind: "approval" });
    for (const ask of state.openAsks()) items.push({ id: ask.id, kind: "ask" });
    if (items.length === 0) return { items: [], above: false };
    const viewable = scroll.viewable();
    if (viewable.length === 0 || viewable.includes(workingIdx)) return { items: [], above: false };
    return { items, above: false };
  };
  const phone = settled(() => width() > 0 && width() <= 680);
  const sideRoom = () => (showMessageIndex() && !narrowWindow() ? 40 : phone() ? 12 : 24);

  function openImage(attachment: Attachment, from?: PressedPicture): void {
    void imageOrigin(from?.view).then((origin) => {
      const open = () => image.set({ sessionId: selected().id, attachment, origin, placeholder: from?.shown ?? null });
      // On the hosted phone page the picture's history entry is written before it shows.
      if (runtime.hosted) stepIn(open);
      else open();
    });
  }

  return (
    <View
      testID="project-chat"
      ref={(node: ViewRef | null) => (stageNode = node)}
      class={`flex-1 min-h-0 relative overflow-hidden ${glassCard() ? "" : "bg-pane"}`}
      onLayout={(e) => {
        width.set(e.bounds.size.width);
        stageHeight.set(e.bounds.size.height);
      }}
      onFileDragEnter={() => fileOver.set(composer?.takesFiles() ?? false)}
      onFileDragLeave={() => fileOver.set(false)}
      onFileDrop={(e) => {
        fileOver.set(false);
        composer?.stageFiles(e.uris, e.mimeTypes);
      }}
    >
      {/* One selection across the lines, as the messenger's page is: a drag runs from one line into the
          next (each Markdown body alone stopped it at its end). On this view: a List takes no
          `selectable` of its own. A selection area stops a right click before the pane hears it, so
          this view opens the pane's menu itself, and the lines in it are no areas of their own. */}
      <View
        class="flex-1 min-h-0"
        selectable
        onSelectionChange={(e) => (selectedText = e.text)}
        onContextMenu={paneMenu ? (e) => paneMenu(e.pagePosition) : undefined}
      >
        <If when={loadingHistory()}>
          <HistoryLoading />
        </If>
        <If when={empty()}>
          <EmptyState testID="project-empty" title={t().project.empty(state.agentName())} />
        </If>
        <If when={!empty() && !loadingHistory()}>
          {/* Another conversation is another list: it opens at its newest line. All its padding and the
              gap between lines are in `contentStyle`: a List that has one drops `contentClass`'s whole,
              and the lines touched. Inverted, `paddingTop` is the end by the composer. */}
          <Each of={[state.sessionId()]} key={(id: string) => id}>
            {() => (
              <TranscriptClip.Provider value={() => transcriptNode}>
                <SendFlightOf.Provider value={flight}>
                  <List
                    testID="project-transcript"
                    ref={(node) => {
                      transcriptNode = node;
                      scroll.ref(node);
                    }}
                    each={inverted()}
                    inverted
                    keyExtractor={(row) => row.id}
                    class={`flex-1 ${glassCard() ? "" : "bg-pane"}`}
                    contentStyle={{ paddingLeft: sideRoom(), paddingRight: sideRoom(), paddingTop: phone() ? 14 : 20, paddingBottom: phone() ? 14 : 20, gap: 14 }}
                    estimatedItemSize={80}
                    onScroll={scroll.onScroll}
                    onViewableItemsChange={(info) => scroll.onViewable(info.viewableItems.map((token) => token.index))}
                    onLoadMore={scroll.onLoadMore}
                  >
                    {(row) => (
                      <View class="w-full max-w-[800px] self-center">
                        <If when={row().kind === "earlier"}>
                          <EarlierLine loading={Boolean(view().olderLoading)} />
                        </If>
                        <If when={row().kind === "line" ? (row() as Extract<ProjectRow, { kind: "line" }>) : null}>
                          {(line: () => Extract<ProjectRow, { kind: "line" }>) => (
                            <ProjectLine
                              message={line().message}
                              date={line().date}
                              fresh={line().fresh}
                              state={state}
                              copiedId={copiedId()}
                              onCopy={(message) => copyLine(message)}
                              onContextMenu={openLineMenu}
                              onOpenArtifact={props.onOpenArtifact}
                              onOpenImage={openImage}
                            />
                          )}
                        </If>
                        <If when={row().kind === "asks" ? (row() as Extract<ProjectRow, { kind: "asks" }>) : null}>
                          {(group: () => Extract<ProjectRow, { kind: "asks" }>) => <ProjectAskGroup messages={group().messages} date={group().date} fresh={group().fresh} state={state} />}
                        </If>
                        <If when={row().kind === "tasks"}>
                          <ProjectTasksEnd state={state} />
                        </If>
                        <If when={row().kind === "working"}>
                          <ProjectWorking state={state} />
                        </If>
                      </View>
                    )}
                  </List>
                </SendFlightOf.Provider>
              </TranscriptClip.Provider>
            )}
          </Each>
        </If>
        <If when={showMessageIndex()}>
          <Each of={[state.sessionId()]} key={(id: string) => id}>
            {() => (
              <MessageIndex
                marks={indexMarks()}
                activeId={scroll.active()}
                locale={state.locale()}
                label={t().stream.messageIndex}
                emptyLabel={t().stream.messageIndexEmpty}
                sender={indexSender}
                hasEarlier={hasOlder()}
                loading={Boolean(view().olderLoading)}
                earlierLabel={view().olderLoading ? t().stream.loadingEarlier : t().stream.loadEarlier}
                onLoadEarlier={() => void runtime.loadOlderMessages(selected().id)}
                onJump={scroll.jumpToIndexMark}
                maxHeight={Math.max(120, stageHeight() - 200)}
              />
            )}
          </Each>
        </If>
      </View>
      <View ref={(node: ViewRef | null) => (composerBox = node)} testID="project-composer-drop">
        <ProjectComposer
          selected={selected()}
          state={state}
          showScrollBottom={scroll.showBottom()}
          onScrollToBottom={() => scroll.scrollToBottom(true)}
          hiddenWaiting={hiddenWaiting()}
          onJumpWaiting={() => scroll.scrollToBottom(true)}
          onSent={() => scroll.scrollToBottom(false)}
          fileDragOver={fileOver()}
          readFiles={props.readFiles}
          onHandle={(handle) => (composer = handle)}
          flight={flight}
        />
      </View>
      <SendFlightLayer flight={flight} />
      <If when={lineMenu()}>
        {(open: () => NonNullable<ReturnType<typeof lineMenu>>) => {
          const close = () => lineMenu.set(null);
          const copyText = () => open().selected || open().message.body;
          const roving = rovingMenu({
            open: () => !narrowWindow(),
            keys: () => (copyText().trim() ? ["copy", "copy-id"] : ["copy-id"]),
            onTab: close,
          });
          return (
            <If
              when={narrowWindow()}
              else={
                <Overlay anchor={{ x: open().at.x, y: open().at.y }} placement="bottom" align="start" margin={8} onPressOutside={close} onCancel={close}>
                  <View role="menu" testID="project-line-menu" accessibilityLabel={t().chat.copyMessage} class={`min-w-[168px] gap-[2px] ${MENU_SURFACE}`} style={{ boxShadow: shadow("menu") }}>
                    <View
                      role="menuitem"
                      testID="project-menu-copy"
                      ref={roving.ref("copy")}
                      accessibilityLabel={t().chat.copyMessage}
                      disabled={!copyText().trim()}
                      onFocus={() => roving.focused("copy")}
                      onBlur={() => roving.blurred("copy")}
                      onPress={() => {
                        copyLine(open().message, copyText());
                        close();
                      }}
                      class={`cursor-pointer select-none disabled:cursor-default ${MENU_ITEM} group`}
                    >
                      <Icon name="copy" size={16} class="tint-ink opacity-75 group-hover:tint-brand group-hover:opacity-100 group-focus:tint-brand group-focus:opacity-100" />
                      <Text class="text-[13px] font-medium text-ink group-hover:text-brand group-focus:text-brand">{t().chat.copyMessage}</Text>
                    </View>
                    <View
                      role="menuitem"
                      testID="project-menu-copy-id"
                      ref={roving.ref("copy-id")}
                      accessibilityLabel={t().chat.copyMessageId}
                      onFocus={() => roving.focused("copy-id")}
                      onBlur={() => roving.blurred("copy-id")}
                      onPress={() => {
                        copyLineId(open().message);
                        close();
                      }}
                      class={`cursor-pointer select-none ${MENU_ITEM} group`}
                    >
                      <Icon name="hash" size={16} class="tint-ink opacity-75 group-hover:tint-brand group-hover:opacity-100 group-focus:tint-brand group-focus:opacity-100" />
                      <Text class="text-[13px] font-medium text-ink group-hover:text-brand group-focus:text-brand">{t().chat.copyMessageId}</Text>
                    </View>
                  </View>
                </Overlay>
              }
            >
              <BottomSheet label={t().chat.copyMessage} closeLabel={t().common.close} onClose={close}>
                <View role="menu" testID="project-line-menu" accessibilityLabel={t().chat.copyMessage} class="gap-1 px-1">
                  <SheetItem
                    role="menuitem"
                    testID="project-menu-copy"
                    icon="copy"
                    label={t().chat.copyMessage}
                    disabled={!copyText().trim()}
                    onPress={() => {
                      copyLine(open().message, copyText());
                      close();
                    }}
                  />
                  <SheetItem
                    role="menuitem"
                    testID="project-menu-copy-id"
                    icon="hash"
                    label={t().chat.copyMessageId}
                    onPress={() => {
                      copyLineId(open().message);
                      close();
                    }}
                  />
                </View>
              </BottomSheet>
            </If>
          );
        }}
      </If>
      <If when={state.subagentShown()}>
        {(task: () => NonNullable<ReturnType<typeof state.subagentShown>>) => (
          <ProjectSubagentDialog
            task={task()}
            onClose={() => state.subagentOpen.set(null)}
            onOpenPath={(path) => {
              state.subagentOpen.set(null);
              state.openCited(path);
            }}
            files={state.files()}
          />
        )}
      </If>
      <If when={image() && image()!.sessionId === selected().id ? image() : null}>
        {(shown: () => NonNullable<ReturnType<typeof image>>) => (
          <MessageImageLightbox attachment={shown().attachment} relpath={shown().attachment.workspace_relpath} origin={shown().origin} placeholder={shown().placeholder} api={runtime.client} onClose={() => image.set(null)} />
        )}
      </If>
    </View>
  );
}
