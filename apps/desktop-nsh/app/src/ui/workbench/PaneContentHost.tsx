/**
 * Turns a workbench tab into the thing it stands for (`PaneContentHost.svelte`): a conversation
 * (with its header bar and the settings sliding over it), the calendar, spending, usage, the roles
 * page, a task map, a terminal, the workspace, a job's board, or a file's preview. The layout
 * engine never imports a content component, it takes `tabBody`; this is the one place that knows
 * both a tab's kind and what draws it. The tab is the workbench's live one (`live-tab.ts`), so its
 * params read fresh; every tab has its own host (the leaf keys bodies by tab id), which is what
 * the Svelte's `{#key tab.id}` around the board was for.
 *
 * Differences from the Svelte: the terminal is the stop-gap `PaneTerminal` until NSH's own
 * terminal lands; the settings' scrim is a pressable strip beside the drawer rather than a
 * click-outside test.
 */
import type { Attachment } from "@real-bot/protocol";
import { cleanup, computed, effect, signal, Text, untracked, View, type JSX } from "nsh";
import { annotationsForFile, targetFor } from "../../m/annotations/model.ts";
import { projectDirOf } from "../../m/overlays/artifact-lookup.ts";
import { isPlaceholderAttachment } from "../../m/overlays/artifacts.ts";
import { sanitizePreviewPath } from "../../m/session-url.ts";
import { classifySession, isFileDropSession } from "../../m/sidebar/session-groups.ts";
import type { WorkbenchTab } from "../../m/workbench/layout-types.ts";
import { contentOfTab, contentsEqual, type PaneContent } from "../../m/workbench/pane-content.ts";
import { previewContext, type PreviewHandle } from "../../m/workbench/preview-context.ts";
import { copy, runtime } from "../../runtime";
import { RoutineCalendar } from "../calendar/RoutineCalendar";
import { ChatStage } from "../chat/ChatStage";
import { ProjectChat } from "../chat/ProjectChat";
import { ArtifactPreview } from "../overlays/ArtifactPreview";
import { JobLayout } from "../overlays/JobLayout";
import { WorkspaceView } from "../overlays/WorkspaceView";
import { CallEditor } from "../settings/CallEditor";
import { RolesPage } from "../settings/RolesPage";
import { SpendView } from "../spend/SpendView";
import { shadow } from "../styles";
import { TaskMap } from "../taskmap/TaskMap";
import { UsageTab } from "../usage/UsageTab";
import { PaneTerminal } from "./PaneTerminal";

type OpenArtifact = (
  relpath: string,
  attachment?: Attachment,
  messageId?: string | null,
  forceTree?: boolean,
  taskId?: string | null,
  siblings?: Attachment[] | null,
  sessionId?: string | null,
) => void;

