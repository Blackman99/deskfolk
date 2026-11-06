/**
 * The full session list (`Sidebar`) on the runtime's own conversations: Writer's direct and 周报小组,
 * plus what the buttons make (a group, a project session in the workspace) and the overlay lays on the
 * snapshot (a Bot at work in the group, a hold). Every callback the shell would pass writes a line to
 * `log:`; `story-state` reads the pieces a test checks. The buttons are the test's hands: it cannot
 * reach the network itself.
 */
import { host, Scroll, signal, Text, View } from "nsh";
import type { Hold, SessionSummary, Turn } from "@real-bot/protocol";
import { isSessionPinned, togglePinnedId } from "../src/m/sidebar/pinned-sessions";
import { classifySession } from "../src/m/sidebar/session-groups";
import { runtime } from "../src/runtime";
import { narrowWindow } from "../src/ui/Modal";
import { Sidebar, type SidebarHandle } from "../src/ui/sidebar/Sidebar";

const working = signal(false);
const hold = signal(false);

/** The runtime's snapshot with the story's overlay: a running turn in the group, and a hold to lift. */
const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(runtime), "snapshot")!;
const real = descriptor.get!;
Object.defineProperty(runtime, "snapshot", {
  configurable: true,
  set: descriptor.set,
  get() {
    const snap = real.call(runtime);
    const group = snap.sessions.find((s: SessionSummary) => classifySession(s) === "group");
    if (!group) return snap;
    const turns = working()
      ? [
          ...snap.turns,
          {
            id: "turn-main",
            session_id: group.id,
            bot_id: snap.bots[0]?.id ?? "bot",
            status: "running",
            trigger_message_id: "m-main",
            last_activity_at: "2026-11-01T02:00:01.000Z",
            created_at: "2026-11-01T02:00:00.000Z",
            updated_at: "2026-11-01T02:00:01.000Z",
          } as unknown as Turn,
        ]
      : snap.turns;
    const holds = hold()
      ? [{ id: "hold-main", scope: "bot", scope_id: snap.bots[0]?.id ?? "bot", action: "cancel", cascade: false, source: "user_button", source_message_id: null, created_at: "2026-11-01T02:10:00.000Z" } as unknown as Hold]
      : snap.holds;
    return { ...snap, turns, holds, holdsOn: hold() ? true : snap.holdsOn };
  },
});

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { origin, token } = host.params as { origin: string; token: string };
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

function StoryButton(props: { id: string; label: string; onPress: () => void }) {
  return (
    <View role="button" testID={props.id} onPress={props.onPress} class="px-2 py-1 border border-line rounded-(--radius-sm)">
      <Text class="text-[11px] text-ink">{props.label}</Text>
    </View>
  );
}

