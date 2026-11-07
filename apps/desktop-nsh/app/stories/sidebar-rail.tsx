/**
 * The sidebar's chrome: the folded rail (avatars with hover tips, the footer's icons, the tools menu
 * flown out beside it), the wide list's top and bottom controls (working and focus switches, the holds
 * bar, the tools button and its menu, the footer row, the + menu of the Bot section) and a phone's
 * floating create button and archived head. The conversations are the fixture runtime's (Writer's
 * direct, 周报小组); a waiting approval on the group, unread on the direct, a project session and the
 * file drop are laid over its snapshot so the rail's badges and marks have something to show.
 */
import { Scroll, signal, Text, View, type ViewRef } from "nsh";
import { type Approval, type Hold, type SessionSummary, type Turn } from "@real-bot/protocol";
import { classifySession } from "../src/m/sidebar/session-groups";
import { focusMode } from "../src/m/chat/focus-mode.svelte";
import { runtime } from "../src/runtime";
import { Icon } from "../src/ui/Icon";
import { narrowWindow } from "../src/ui/Modal";
import { BotAddMenu } from "../src/ui/sidebar/BotAddMenu";
import { CreateFab } from "../src/ui/sidebar/CreateFab";
import { FocusToggle } from "../src/ui/sidebar/FocusToggle";
import { HoldsBar } from "../src/ui/sidebar/HoldsBar";
import { MobileArchivedHead } from "../src/ui/sidebar/MobileArchivedHead";
import { SidebarFoot } from "../src/ui/sidebar/SidebarFoot";
import { SidebarRail } from "../src/ui/sidebar/SidebarRail";
import { ToolsMenu } from "../src/ui/sidebar/ToolsMenu";
import { ToolsToggle } from "../src/ui/sidebar/ToolsToggle";
import { WorkingFilter } from "../src/ui/sidebar/WorkingFilter";

const extras = signal(false);
const hide = signal<string[]>([]);
const noWorkspace = signal(false);

/** The runtime's snapshot with the story's overlay: a waiting approval on the group, unread on the direct, and an optional project row. */
const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(runtime), "snapshot")!;
const real = descriptor.get!;
Object.defineProperty(runtime, "snapshot", {
  configurable: true,
  set: descriptor.set,
  get() {
    const snap = real.call(runtime);
    const group = snap.sessions.find((s: SessionSummary) => classifySession(s) === "group");
    const direct = snap.sessions.find((s: SessionSummary) => classifySession(s) === "you-bot");
    if (!group || !direct) return snap;
    const writer = snap.bots[0];
    const turn = {
      id: "turn-story",
      session_id: group.id,
      bot_id: writer?.id ?? "bot",
      status: "waiting_approval",
      trigger_message_id: "m-story",
      last_activity_at: "2026-11-01T02:00:01.000Z",
      created_at: "2026-11-01T02:00:00.000Z",
      updated_at: "2026-11-01T02:00:01.000Z",
    } as unknown as Turn;
    const approval = (id: string) =>
      ({ id, turn_id: "turn-story", message_id: "m-story", status: "pending", kind_key: "fs.write", summary: "写 outline/ep-12.md", target: "outline/ep-12.md", created_at: "2026-11-01T02:00:02.000Z", resolved_at: null, requires_api_key: false }) as unknown as Approval;
    const sessions: SessionSummary[] = snap.sessions.map((s: SessionSummary) => (s.id === direct.id ? ({ ...s, unread_count: 4 } as SessionSummary) : s));
    if (extras()) {
      sessions.push({ ...group, id: "project-story", kind: "project", title: "Deskfolk", project_dir: "/Users/dev/my-projects/real-bot", agent: "claude-code" } as unknown as SessionSummary);
    }
    const settings = noWorkspace() ? { ...snap.settings, workspace_path: null } : snap.settings;
    return { ...snap, settings, sessions: sessions.filter((s) => !hide().includes(s.id)), turns: [...snap.turns, turn], approvals: [...snap.approvals, approval("appr-1"), approval("appr-2")] };
  },
});

const HOLDS = [
  { id: "hold-1", scope: "bot", scope_id: "bot-1", action: "pause", cascade: false, source: "user_button", source_message_id: null, created_at: "2026-11-01T02:10:00.000Z" },
  { id: "hold-2", scope: "bot", scope_id: "bot-2", action: "cancel", cascade: false, source: "user_button", source_message_id: null, created_at: "2026-11-01T02:20:00.000Z" },
] as unknown as Hold[];

