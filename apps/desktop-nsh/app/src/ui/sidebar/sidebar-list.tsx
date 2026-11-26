/**
 * The list of the sidebar (`Sidebar.svelte`'s `.groups`): collapsible section headings, compact
 * Bot rows, project directories with their single-line tree sessions, the archived list and the
 * empty notes, in one virtualised `List`. `rows` is the flat array `listRows` builds; every row
 * reads its item through the accessor, since a cell is recycled for another row.
 */
import { computed, List, platform, Text, View, type ViewRef } from "nsh";
import type { SessionDragHandler } from "./session-drag";
import type { Bot, ProjectAgent, SessionSummary } from "@real-bot/protocol";
import { isSessionPinned } from "../../m/sidebar/pinned-sessions";
import { PROJECT_AGENTS, projectAgentOf, type ProjectDirGroup } from "../../m/sidebar/project-groups";
import { sameSessionStatus, type SessionStatusResult } from "../../m/sidebar/session-status";
import type { SidebarSectionKey } from "../../m/sidebar/sidebar-fold-state";
import { copy } from "../../runtime";
import { Button } from "../Button";
import { EmptyState } from "../EmptyState";
import { Icon } from "../Icon";
import { tip } from "../tip";
import { dismissRailTips } from "./RailTooltip";
import { ProjectSessionRow } from "./ProjectSessionRow";
import { SessionRow, type MenuAt } from "./SessionRow";
import type { ListRow } from "./sidebar-list-model";
import { SEAM_BORDER, SIDE_MUTED_TEXT, SIDE_MUTED_TINT } from "../glass";
import { foldMotion } from "./fold-motion";

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
  onSectionAdd: (section: SidebarSectionKey, anchor: ViewRef | null) => void;
  sectionMenuOpen: (section: SidebarSectionKey) => boolean;
  toggleSection: (section: SidebarSectionKey) => void;
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
  const fold = foldMotion();
  const t = () => copy();
  const env = () => props.env;
  const phone = () => props.env.phone;

  function Session(p: { row: Extract<ListRow, { kind: "session" }> }) {
    const e = env();
    const session = () => p.row.session;
    // Once per change, and kept when equal: it reads every turn, approval and message, so each streamed
    // token made every row work it out again in each binding that read it.
    const status = computed(() => e.statusOf(session()), { equals: sameSessionStatus });
    const variant = () => p.row.variant;
    return (
      <SessionRow
        session={session()}
        on={e.selectedId() === session().id}
        contextOpen={e.contextMenuSessionId() === session().id}
        compact={!phone() && variant() === "bot"}
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
    const status = computed(() => e.projectStatusOf(session()), { equals: sameSessionStatus });
    return (
      <View class={phone() ? "pl-[14px]" : "flex-row items-stretch pl-[13px]"}>
        <If when={!phone()}>
          <View accessible={false} class="w-[1px] mr-[6px] bg-ink/8 dark:bg-ink/10 shrink-0" />
        </If>
        <View class="flex-1 min-w-0">
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
            status={status()}
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
        class="group flex-row items-center mt-[2px]"
        style={fold?.text}
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
          class={`cursor-pointer select-none group flex-1 min-w-0 flex-row items-center gap-[5px] px-[8px] py-[3px] rounded-(--radius-sm) hover:bg-row-hover ${phone() ? "min-h-[44px] pl-[14px]" : "min-h-[28px]"}`}
        >
          <Icon name={p.row.open ? "chevron-down" : "chevron-right"} size={12} class={SIDE_MUTED_TINT} />
          <Icon name="folder" size={16} class="tint-ink-secondary" />
          <Text testID="project-dir-name" class="flex-1 min-w-0 line-clamp-1 text-[12.5px] font-semibold text-ink-secondary">{group().label}</Text>
          <If when={p.row.live}>
            <View testID="project-dir-live" accessible={false} class="shrink-0 w-[6px] h-[6px] rounded-full bg-brand" />
          </If>
          <If when={!p.row.open && p.row.count > 0}>
            <Text class={`shrink-0 text-[11px] font-medium ${SIDE_MUTED_TEXT}`}>{String(p.row.count)}</Text>
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
          class={`cursor-pointer select-none group shrink-0 items-center justify-center mr-[4px] rounded-(--radius-sm) hover:bg-line-subtle ${phone() ? "w-[40px] h-[40px]" : "w-[24px] h-[24px]"} ${hoverOnly() ? "opacity-0 group-hover:opacity-100 focus-visible:opacity-100" : ""}`}
        >
          <Icon name="plus" size={12} class={`${SIDE_MUTED_TINT} group-hover:tint-brand`} />
        </View>
      </View>
    );
  }

  function Heading(p: { row: Extract<ListRow, { kind: "ghead" }> }) {
    const e = env();
    let plus: ViewRef | null = null;
    const section = () => p.row.add;
    const collapsible = () => p.row.collapsible;
    const isOpen = () => p.row.open !== false;
    return (
      <View
        testID={p.row.key}
        class={`flex-row items-center justify-between ${phone() ? "px-[14px] pb-1" : "px-[8px] pb-[3px]"} ${
          p.row.divider ? `mt-2 pt-2 border-t ${SEAM_BORDER}` : p.row.first ? "pt-[4px]" : phone() ? "pt-3" : "pt-[10px]"
        }`}
        style={fold?.text}
      >
        <If
          when={collapsible()}
          else={<Text class={`text-[11.5px] font-semibold ${SIDE_MUTED_TEXT}`}>{p.row.title}</Text>}
        >
          {(key) => (
            <View
              role="button"
              testID={`section-toggle:${key()}`}
              accessibilityLabel={t().sidebar.toggleSection(p.row.title)}
              accessibilityState={{ expanded: isOpen() }}
              onPress={() => e.toggleSection(key())}
              class="cursor-pointer select-none flex-row items-center gap-[4px] py-[2px] pr-[6px] rounded-(--radius-xs) hover:bg-row-hover"
            >
              <Icon name={isOpen() ? "chevron-down" : "chevron-right"} size={12} class={SIDE_MUTED_TINT} />
              <Text class={`text-[11.5px] font-semibold ${SIDE_MUTED_TEXT}`}>{p.row.title}</Text>
              <If when={!isOpen() && (p.row.count ?? 0) > 0}>
                <Text class={`text-[11px] font-medium ${SIDE_MUTED_TEXT}`}>{String(p.row.count)}</Text>
              </If>
              <If when={p.row.live}>
                <View testID={`section-live:${key()}`} accessible={false} class="w-[6px] h-[6px] rounded-full bg-brand ml-[2px]" />
              </If>
            </View>
          )}
        </If>
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
              class="cursor-pointer select-none w-[22px] h-[22px] rounded-(--radius-sm) items-center justify-center hover:bg-line-subtle group"
            >
              <Icon name="plus" size={12} class={`${SIDE_MUTED_TINT} group-hover:tint-brand`} />
            </View>
          )}
        </If>
      </View>
    );
  }

  function Note(p: { text: string; testID?: string }) {
    return (
      <Text testID={p.testID} class={`text-center ${SIDE_MUTED_TEXT} px-5 py-9 ${phone() ? "text-[13px]" : "text-[12px]"}`} style={fold?.text}>
        {p.text}
      </Text>
    );
  }

  const renderRow = (item: () => ListRow) => (
    <>
      <If when={rowOf(item(), "ghead")}>{(row) => <Heading row={row()} />}</If>
      <If when={rowOf(item(), "archived-ghead")}>
        <View testID="archived-ghead" class="flex-row items-center justify-between px-[10px] pt-[6px] pb-1" style={fold?.text}>
          <Text class={`text-[12px] font-semibold ${SIDE_MUTED_TEXT}`}>{t().sidebar.archivedSessions}</Text>
          <View
            role="button"
            testID="back-to-sessions"
            accessibilityLabel={t().sidebar.backToSessions}
            onPress={() => env().closeArchived()}
            class="cursor-pointer select-none px-1 py-[2px] rounded-(--radius-sm) hover:bg-line-subtle"
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
        <View style={fold?.text}>
          <EmptyState size="inline" level={3} title={t().sidebar.rosterEmpty} hint={t().sidebar.rosterEmptyHint}>
            <Button testID="roster-empty-add-bot" variant="primary" onPress={() => env().onCreateBot()}>{t().sidebar.addBot}</Button>
            <Button testID="roster-empty-add-group" variant="secondary" onPress={() => env().onCreateGroup()}>{t().sidebar.addGroup}</Button>
          </EmptyState>
        </View>
      </If>
      <If when={rowOf(item(), "projects-empty")}>
        <View style={fold?.text}>
          <EmptyState size="inline" level={3} title={t().project.emptyList} hint={t().project.emptyListHint}>
            {PROJECT_AGENTS.map((agent, index) => (
              <Button testID={`projects-empty-new-${agent}`} variant={index === 0 ? "primary" : "secondary"} onPress={() => env().onNewProject(agent)}>
                {`${t().project.newWith(t().project.agentNames[agent])}…`}
              </Button>
            ))}
            <Button testID="projects-empty-import" variant="secondary" onPress={() => env().onImportProject()}>{t().project.importSession}</Button>
          </EmptyState>
        </View>
      </If>
    </>
  );

  return (
    <List
      testID="session-list"
      each={props.rows.slice()}
      keyExtractor={(row: ListRow) => row.key}
      estimatedItemSize={phone() ? 64 : 38}
      scrollbar={!phone()}
      desktop={{ windowDrag: true }}
      onScroll={dismissRailTips}
      class="flex-1 min-h-0"
      contentClass={`px-2 pt-[4px] ${phone() ? "pb-[84px]" : "pb-3"}`}
    >
      {renderRow}
    </List>
  );
}