export default function SidebarMainStory() {
  const log = signal<string[]>([]);
  const say = (line: string) => log.set([...log(), line]);
  const pinned = signal<string[]>([]);
  const toolsOpen = signal(false);
  const createOpen = signal(false);
  const contextId = signal<string | null>(null);
  const renaming = signal<string | null>(null);
  const phoneList = signal<"bots" | "projects">("bots");
  const collapsible = signal(true);
  const workbench = signal(true);
  const dragEnabled = signal(true);
  const made: string[] = [];
  let handle: SidebarHandle | null = null;

  const selected = () => runtime.snapshot.sessions.find((s) => s.id === runtime.selectedId) ?? null;
  const lastProject = () => runtime.snapshot.sessions.find((s) => s.id === made.filter((id) => runtime.snapshot.sessions.some((x) => x.id === id && x.kind === "project")).pop()) ?? null;
  const idOf = (id: string) => (id === runtime.snapshot.sessions.find((s) => classifySession(s) === "you-bot")?.id ? "direct" : id === runtime.snapshot.sessions.find((s) => classifySession(s) === "group")?.id ? "group" : id);
  const state = () =>
    `selected:${runtime.selectedId ?? "none"} tools:${toolsOpen() ? "on" : "off"} create:${createOpen() ? "on" : "off"} pinned:${pinned().map(idOf).join(",") || "-"} renaming:${renaming() ? "on" : "off"} settings:${runtime.settingsOpen ? "on" : "off"} page:${runtime.listPage ?? "none"} dirs:${[...new Set(runtime.snapshot.sessions.filter((x) => x.kind === "project").map((x) => x.project_dir))].join("|") || "-"}`;

  return (
    <View class="flex-1 bg-ground">
      <View class="flex-row flex-wrap gap-1 p-1 border-b border-line">
        <StoryButton
          id="make-group"
          label="make group"
          onPress={async () => {
            const g = await call<{ id: string }>("POST", "/v1/sessions", { name: `测试组 ${made.length + 1}`, members: runtime.snapshot.bots.map((b) => b.id) });
            made.push(g.id);
            say(`made:${g.id}`);
          }}
        />
        <StoryButton
          id="make-project"
          label="make project"
          onPress={async () => {
            const p = await call<{ id: string }>("POST", "/v1/project-sessions", { dir: runtime.snapshot.settings.workspace_path });
            made.push(p.id);
            say(`made:${p.id}`);
          }}
        />
        <StoryButton
          id="drop-made"
          label="drop made"
          onPress={async () => {
            for (const id of made.splice(0)) await call("DELETE", `/v1/sessions/${id}`).catch(() => null);
            say("dropped");
          }}
        />
        <StoryButton
          id="archive-made"
          label="archive made group"
          onPress={async () => {
            const id = made.find((m) => runtime.snapshot.sessions.some((s) => s.id === m && s.kind === "group"));
            if (id) await runtime.archiveSession(id);
            say("archived");
          }}
        />
        <StoryButton id="toggle-work" label="work" onPress={() => working.set(!working())} />
        <StoryButton id="toggle-hold" label="hold" onPress={() => hold.set(!hold())} />
        <StoryButton
          id="pin-direct"
          label="pin direct"
          onPress={() => {
            const d = runtime.snapshot.sessions.find((s) => classifySession(s) === "you-bot");
            if (d) pinned.set(togglePinnedId(pinned(), d.id));
          }}
        />
        <StoryButton
          id="pin-project"
          label="pin project"
          onPress={() => {
            const p = lastProject();
            if (p) pinned.set(togglePinnedId(pinned(), p.id));
          }}
        />
        <StoryButton
          id="rename-project"
          label="rename project"
          onPress={() => {
            const p = lastProject();
            if (p) renaming.set(p.id);
          }}
        />
        <StoryButton id="show-archived" label="show archived" onPress={() => handle?.showArchived()} />
        <StoryButton id="phone-projects" label="projects page" onPress={() => phoneList.set(phoneList() === "bots" ? "projects" : "bots")} />
        <StoryButton id="toggle-collapse" label="collapse btn" onPress={() => collapsible.set(!collapsible())} />
        <StoryButton id="toggle-bench" label="workbench" onPress={() => workbench.set(!workbench())} />
        <StoryButton id="toggle-drag" label="drag" onPress={() => dragEnabled.set(!dragEnabled())} />
        <StoryButton id="clear-select" label="clear" onPress={() => void runtime.selectSession("")} />
      </View>
      <View class="flex-1 min-h-0 flex-row">
        <View class={narrowWindow() ? "flex-1" : "w-[300px] border-r border-line"}>
          <Sidebar
            selected={selected()}
            pinnedSessionIds={pinned()}
            onOpenSearch={() => say("search")}
            createMenuOpen={createOpen()}
            onCreateMenuOpenChange={(open) => createOpen.set(open)}
            toolsMenuOpen={toolsOpen()}
            onToolsMenuOpenChange={(open) => toolsOpen.set(open)}
            workspaceOpen={false}
            contextMenuSessionId={contextId()}
            renamingSessionId={renaming()}
            phoneList={phoneList()}
            onRenameSession={async (id, name) => {
              if (name !== null && (await runtime.patchSession(id, { name }))) return false;
              renaming.set(null);
              say(name === null ? "rename:none" : `rename:${name}`);
              return true;
            }}
            onOpenContextMenu={(_at, session) => {
              contextId.set(session.id);
              say(`menu:${idOf(session.id)}`);
            }}
            onTogglePin={(id) => {
              pinned.set(togglePinnedId(pinned(), id));
              say(`pin:${idOf(id)}:${isSessionPinned(pinned(), id) ? "on" : "off"}`);
            }}
            onOpenProjectDir={(session) => say(`dir:${session.project_dir ?? ""}`)}
            onToggleWorkspace={() => say("workspace")}
            onOpenRoutines={() => say("routines")}
            onOpenSpend={() => say("spend")}
            workbench={workbench()}
            onNewTerminal={() => say("terminal")}
            onOpenSettings={() => {
              runtime.settingsOpen = !runtime.settingsOpen;
              say("settings");
            }}
            onCreateBot={() => say("create-bot")}
            onCreateGroup={() => say("create-group")}
            onCollapse={collapsible() ? () => say("collapse") : undefined}
            onDragSession={dragEnabled() ? (_e, session) => say(`drag:${idOf(session.id)}`) : undefined}
            onHandle={(h) => {
              handle = h;
            }}
          />
        </View>
        <Scroll class="flex-1 min-w-0">
          <View class="p-2 gap-1">
            <Text testID="story-state" class="text-[11px] text-ink-muted">{state()}</Text>
            <Text testID="log" class="text-[11px] text-ink-muted">{`log: ${log().join(" ") || "—"}`}</Text>
          </View>
        </Scroll>
      </View>
    </View>
  );
}