export function PaneContentHost(props: {
  tab: WorkbenchTab;
  leafId: string;
  /** A Bot's profile, beside the conversation it was asked for from. */
  onOpenProfile: (botId: string, sessionId: string) => void;
  /** Open a file in the conversation's preview; `sessionId` says whose. */
  onOpenArtifact: OpenArtifact;
  onRemoveTab: (leafId: string, tabId: string) => void;
  /** The tab now shows something else of the same kind, so a restart comes back to it. */
  onUpdateContent?: (content: PaneContent) => void;
  /** Show something else in a tab of its own. */
  onOpenContent?: (content: PaneContent) => void;
  onBindTerminal: (leafId: string, tabId: string, terminalId: string | null) => void;
  /** A preview mounted in this tab (or `null` once it is gone). */
  onPreviewPane?: (tabId: string, pane: PreviewHandle | null) => void;
  onJump: (sessionId: string, messageId: string) => void;
  onCloseSide: (sessionId: string) => void;
  /** The settings beside a conversation; the shell draws them (one draft, one armed confirm). */
  settingsSide: (sessionId: string, botId: string | null) => JSX.Element;
  /** The conversation's header bar, above its transcript. */
  chatBar?: (tab: WorkbenchTab, leafId: string) => JSX.Element;
  onCreateBot?: () => void;
}) {
  const t = () => copy();
  const snapshot = () => runtime.snapshot;
  // Kept while it says the same: the tab's params arrive as a new object on many a layout change, and
  // each one had every view below read its conversation (a task map its whole plan) anew.
  const content = computed(() => contentOfTab(props.tab), { equals: (a, b) => a === b || (a !== null && b !== null && contentsEqual(a, b)) });
  const kind = () => content()?.kind ?? null;
  const locale = () => (snapshot().settings.locale === "en" ? "en" : "zh");
  const botsById = computed(() => new Map(snapshot().bots.map((b) => [b.id, b] as const)));

  // Read again on every message anywhere; kept while it says the same, so the preview is not handed new files each time.
  const preview = computed(
    () => {
      const c = content();
      return c?.kind === "preview" ? previewContext(c, snapshot().messages) : null;
    },
    { equals: (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b) },
  );
  const previewSessionId = () => {
    const c = content();
    return c?.kind === "preview" ? (c.sessionId ?? runtime.selectedId ?? null) : null;
  };
  /** 挂到谁: the message the preview came from when it handed this path over, else the latest Bot message in its conversation that did. */
  const annotationTarget = computed(() => {
    const p = preview();
    if (!p?.relpath) return null;
    const owner = p.messageId ? snapshot().messages.find((message) => message.id === p.messageId) : undefined;
    return targetFor(snapshot().messages, p.relpath, owner, {
      sessionId: previewSessionId(),
      taskId: p.taskId ?? owner?.task_id ?? null,
    });
  });

  /**
   * The annotation a card asked to go to, taken when the card is in this preview's conversation
   * and its file is the one on screen. Taken into state (and cleared on the runtime) so a card
   * asking again for the same id still lands, and a preview shown later does not replay it.
   */
  const annotationFocus = signal<string | null>(null);
  effect(() => {
    const id = runtime.annotationFocusId;
    const relpath = preview()?.relpath ?? null;
    untracked(() => {
      const c = content();
      if (!id || c?.kind !== "preview") return;
      const row = snapshot().annotations.find((candidate) => candidate.id === id);
      if (c.sessionId && row && row.session_id !== c.sessionId) return;
      if (row && relpath !== null) {
        const key = runtime.annotationFileKeys[relpath] ?? null;
        if (annotationsForFile([row], relpath, snapshot().settings.workspace_path, key).length === 0) return;
      }
      annotationFocus.set(null);
      annotationFocus.set(id);
      runtime.annotationFocusId = null;
    });
  });

  /** Only which file is on screen changes; the tab keeps what its source handed over. */
  const selectPreview = (att: Attachment) => {
    const c = content();
    const p = preview();
    if (c?.kind !== "preview" || !p) return;
    props.onUpdateContent?.({
      ...c,
      relpath: att.workspace_relpath,
      attachmentId: isPlaceholderAttachment(att) ? null : (att.id ?? null),
      messageId: p.messageId,
      taskId: p.taskId,
      siblings: p.handedOver,
    });
  };
  const selectWorkspace = (path: string) => {
    if (content()?.kind !== "workspace") return;
    props.onUpdateContent?.({ kind: "workspace", selected: sanitizePreviewPath(path) });
  };
  const traceTask = (taskId: string) => {
    const c = content();
    if (c?.kind !== "trace" || c.taskId === taskId) return;
    props.onUpdateContent?.({ ...c, taskId });
  };
  /** The plan the map tab asks for, followed (read once, it missed another plan asked of the same tab). */
  const mapTaskId = () => {
    const c = content();
    return c?.kind === "map" ? (c.taskId ?? null) : null;
  };
  const mapTask = (taskId: string) => {
    const c = content();
    if (c?.kind !== "map" || c.taskId === taskId) return;
    props.onUpdateContent?.({ ...c, taskId });
  };

  // The preview or workspace pane in this tab, for the shell's Escape and close guards.
  let reported = false;
  const reportPane = (pane: PreviewHandle | null) => {
    if (!pane && !reported) return;
    reported = pane !== null;
    props.onPreviewPane?.(props.tab.id, pane);
  };
  cleanup(() => reportPane(null));

  const session = computed(() => {
    const c = content();
    return c && "sessionId" in c && c.sessionId ? (snapshot().sessions.find((row) => row.id === c.sessionId) ?? null) : null;
  });
  const side = () => {
    const c = content();
    return c?.kind === "chat" ? (c.side ?? null) : null;
  };

  // The board on screen stays current: every turn of its job reloads it; a line's own board follows its conversation.
  effect(() => {
    const c = content();
    const task = c?.kind === "trace" ? c.taskId : null;
    if (!task) return;
    const stop = runtime.watchTrace(task);
    cleanup(stop);
  });
  effect(() => {
    const c = content();
    const lineSession = c?.kind === "trace" && c.line ? c.sessionId : null;
    if (!lineSession) return;
    const stop = runtime.watchLineBoard(lineSession);
    cleanup(stop);
  });

  const paneWidth = signal(0);
  const drawerWidth = () => Math.max(0, Math.min(460, paneWidth() - 48));

  const gone = (text: string) => (
    <View class="flex-1 items-center justify-center p-6">
      <Text class="text-[13px] text-ink-muted text-center">{text}</Text>
    </View>
  );

  return (
    <View class="flex-1 min-h-0 min-w-0" onLayout={(e) => paneWidth.set(e.bounds.size.width)}>
      <If when={kind() === null}>{gone(t().pane.empty)}</If>
      <If when={kind() === "chat"}>
        <If when={session()} else={gone(t().top.deleted)}>
          {(s) => (
            <View class="flex-1 min-h-0 min-w-0">
              <View class="flex-1 min-h-0 min-w-0">
                {props.chatBar?.(props.tab, props.leafId)}
                <If
                  when={s().kind === "project"}
                  else={
                    <ChatStage
                      selected={s()}
                      onOpenProfile={(botId) => props.onOpenProfile(botId, s().id)}
                      onOpenArtifact={(relpath, att, messageId, forceTree) =>
                        props.onOpenArtifact(relpath, att, messageId, forceTree, null, null, s().id)
                      }
                      onCreateBot={props.onCreateBot ?? (() => {})}
                    />
                  }
                >
                  <ProjectChat
                    selected={s()}
                    onOpenArtifact={(relpath, att, messageId) => props.onOpenArtifact(relpath, att, messageId, false, null, null, s().id)}
                  />
                </If>
              </View>
              <If when={side()}>
                {(open) => (
                  <View class="absolute inset-0 flex-row" style={{ zIndex: 30 }}>
                    <View
                      testID="pane-side-scrim"
                      accessibilityLabel={t().common.close}
                      class="flex-1 bg-modal-backdrop"
                      onPress={() => props.onCloseSide(s().id)}
                    />
                    <View
                      testID="pane-side"
                      accessibilityLabel={classifySession(s()) === "group" && !open().botId ? t().top.groupSettings : t().top.botSettings}
                      class="h-full min-h-0 overflow-hidden border-l border-line bg-pane"
                      style={{ width: drawerWidth(), boxShadow: shadow("sheet-end") }}
                    >
                      {/* Made again only for another conversation or Bot: called in this insert, it read the
                          session row and was made again whenever the conversation updated. */}
                      <Each of={[`${s().id}:${open().botId ?? ""}`]} key={(k) => k}>
                        {() => untracked(() => props.settingsSide(s().id, open().botId ?? null))}
                      </Each>
                    </View>
                  </View>
                )}
              </If>
            </View>
          )}
        </If>
      </If>
      <If when={kind() === "routines"}>
        <RoutineCalendar />
      </If>
      <If when={kind() === "spend"}>
        <SpendView
          api={runtime.client}
          revision={runtime.spendRevision}
          locale={locale()}
          capUsd={snapshot().settings.spend_cap_usd ?? null}
          onSetCap={(usd) => runtime.patchSettings({ spend_cap_usd: usd })}
          bots={snapshot().bots}
          providers={snapshot().providers}
          onOpenSession={(sessionId) => void runtime.openChat(sessionId)}
          onOpenTrigger={(sessionId, messageId) => void runtime.openChat(sessionId, { messageId })}
        />
      </If>
      <If when={kind() === "usage"}>
        <UsageTab />
      </If>
      <If when={kind() === "roles"}>
        <RolesPage host="pane" />
      </If>
      <If when={kind() === "map" && session() && !isFileDropSession(session()!) ? session() : null}>
        {(s) => <TaskMap session={s()} taskId={mapTaskId()} onTask={mapTask} />}
      </If>
      <If when={kind() === "terminal"}>
        <PaneTerminal
          terminalId={(() => {
            const c = content();
            return c?.kind === "terminal" ? (c.terminalId ?? null) : null;
          })()}
          onBind={(id) => props.onBindTerminal(props.leafId, props.tab.id, id)}
        />
      </If>
      <If when={kind() === "workspace"}>
        <WorkspaceView
          api={runtime.client}
          workspacePath={snapshot().settings.workspace_path}
          selected={(() => {
            const c = content();
            return c?.kind === "workspace" ? (c.selected ?? "") : "";
          })()}
          onOpenTerminal={(dir) => void runtime.openTerminalAt(dir)}
          onClose={() => props.onRemoveTab(props.leafId, props.tab.id)}
          onSelect={selectWorkspace}
          onHandle={(handle) => reportPane(handle)}
        >
          {(p) => (
            <ArtifactPreview
              attachment={null}
              relpath={p.relpath}
              siblings={[]}
              api={p.api}
              workspacePath={p.workspacePath}
              mode="workspace"
              onClose={p.onClose}
              onSelect={() => {}}
              onSelectWorkspacePath={p.onSelectWorkspacePath}
              onOpenTerminal={p.onOpenTerminal}
              ref={p.ref}
            />
          )}
        </WorkspaceView>
      </If>
      <If when={kind() === "trace" ? content() : null}>
        {(c) => {
          const board = () => c() as Extract<PaneContent, { kind: "trace" }>;
          return (
            <JobLayout
              api={runtime.client}
              taskId={board().taskId}
              line={board().line ?? null}
              focus={board().focus ?? null}
              focusToken={board().focusNonce ?? 0}
              sessionId={board().sessionId}
              activeSessionId={runtime.selectedId ?? board().sessionId}
              sessions={snapshot().sessions}
              bots={snapshot().bots}
              providers={snapshot().providers}
              youLabel={t().common.you}
              deletedLabel={t().top.deleted}
              reloadToken={runtime.traceReload}
              onJump={props.onJump}
              onTask={traceTask}
              view={board().view ?? null}
              ask={{ ticket: board().ticket ?? null, column: board().column ?? null }}
              askToken={board().askNonce ?? 0}
              onOpenArtifact={(relpath, att, messageId, forceTree, taskId, siblings) =>
                props.onOpenArtifact(relpath, att, messageId, forceTree, taskId, siblings, board().sessionId)
              }
              holds={snapshot().holdsOn ? snapshot().holds : null}
              onStop={(choice) => runtime.stopScope(choice.scope, choice.id, board().sessionId)}
              onLift={(hold) => runtime.liftHold(hold.id)}
              controlsDisabled={runtime.connection !== "connected"}
              onOpenRoles={(id) => runtime.openRoles(null, id)}
              onOpenMap={
                props.onOpenContent && !board().line
                  ? (taskId) => props.onOpenContent?.({ kind: "map", sessionId: board().sessionId, taskId })
                  : undefined
              }
              callEditor={(role) => <CallEditor role={role} />}
            />
          );
        }}
      </If>
      <If when={kind() === "preview"}>
        <If when={preview()?.relpath ? preview() : null} else={gone(t().pane.emptyHint)}>
          {(p) => {
            const c = () => content() as Extract<PaneContent, { kind: "preview" }>;
            return (
              <ArtifactPreview
                attachment={p().attachment}
                relpath={p().relpath!}
                siblings={p().siblings}
                taskId={p().taskId}
                projectDir={c().projectDir ?? projectDirOf(snapshot().sessions, previewSessionId())}
                forceTree={c().forceTree}
                api={runtime.client}
                workspacePath={snapshot().settings.workspace_path}
                target={annotationTarget()}
                annotations={snapshot().annotations}
                annotationFocusId={annotationFocus()}
                annotationFileKey={runtime.annotationFileKeys[p().relpath!] ?? null}
                bots={botsById()}
                locale={locale()}
                sessions={snapshot().sessions}
                viewedSessionId={previewSessionId()}
                onLoadAnnotations={(path) => void runtime.loadAnnotations({ relpath: path })}
                onCreateAnnotation={(input) => runtime.createAnnotation(input)}
                onPatchAnnotation={(id, patch) => runtime.patchAnnotation(id, patch)}
                onDeleteAnnotation={(id) => runtime.deleteAnnotation(id)}
                onSendAnnotations={(sessionId, summary, ids) => runtime.sendAnnotations(sessionId, summary, ids)}
                onOpenTerminal={(dir) => void runtime.openTerminalAt(dir)}
                onClose={() => props.onRemoveTab(props.leafId, props.tab.id)}
                onSelect={selectPreview}
                ref={(pane) => reportPane(pane ? { ...pane, requestLeaveFromParent: pane.requestLeaveFromParent ?? ((after) => after()) } : null)}
              />
            );
          }}
        </If>
      </If>
      <If when={kind() !== null && !KNOWN.has(kind()!)}>{gone(t().pane.emptyHint)}</If>
    </View>
  );
}

const KNOWN = new Set(["chat", "routines", "spend", "usage", "roles", "map", "terminal", "workspace", "trace", "preview"]);
