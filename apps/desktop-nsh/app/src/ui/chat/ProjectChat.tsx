/**
 * A project session's conversation (`ProjectChat.svelte`, ADR 0095): you and the agent in a
 * directory, as in the agent's own desktop app. It has no Bot, so none of the Bot stage applies: your
 * lines on the right, the agent's on the left as Markdown, the app's centred. The run going on is a
 * Bot's working bubble at the end with the approval it waits on under it; Stop is in the composer.
 * Pictures and files go with a line; Plan mode is a switch in the composer (Shift+Tab); typing `/`
 * lists the agent's commands (ADR 0098); a Codex session (ADR 0099) has no plan mode and no account.
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
import { List, signal, Text, View } from "nsh";
import type { Attachment, SessionSummary } from "@real-bot/protocol";
import { isDifferentDay } from "../../m/chat/chat-view.ts";
import { focusMode } from "../../m/chat/focus-mode.svelte.ts";
import { INDEX_MIN_MARKS, messageIndexMarks, type IndexMark } from "../../m/chat/message-index.ts";
import { USER_MEMBER } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { narrowWindow } from "../Modal";
import { imageOrigin } from "./image-origin";
import { MessageImageLightbox, type ImageOrigin } from "./MessageImageLightbox";
import { MessageIndex } from "./MessageIndex";
import { ProjectSubagentDialog } from "./ProjectSubagentDialog";
import { EarlierLine, ProjectLine, ProjectTasksEnd, type ProjectRow } from "./project-chat-lines";
import { ProjectComposer } from "./project-chat-composer";
import { createProjectState } from "./project-chat-state";
import { ProjectWorking } from "./project-chat-working";
import { trackReading } from "./stage-reading";
import { createStageScroll } from "./stage-scroll";

export function ProjectChat(props: {
  selected: SessionSummary;
  /** Opens a file the agent cites, as a Bot conversation's do; given the absolute path the Mac found. */
  onOpenArtifact: (relpath: string, att?: Attachment, messageId?: string) => void;
}) {
  const t = () => copy();
  const selected = () => props.selected;
  const state = createProjectState(selected, (...args) => props.onOpenArtifact(...args));
  const view = state.view;
  const width = signal(0);
  const stageHeight = signal(0);
  const image = signal<{ sessionId: string; attachment: Attachment; origin: ImageOrigin | null } | null>(null);

  const hasOlder = () => Boolean(view().hasOlderMessages);
  const lines = state.lines;
  /** Oldest first: the earlier line, each line with its day line, what a run started with no line to hang under, the run going on. */
  const rows = (): ProjectRow[] => {
    const out: ProjectRow[] = [];
    if (hasOlder()) out.push({ id: "earlier", kind: "earlier" });
    lines().forEach((message, index) => {
      const previous = index > 0 ? lines()[index - 1]! : null;
      out.push({ id: message.id, kind: "line", message, date: !previous || isDifferentDay(previous.created_at, message.created_at) ? message.created_at : null });
    });
    if (state.placed().end.length > 0 && !focusMode.on) out.push({ id: "tasks", kind: "tasks" });
    if (state.run() && state.live()) out.push({ id: "working", kind: "working" });
    return out;
  };
  const inverted = () => rows().slice().reverse();

  /** The message index: a tick for each line, yours in the accent. Every line is a row, so a press only scrolls. */
  const indexMarks = () => messageIndexMarks(lines().map((message) => ({ type: "message" as const, message })));
  const showMessageIndex = () => indexMarks().length >= INDEX_MIN_MARKS || hasOlder();
  const indexSender = (mark: IndexMark) => {
    if (mark.author === USER_MEMBER) return t().common.you;
    if (mark.kind === "system" || mark.author === "app") return state.locale() === "zh" ? "系统" : "System";
    return state.agentName();
  };
  const lastLineId = () => lines().at(-1)?.id ?? null;

  const scroll = createStageScroll({
    sessionId: state.sessionId,
    highlightedId: () => null,
    highlightToken: () => 0,
    indexOf: (id) => inverted().findIndex((row) => row.kind === "line" && row.id === id),
    activeFor: (viewable, atEnd) => {
      if (atEnd) return lastLineId();
      const rowsNow = inverted();
      const oldest = viewable.length > 0 ? Math.max(...viewable) : -1;
      for (let i = oldest; i >= 0 && viewable.includes(i); i--) {
        const row = rowsNow[i];
        if (row?.kind === "line") return row.id;
      }
      return null;
    },
    hasOlder,
    olderLoading: () => Boolean(view().olderLoading),
    loadOlder: () => void runtime.loadOlderMessages(selected().id),
  });
  trackReading({ sessionId: state.sessionId, lastMessageId: lastLineId, atLatest: scroll.stick });

  const empty = () => lines().length === 0 && !state.live() && !view().historyLoading;
  const phone = () => width() > 0 && width() <= 680;
  const sideRoom = () => (showMessageIndex() && !narrowWindow() ? 40 : phone() ? 12 : 24);

  function openImage(attachment: Attachment, from?: unknown): void {
    void imageOrigin(from as never).then((origin) => image.set({ sessionId: selected().id, attachment, origin }));
  }

  return (
    <View
      testID="project-chat"
      class="flex-1 min-h-0 relative bg-pane overflow-hidden"
      onLayout={(e) => {
        width.set(e.bounds.size.width);
        stageHeight.set(e.bounds.size.height);
      }}
    >
      <View class="flex-1 min-h-0">
        <If when={empty()}>
          <Text testID="project-empty" class="my-10 text-center text-[13px] text-ink-muted">
            {t().project.empty(state.agentName())}
          </Text>
        </If>
        <If when={!empty()}>
          {/* Another conversation is another list: it opens at its newest line. */}
          <Each of={[state.sessionId()]} key={(id: string) => id}>
            {() => (
              <List
                testID="project-transcript"
                ref={scroll.ref}
                each={inverted()}
                inverted
                keyExtractor={(row) => row.id}
                class="flex-1 bg-pane"
                contentClass="py-5 gap-[14px]"
                contentStyle={{ paddingLeft: sideRoom(), paddingRight: sideRoom(), paddingTop: phone() ? 14 : 20 }}
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
                        <ProjectLine message={line().message} date={line().date} state={state} onOpenArtifact={props.onOpenArtifact} onOpenImage={openImage} />
                      )}
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
      <ProjectComposer selected={selected()} state={state} onSent={() => scroll.scrollToBottom(false)} />
      <If when={state.subagentShown()}>
        {(task: () => NonNullable<ReturnType<typeof state.subagentShown>>) => (
          <ProjectSubagentDialog
            task={task()}
            onClose={() => state.subagentOpen.set(null)}
            onOpenPath={(path) => {
              state.subagentOpen.set(null);
              state.openCited(path);
            }}
          />
        )}
      </If>
      <If when={image() && image()!.sessionId === selected().id ? image() : null}>
        {(shown: () => NonNullable<ReturnType<typeof image>>) => (
          <MessageImageLightbox attachment={shown().attachment} relpath={shown().attachment.workspace_relpath} origin={shown().origin} api={runtime.client} onClose={() => image.set(null)} />
        )}
      </If>
    </View>
  );
}