const log = signal<string[]>([]);
const say = (line: string) => log.set([...log(), line]);

export default function SidebarRailStory() {
  const pinned = signal<string[]>([]);
  const railTools = signal(false);
  const railFocusLast = signal(false);
  const footTools = signal(false);
  const footFocusLast = signal(false);
  const footToolsAnchor = signal<ViewRef | null>(null);
  const phoneTools = signal(false);
  const phoneToolsAnchor = signal<ViewRef | null>(null);
  const workspaceOpen = signal(false);
  const workingOnly = signal(false);
  const botMenu = signal(false);
  const botMenuAnchor = signal<ViewRef | null>(null);
  const fab = signal(false);
  const workbench = signal(true);
  const contextMenu = signal<string | null>(null);

  const state = () => `selected:${runtime.selectedId ?? "none"} settings:${runtime.settingsOpen ? "on" : "off"} workspace:${workspaceOpen() ? "on" : "off"} working:${workingOnly() ? "on" : "off"} bench:${workbench() ? "on" : "off"} focus:${focusMode.on ? "on" : "off"}`;
  const phone = () => narrowWindow();
  const group = () => runtime.snapshot.sessions.find((s) => classifySession(s) === "group");
  const direct = () => runtime.snapshot.sessions.find((s) => classifySession(s) === "you-bot");

  const toolsMenu = (anchor: () => ViewRef | null, open: () => boolean, set: (v: boolean) => void, placement: "stack" | "flyout", isPhone: boolean, focusLast?: () => boolean, setLast?: (v: boolean) => void) => (
    <ToolsMenu
      locale="zh"
      phone={isPhone}
      pages={isPhone}
      anchor={anchor()}
      open={open()}
      onOpenChange={set}
      placement={placement}
      focusLast={focusLast?.()}
      onFocusLastChange={setLast}
      archivedCount={3}
      current={{ terminal: false }}
      onOpenRoutines={() => say("routines")}
      onOpenSpend={() => say("spend")}
      onOpenUsage={() => say("usage")}
      onOpenRoles={() => say("roles")}
      onOpenTerminal={() => say("terminal")}
      onOpenScreen={isPhone ? () => say("screen") : null}
      onOpenWorkspace={isPhone ? () => say("workspace") : null}
      onOpenArchived={() => say("archived")}
    />
  );

  return (
    <View class="flex-1 flex-row bg-ground">
      <View class="w-[88px] pt-3 border-r border-line">
        <SidebarRail
          pinnedSessionIds={pinned()}
          contextMenuSessionId={contextMenu()}
          toolsMenuOpen={railTools()}
          onToolsMenuOpenChange={(open) => railTools.set(open)}
          workspaceOpen={workspaceOpen()}
          onOpenContextMenu={(_e, session) => {
            contextMenu.set(session.id);
            say(`menu:${session.id === direct()?.id ? "direct" : session.id === group()?.id ? "group" : session.id}`);
          }}
          onExpand={() => say("expand")}
          onToggleWorkspace={() => {
            workspaceOpen.set(!workspaceOpen());
            say("workspace-toggle");
          }}
          onOpenRoutines={() => say("rail-routines")}
          onOpenSpend={() => say("rail-spend")}
          workbench={workbench()}
          onNewTerminal={() => say("rail-terminal")}
          onOpenArchived={() => say("rail-archived")}
          onOpenSettings={() => {
            runtime.settingsOpen = !runtime.settingsOpen;
            say("rail-settings");
          }}
          onOpenSearch={() => say("search")}
          onDragSession={(phase, _point, session) => say(`drag${phase === "start" ? "" : `-${phase}`}:${session.id === direct()?.id ? "direct" : "group"}`)}
        />
      </View>
      <Scroll class="flex-1 min-w-0">
        <View class="gap-4 p-4">
          <Text testID="state" class="text-[12px] text-ink-muted">{state()}</Text>
          <Text testID="log" class="text-[12px] text-ink-muted">{log().length ? log().join(" | ") : "—"}</Text>
          <View class="flex-row gap-2 items-center">
            <View role="button" testID="story-pin" onPress={() => pinned.set(pinned().length ? [] : [group()?.id ?? ""])} class="px-2 py-1 border border-line rounded-(--radius-sm)">
              <Text class="text-[12px] text-ink">pin group</Text>
            </View>
            <View role="button" testID="story-extras" onPress={() => extras.set(!extras())} class="px-2 py-1 border border-line rounded-(--radius-sm)">
              <Text class="text-[12px] text-ink">extra rows</Text>
            </View>
            <View role="button" testID="story-hide-group" onPress={() => hide.set(hide().length ? [] : [group()?.id ?? ""])} class="px-2 py-1 border border-line rounded-(--radius-sm)">
              <Text class="text-[12px] text-ink">hide group</Text>
            </View>
            <View role="button" testID="story-no-workspace" onPress={() => noWorkspace.set(!noWorkspace())} class="px-2 py-1 border border-line rounded-(--radius-sm)">
              <Text class="text-[12px] text-ink">no workspace</Text>
            </View>
            <View role="button" testID="story-no-workbench" onPress={() => workbench.set(!workbench())} class="px-2 py-1 border border-line rounded-(--radius-sm)">
              <Text class="text-[12px] text-ink">no workbench</Text>
            </View>
          </View>
          <View class="flex-row items-center gap-2">
            <WorkingFilter workingOnly={workingOnly()} toggleWorkingOnly={() => workingOnly.set(!workingOnly())} />
            <FocusToggle />
            <View
              role="button"
              testID="bot-add-plus"
              ref={(node: ViewRef) => botMenuAnchor.set(node)}
              accessibilityLabel="+"
              onPress={() => botMenu.set(!botMenu())}
              class="w-[22px] h-[22px] items-center justify-center rounded-(--radius-sm) hover:bg-row-hover"
            >
              <Icon name="plus" size={12} class="tint-ink-muted" />
            </View>
            <If when={phone()}>
              <View testID="phone-tools">
                <ToolsToggle phone onAnchor={(n) => phoneToolsAnchor.set(n)} open={phoneTools()} onOpenChange={(v) => phoneTools.set(v)} />
              </View>
            </If>
          </View>
          <View class="w-[300px] gap-2">
            <HoldsBar
              holds={HOLDS}
              label={(hold) => (hold.id === "hold-1" ? "Writer" : "Editor")}
              onLift={async (hold) => {
                say(`lift:${hold.id}`);
                return hold.id === "hold-2" ? new Error("refused") : undefined;
              }}
            />
          </View>
          <View testID="foot-wide" class="w-[300px] border border-line rounded-(--radius-md)">
            <SidebarFoot
              workspaceOpen={workspaceOpen()}
              workspacePath={runtime.snapshot.settings.workspace_path}
              onToggleWorkspace={() => {
                workspaceOpen.set(!workspaceOpen());
                say("workspace-toggle");
              }}
              onOpenSettings={() => say("foot-settings")}
              toolsMenuOpen={footTools()}
              onToolsMenuOpenChange={(v) => footTools.set(v)}
              onToolsFocusLast={(v) => footFocusLast.set(v)}
              onToolsAnchor={(n) => footToolsAnchor.set(n)}
            />
          </View>
          <View testID="foot-narrow" class="w-[190px] border border-line rounded-(--radius-md)">
            <SidebarFoot
              workspaceOpen={false}
              workspacePath="/fixture"
              onToggleWorkspace={() => say("narrow-workspace")}
              onOpenSettings={() => say("narrow-settings")}
              onToolsMenuOpenChange={() => undefined}
            />
          </View>
          <MobileArchivedHead count={3} onBack={() => say("archived-back")} />
        </View>
      </Scroll>
      <BotAddMenu
        anchor={botMenuAnchor()}
        open={botMenu()}
        onOpenChange={(v) => botMenu.set(v)}
        onCreateBot={() => say("create-bot")}
        onCreateGroup={() => say("create-group")}
      />
      {toolsMenu(footToolsAnchor, footTools, (v) => footTools.set(v), "stack", false, footFocusLast, (v) => footFocusLast.set(v))}
      {toolsMenu(phoneToolsAnchor, phoneTools, (v) => phoneTools.set(v), "stack", true)}
      <If when={phone()}>
        <CreateFab
          createMenuOpen={fab()}
          onCreateMenuOpenChange={(v) => fab.set(v)}
          onCreateBot={() => say("fab-bot")}
          onCreateGroup={() => say("fab-group")}
          onNewProject={() => say("fab-new-project")}
          onImportProject={() => say("fab-import")}
        />
      </If>
    </View>
  );
}
