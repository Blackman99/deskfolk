/**
 * The list of the sidebar (`Sidebar.svelte`'s `.groups`): section headings, conversation rows,
 * project directories with their sessions, the archived list and the empty notes, in one virtualised
 * `List`. `rows` is the flat array `listRows` builds; every row reads its item through the accessor,
 * since a cell is recycled for another row. State a row would keep lives above, in the sidebar.
 *
 * Not ported: a row that moves up the list sliding there (`moveFlip`); a recycled list has no
 * sibling to animate from.
 */
import { List, platform, Text, View, type ViewRef } from "nsh";
import type { SessionDragHandler } from "./session-drag";
import type { Bot, ProjectAgent, SessionSummary } from "@real-bot/protocol";
import { isSessionPinned } from "../../m/sidebar/pinned-sessions";
import { PROJECT_AGENTS, projectAgentOf, type ProjectDirGroup } from "../../m/sidebar/project-groups";
import type { SessionStatusResult } from "../../m/sidebar/session-status";
import { copy } from "../../runtime";
import { Button } from "../Button";
import { EmptyState } from "../EmptyState";
import { Icon } from "../Icon";
import { tip } from "../tip";
import { dismissRailTips } from "./RailTooltip";
import { ProjectSessionRow } from "./ProjectSessionRow";
import { SessionRow, type MenuAt } from "./SessionRow";
import type { ListRow } from "./sidebar-list-model";

/** What the list asks the sidebar: how to word a session and what its rows do. */
export type SidebarListEnv = {
  phone: boolean;
  selectedId: () => string | null;
  contextMenuSessionId: () => string | null;
  renamingSessionId: () => string | null;
  pinnedSessionIds: () => string[];
  botsById: () => ReadonlyMap<string, Bot>;
  titleOf: (session: SessionSummary) => string;
  archivedSuffix: (session: SessionSummary) => string;
  timeOf: (session: SessionSummary) => string;
  statusOf: (session: SessionSummary) => SessionStatusResult;
  projectStatusOf: (session: SessionSummary) => SessionStatusResult;
  unreadOf: (session: SessionSummary) => number;
  previewOf: (session: SessionSummary) => string;
  elsewhereOf: (session: SessionSummary, status: SessionStatusResult) => string | null;
  botStatusOf: (botId: string) => SessionStatusResult | undefined;
  onSelect: (session: SessionSummary) => void;
  onOpenContextMenu: (at: MenuAt, session: SessionSummary) => void;
  onTogglePin?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, name: string | null) => Promise<boolean>;
  onDragSession?: SessionDragHandler;
  closeArchived: () => void;
  /** The + of a section, with the view it hangs the menu from. */
  onSectionAdd: (section: "bots" | "projects", anchor: ViewRef | null) => void;
  sectionMenuOpen: (section: "bots" | "projects") => boolean;
  toggleDir: (dir: string) => void;
  /** A directory's +. */
  onDirAdd: (group: ProjectDirGroup, anchor: ViewRef | null) => void;
  /** A right-click on a directory's row, where the pointer was. */
  onDirMenu: (group: ProjectDirGroup, anchor: ViewRef | null, at: MenuAt) => void;
  dirAddExpanded: (dir: string) => boolean;
  onCreateBot: () => void;
  onCreateGroup: () => void;
  onNewProject: (agent: ProjectAgent) => void;
  onImportProject: () => void;
};

function rowOf<K extends ListRow["kind"]>(row: ListRow, kind: K): Extract<ListRow, { kind: K }> | null {
  return row.kind === kind ? (row as Extract<ListRow, { kind: K }>) : null;
}

export function SidebarList(props: { rows: ListRow[]; env: SidebarListEnv }) {
  const t = () => copy();
  const env = () => props.env;
  const phone = () => props.env.phone;

  function Session(p: { row: Extract<ListRow, { kind: "session" }> }) {
    const e = env();
    const session = () => p.row.session;
    const status = () => e.statusOf(session());
    const variant = () => p.row.variant;
    return (
      <SessionRow
        session={session()}
        on={e.selectedId() === session().id}
        contextOpen={e.contextMenuSessionId() === session().id}
        archived={variant() === "archived"}
        fileDrop={variant() === "file-drop"}
        title={variant() === "file-drop" ? t().sidebar.fileDrop : `${e.titleOf(session())}${e.archivedSuffix(session())}`}
        time={e.timeOf(session())}
        status={status()}
        showCount={variant() !== "file-drop"}
        preview={e.previewOf(session()) || (variant() === "file-drop" ? t().sidebar.fileDropHint : t().sidebar.noMessages)}
        elsewhere={variant() === "bot" ? e.elsewhereOf(session(), status()) : null}
        unread={e.unreadOf(session())}
        bots={e.botsById()}
        botStatus={e.botStatusOf}
        onSelect={() => e.onSelect(session())}
        onContextMenu={(at) => e.onOpenContextMenu(at, session())}
        onDrag={e.onDragSession ? (phase, point) => e.onDragSession?.(phase, point, session()) : undefined}
        pinned={variant() === "bot" ? isSessionPinned(e.pinnedSessionIds(), session().id) : undefined}
        onTogglePin={variant() === "bot" && e.onTogglePin ? () => e.onTogglePin?.(session().id) : undefined}
      />
    );
  }

  function Project(p: { row: Extract<ListRow, { kind: "project" }> }) {
    const e = env();
    const session = () => p.row.session;
    return (
      <View class="pl-[14px]">
        <ProjectSessionRow
          session={session()}
          on={e.selectedId() === session().id}
          contextOpen={e.contextMenuSessionId() === session().id}
          title={session().name || t().project.untitled}
          agent={projectAgentOf(session())}
          name={session().name}
          renaming={e.renamingSessionId() === session().id}
          onRename={e.onRenameSession ? (name) => e.onRenameSession!(session().id, name) : undefined}
          time={e.timeOf(session())}
          status={e.projectStatusOf(session())}
          preview={e.previewOf(session()) || t().sidebar.noMessages}
          unread={e.unreadOf(session())}
          bots={e.botsById()}
          botStatus={e.botStatusOf}
          onSelect={() => e.onSelect(session())}
          onContextMenu={(at) => e.onOpenContextMenu(at, session())}
          onDrag={e.onDragSession ? (phase, point) => e.onDragSession?.(phase, point, session()) : undefined}
          pinned={isSessionPinned(e.pinnedSessionIds(), session().id)}
          onTogglePin={e.onTogglePin ? () => e.onTogglePin?.(session().id) : undefined}
        />
      </View>
    );
  }

  function Dir(p: { row: Extract<ListRow, { kind: "dir" }> }) {
    const e = env();
    let head: ViewRef | null = null;
    let add: ViewRef | null = null;
    const group = () => p.row.group;
    const hoverOnly = () => platform.desktop && !phone();
    return (
      <View
        testID="project-dir"
        class="group flex-row items-center"
        onContextMenu={(ev) => e.onDirMenu(group(), head, { x: ev.pagePosition.x, y: ev.pagePosition.y })}
      >
        <View
          role="button"
          testID={`project-dir-head:${group().dir}`}
          ref={(node: ViewRef) => {
            head = node;
          }}
          tooltip={tip(group().dir)}
          accessibilityLabel={t().project.toggleDir(group().label)}
          accessibilityState={{ expanded: p.row.open }}
          onPress={() => e.toggleDir(group().dir)}
          class={`group flex-1 min-w-0 flex-row items-center gap-[6px] px-[10px] py-1 rounded-(--radius-md) hover:bg-row-hover ${phone() ? "min-h-[44px] pl-[14px]" : "min-h-[32px]"}`}
        >
          <Icon name={p.row.open ? "chevron-down" : "chevron-right"} size={12} class="tint-ink-secondary" />
          <Icon name="folder" size={16} class="tint-ink-secondary" />
          <Text testID="project-dir-name" class="flex-1 min-w-0 line-clamp-1 text-[13px] font-semibold text-ink-secondary">{group().label}</Text>
          <If when={p.row.live}>
            <View testID="project-dir-live" accessible={false} class="shrink-0 w-[7px] h-[7px] rounded-full bg-brand" />
          </If>
        </View>
        <View
          role="button"
          testID={`project-dir-add:${group().dir}`}
          ref={(node: ViewRef) => {
            add = node;
          }}
          tooltip={tip(t().project.newHere(group().label))}
          accessibilityLabel={t().project.newHere(group().label)}
          accessibilityState={{ expanded: e.dirAddExpanded(group().dir) }}
          onPress={() => e.onDirAdd(group(), add)}
          class={`group shrink-0 items-center justify-center mr-[6px] rounded-(--radius-sm) hover:bg-line-subtle ${phone() ? "w-[40px] h-[40px]" : "w-[26px] h-[26px]"} ${hoverOnly() ? "opacity-0 group-hover:opacity-100 focus-visible:opacity-100" : ""}`}
        >
          <Icon name="plus" size={16} class="tint-ink-muted group-hover:tint-brand" />
        </View>
      </View>
    );
  }

  function Heading(p: { row: Extract<ListRow, { kind: "ghead" }> }) {
    const e = env();
    let plus: ViewRef | null = null;
    const section = () => p.row.add;
    return (
      <View testID={p.row.key} class={`flex-row items-center justify-between ${phone() ? "px-[14px] pb-1" : "px-[10px] pb-1"} ${p.row.first ? "pt-[6px]" : phone() ? "pt-3" : "pt-[14px]"}`}>
        <Text class="text-[12px] font-semibold text-ink-muted">{p.row.title}</Text>
        <If when={section()}>
          {(which) => (
            <View
              role="button"
              testID={which() === "bots" ? "bot-add" : "project-add"}
              ref={(node: ViewRef) => {
                plus = node;
              }}
              tooltip={tip(which() === "bots" ? t().sidebar.createMenu : t().project.add)}
              accessibilityLabel={which() === "bots" ? t().sidebar.createMenu : t().project.add}
              accessibilityState={{ expanded: e.sectionMenuOpen(which()) }}
              onPress={() => e.onSectionAdd(which(), plus)}
              class="w-[22px] h-[22px] rounded-(--radius-sm) items-center justify-center hover:bg-line-subtle group"
            >
              <Text class="text-[15px] text-ink-muted group-hover:text-brand">+</Text>
            </View>
          )}
        </If>
      </View>
    );
  }

  function Note(p: { text: string; testID?: string }) {
    return (
      <Text testID={p.testID} class={`text-center text-ink-muted px-5 py-9 ${phone() ? "text-[13px]" : "text-[12px]"}`}>
        {p.text}
      </Text>
    );
  }

  const renderRow = (item: () => ListRow) => (
    <>
      <If when={rowOf(item(), "ghead")}>{(row) => <Heading row={row()} />}</If>
      <If when={rowOf(item(), "archived-ghead")}>
        <View testID="archived-ghead" class="flex-row items-center justify-between px-[10px] pt-[6px] pb-1">
          <Text class="text-[12px] font-semibold text-ink-muted">{t().sidebar.archivedSessions}</Text>
          <View
            role="button"
            testID="back-to-sessions"
            accessibilityLabel={t().sidebar.backToSessions}
            onPress={() => env().closeArchived()}
            class="px-1 py-[2px] rounded-(--radius-sm) hover:bg-line-subtle"
          >
            <Text class="text-[11px] font-medium text-brand">{t().sidebar.backToSessions}</Text>
          </View>
        </View>
      </If>
      <If when={rowOf(item(), "archived-empty")}>
        <Note testID="archived-empty" text={t().sidebar.archivedEmpty} />
      </If>
      <If when={rowOf(item(), "session")}>{(row) => <Session row={row()} />}</If>
      <If when={rowOf(item(), "dir")}>{(row) => <Dir row={row()} />}</If>
      <If when={rowOf(item(), "project")}>{(row) => <Project row={row()} />}</If>
      <If when={rowOf(item(), "hint")}>{(row) => <Note testID="working-empty" text={row().text} />}</If>
      <If when={rowOf(item(), "roster-empty")}>
        <EmptyState size="inline" level={3} title={t().sidebar.rosterEmpty} hint={t().sidebar.rosterEmptyHint}>
          <Button testID="roster-empty-add-bot" variant="primary" onPress={() => env().onCreateBot()}>{t().sidebar.addBot}</Button>
          <Button testID="roster-empty-add-group" variant="secondary" onPress={() => env().onCreateGroup()}>{t().sidebar.addGroup}</Button>
        </EmptyState>
      </If>
      <If when={rowOf(item(), "projects-empty")}>
        <EmptyState size="inline" level={3} title={t().project.emptyList} hint={t().project.emptyListHint}>
          {PROJECT_AGENTS.map((agent, index) => (
            <Button testID={`projects-empty-new-${agent}`} variant={index === 0 ? "primary" : "secondary"} onPress={() => env().onNewProject(agent)}>
              {`${t().project.newWith(t().project.agentNames[agent])}…`}
            </Button>
          ))}
          <Button testID="projects-empty-import" variant="secondary" onPress={() => env().onImportProject()}>{t().project.importSession}</Button>
        </EmptyState>
      </If>
    </>
  );

  return (
    <List
      testID="session-list"
      each={props.rows.slice()}
      keyExtractor={(row: ListRow) => row.key}
      estimatedItemSize={phone() ? 64 : 56}
      scrollbar={!phone()}
      desktop={{ windowDrag: true }}
      onScroll={dismissRailTips}
      class="flex-1 min-h-0"
      contentClass={`px-2 pt-[6px] ${phone() ? "pb-[84px]" : "pb-3"}`}
    >
      {renderRow}
    </List>
  );
}

