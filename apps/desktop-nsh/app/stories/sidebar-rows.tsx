/**
 * The sidebar's rows: the pinned strip, the conversation rows on the runtime's own sessions (pin,
 * the menu, rename, archive, delete through the runtime as `Shell.svelte` does), and a column of
 * fixtures for what the runtime has no session for (working, waiting, unread, elsewhere, file drop,
 * a project session in each state), plus the add menu.
 */
import { host, List, Scroll, signal, Text, View, type ViewRef } from "nsh";
import type { Bot, ProjectAgent, SessionSummary } from "@real-bot/protocol";
import { dangerCopy, type DangerKind } from "../src/m/overlays/danger-confirm";
import { formatListTime, listTimeSource } from "../src/m/sidebar/list-time";
import { isSessionPinned, togglePinnedId } from "../src/m/sidebar/pinned-sessions";
import { plainPreview } from "../src/m/sidebar/preview-text";
import { projectAgentOf } from "../src/m/sidebar/project-groups";
import { deriveSessionContextMenu } from "../src/m/sidebar/session-context-menu";
import { classifySession, isFileDropSession, isSessionArchived, youBotPeer } from "../src/m/sidebar/session-groups";
import { agentRunStatus, botWorkStatus, sidebarStatus, type SessionStatusResult } from "../src/m/sidebar/session-status";
import { sessionTitle } from "../src/m/sidebar/session-title";
import { sessionUnreadCount } from "../src/m/sidebar/unread";
import { latestPreview } from "../src/m/chat/transcript";
import { copy, runtime } from "../src/runtime";
import { Button } from "../src/ui/Button";
import { IconButton } from "../src/ui/IconButton";
import { rosterLabelsOf, statusLabelsOf } from "../src/ui/chat/labels";
import { narrowWindow } from "../src/ui/Modal";
import { DangerDialog } from "../src/ui/overlays/DangerDialog";
import { PinnedRoster } from "../src/ui/sidebar/PinnedRoster";
import { ProjectAddMenu } from "../src/ui/sidebar/ProjectAddMenu";
import { ProjectSessionRow } from "../src/ui/sidebar/ProjectSessionRow";
import { SessionContextMenu } from "../src/ui/sidebar/SessionContextMenu";
import { SessionRow } from "../src/ui/sidebar/SessionRow";

const botsById = (): ReadonlyMap<string, Bot> => new Map(runtime.snapshot.bots.map((b) => [b.id, b] as const));
const statusLabels = () => ({ ...statusLabelsOf(copy()), background: copy().sidebar.statusBackground });
const titleOf = (s: SessionSummary) => sessionTitle(s, botsById(), rosterLabelsOf(copy()));
const timeOf = (s: SessionSummary) => formatListTime(listTimeSource(s), Date.now(), runtime.snapshot.settings.locale === "en" ? "en" : "zh");
const previewOf = (s: SessionSummary) => {
  const snap = runtime.snapshot;
  return plainPreview(latestPreview(snap.messages, s.id, s, snap.turns, 400));
};
const unreadOf = (s: SessionSummary) => sessionUnreadCount(s, runtime.selectedId);
const botStatusOf = (botId: string) => {
  const snap = runtime.snapshot;
  return botWorkStatus(botId, snap.turns, snap.approvals, statusLabels(), snap.pendingJudgements);
};
const statusOf = (s: SessionSummary): SessionStatusResult => {
  const snap = runtime.snapshot;
  if (s.kind === "project") return agentRunStatus(snap.agentRuns[s.id], statusLabels()) ?? sidebarStatus(s, snap.turns, snap.approvals, statusLabels(), snap.pendingJudgements, snap.messages);
  return sidebarStatus(s, snap.turns, snap.approvals, statusLabels(), snap.pendingJudgements, snap.messages);
};
const archivedSuffix = (s: SessionSummary): string => {
  if (isFileDropSession(s)) return "";
  if (s.archived_at) return ` · ${copy().top.archived}`;
  const peer = youBotPeer(s);
  return peer && botsById().get(peer)?.archived_at ? ` · ${copy().top.archived}` : "";
};

/** The runtime the story stands on, asked directly: what a test makes to act on, and the server's own word on what happened. */
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

const IDLE: SessionStatusResult = { kind: "idle", label: "", isBusy: false };
const noBotStatus = () => undefined;

/** A project session the runtime has none of, for the fixtures column. */
const projectFixture = (patch: Partial<SessionSummary>): SessionSummary =>
  ({
    id: "fx-project",
    kind: "project",
    name: null,
    project_dir: "/Users/me/code/demo",
    project_agent: "claude_code",
    participants: [],
    updated_at: new Date().toISOString(),
    last_message: null,
    ...patch,
  }) as unknown as SessionSummary;

export default function SidebarRows() {
  const log = signal<string[]>([]);
  const say = (line: string) => log.set([...log(), line]);
  const pinned = signal<string[]>([]);
  const menu = signal<{ session: SessionSummary; x: number; y: number } | null>(null);
  const renaming = signal<string | null>(null);
  const danger = signal<{ kind: DangerKind; id: string; busy: boolean } | null>(null);
  const eraseOption = signal(false);
  const addOpen = signal(false);
  const addPoint = signal<{ x: number; y: number } | null>(null);
  const fxRenaming = signal(false);
  const probe = signal("");
  const made: string[] = [];
  let plus: ViewRef | null = null;

  const sessions = () =>
    [...runtime.snapshot.sessions].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  const live = () => sessions().filter((s) => !isSessionArchived(s, botsById()));
  const archived = () => sessions().filter((s) => isSessionArchived(s, botsById()));
  const pinnedSessions = () => pinned().flatMap((id) => runtime.snapshot.sessions.filter((s) => s.id === id));
  const isPinned = (s: SessionSummary) => isSessionPinned(pinned(), s.id);

  async function toggleArchive(session: SessionSummary): Promise<void> {
    if (session.kind === "group" || session.kind === "project") {
      await (session.archived_at ? runtime.restoreSession(session.id) : runtime.archiveSession(session.id));
      return;
    }
    const peer = youBotPeer(session);
    const bot = peer ? botsById().get(peer) : undefined;
    if (bot) await (bot.archived_at ? runtime.restoreBot(bot.id) : runtime.archiveBot(bot.id));
  }

  function askDelete(session: SessionSummary): void {
    const data = deriveSessionContextMenu(session, false, botsById());
    if (data.delete.kind && data.delete.targetId) danger.set({ kind: data.delete.kind, id: data.delete.targetId, busy: false });
  }

  async function confirmDanger(): Promise<void> {
    const d = danger();
    if (!d) return;
    danger.set({ ...d, busy: true });
    const error =
      d.kind === "bot" ? await runtime.deleteBot(d.id) : d.kind === "history" ? await runtime.clearSessionHistory(d.id, { eraseQuotes: eraseOption() }) : await runtime.deleteSession(d.id, { eraseQuotes: eraseOption() });
    if (error) danger.set({ ...d, busy: false });
    else danger.set(null);
  }

  /** A row of the list; `session` is read where it is used, so the row follows the runtime. */
  const row = (session: () => SessionSummary, isArchivedRow = false) => (
    <If
      when={session().kind === "project"}
      else={
        <SessionRow
          session={session()}
          on={runtime.selectedId === session().id}
          contextOpen={menu()?.session.id === session().id}
          archived={isArchivedRow}
          fileDrop={isFileDropSession(session())}
          title={titleOf(session())}
          time={timeOf(session())}
          status={statusOf(session())}
          preview={previewOf(session())}
          unread={unreadOf(session())}
          bots={botsById()}
          botStatus={botStatusOf}
          onSelect={() => void runtime.selectSession(session().id)}
          onContextMenu={(at) => menu.set({ session: session(), ...at })}
          pinned={isPinned(session())}
          onTogglePin={() => pinned.set(togglePinnedId(pinned(), session().id))}
        />
      }
    >
      <ProjectSessionRow
        session={session()}
        on={runtime.selectedId === session().id}
        contextOpen={menu()?.session.id === session().id}
        title={titleOf(session())}
        time={timeOf(session())}
        status={statusOf(session())}
        preview={previewOf(session())}
        unread={unreadOf(session())}
        bots={botsById()}
        botStatus={botStatusOf}
        onSelect={() => void runtime.selectSession(session().id)}
        onContextMenu={(at) => menu.set({ session: session(), ...at })}
        pinned={isPinned(session())}
        onTogglePin={() => pinned.set(togglePinnedId(pinned(), session().id))}
        agent={projectAgentOf(session())}
        name={session().name ?? null}
        renaming={renaming() === session().id}
        onRename={async (name) => {
          if (name !== null && (await runtime.patchSession(session().id, { name }))) return false;
          renaming.set(null);
          return true;
        }}
      />
    </If>
  );

  const fixture = (testID: string, node: () => ReturnType<typeof SessionRow>) => (
    <View testID={testID}>{node()}</View>
  );
  const fxBase = (patch: Partial<Parameters<typeof SessionRow>[0]> & { session: SessionSummary; title: string }) =>
    ({
      on: false,
      contextOpen: false,
      time: "09:41",
      status: IDLE,
      preview: "",
      unread: 0,
      bots: botsById(),
      botStatus: noBotStatus,
      onSelect: () => say(`select:${patch.session.id}`),
      onContextMenu: () => say(`menu:${patch.session.id}`),
      ...patch,
    }) satisfies Parameters<typeof SessionRow>[0];

  /** A fixture row stands on a copy of a real direct, under an id of its own (the real row keeps `session-<id>`). */
  const fx = (name: string): SessionSummary => ({ ...(runtime.snapshot.sessions.find((s) => s.kind === "direct") ?? runtime.snapshot.sessions[0]!), id: `fx-${name}` });

  return (
    <Scroll class="flex-1 bg-bg">
      <View class={`gap-6 p-6 ${narrowWindow() ? "" : "flex-row items-start"}`}>
        <View testID="sidebar" class={`bg-sidebar rounded-(--radius-md) ${narrowWindow() ? "w-full" : "w-[300px]"}`} style={{ height: 640 }}>
          <If when={pinnedSessions().length > 0}>
            <PinnedRoster
              pinnedSessions={pinnedSessions()}
              contextMenuSessionId={menu()?.session.id ?? null}
              onOpenContextMenu={(at, session) => menu.set({ session, ...at })}
              botsById={botsById()}
              botStatusOf={botStatusOf}
              statusOf={statusOf}
              unreadOf={unreadOf}
              titleOf={titleOf}
              archivedSuffix={archivedSuffix}
            />
          </If>
          <View class="flex-row items-center justify-between px-4 py-2">
            <Text class="text-[13px] font-semibold text-sidebar-foreground">{copy().project.section}</Text>
            <View ref={(n: ViewRef | null) => (plus = n)}>
              <IconButton testID="add-open" icon="plus" size="sm" label={copy().project.add} onPress={() => { addPoint.set(null); addOpen.set(true); }} />
            </View>
          </View>
          <List
            testID="session-list"
            each={live()}
            keyExtractor={(s) => s.id}
            class="flex-1"
            contentClass="px-2 pb-3"
            estimatedItemSize={60}
          >
            {(session) => row(session)}
          </List>
          <If when={archived().length > 0}>
            <View testID="archived-list" class="px-2 pb-3">
              <Each of={archived()} key={(s) => s.id}>{(session) => row(session, true)}</Each>
            </View>
          </If>
        </View>

        <View testID="fixtures" class={`gap-2 ${narrowWindow() ? "w-full" : "w-[300px]"}`}>
          <If when={runtime.snapshot.sessions.length > 0}>
          {fixture("fx-working", () => (
            <SessionRow {...fxBase({ session: fx("working"), title: "Working row", status: { kind: "running", label: "正在处理", isBusy: true }, preview: "hidden by status" })} />
          ))}
          {fixture("fx-waiting", () => (
            <SessionRow {...fxBase({ session: fx("waiting"), title: "Waiting row", status: { kind: "waiting_approval", label: "等你放行", isBusy: false, count: 2 } })} />
          ))}
          {fixture("fx-unread", () => (
            <SessionRow {...fxBase({ session: fx("unread"), title: "Unread row", unread: 120, preview: "最后一句话", time: "昨天" })} />
          ))}
          {fixture("fx-elsewhere", () => (
            <SessionRow {...fxBase({ session: fx("elsewhere"), title: "Elsewhere row", elsewhere: "在「周报小组」里工作", preview: "last line" })} />
          ))}
          {fixture("fx-archived", () => (
            <SessionRow {...fxBase({ session: fx("archived"), title: "Archived row", archived: true, preview: "old line" })} />
          ))}
          {fixture("fx-filedrop", () => (
            <SessionRow {...fxBase({ session: fx("filedrop"), title: copy().sidebar.fileDrop, fileDrop: true, showCount: false, preview: "3 files" })} />
          ))}
          <View testID="fx-project">
            <ProjectSessionRow
              {...fxBase({ session: projectFixture({}), title: "Project row", preview: "ran the tests" })}
              agent={"codex" as ProjectAgent}
              name={"Demo"}
              renaming={fxRenaming()}
              onRename={async (name) => {
                say(`rename:${name ?? "none"}`);
                if (name === "bad") return false;
                fxRenaming.set(false);
                return true;
              }}
              status={{ kind: "running", label: "正在处理", isBusy: true }}
            />
          </View>
          <Button testID="dir-add-open" variant="secondary" size="sm" onPress={() => { addPoint.set({ x: 640, y: 320 }); addOpen.set(true); }}>directory menu</Button>
          <Button testID="fx-rename" variant="secondary" size="sm" onPress={() => fxRenaming.set(true)}>rename fixture</Button>
          </If>
          <View testID="tools" class="flex-row flex-wrap gap-2">
            <Button
              testID="make-group"
              variant="secondary"
              size="sm"
              onPress={async () => {
                const members = runtime.snapshot.bots.map((b) => b.id);
                const g = await call<{ id: string }>("POST", "/v1/sessions", { name: `测试组 ${made.length + 1}`, members });
                made.push(g.id);
                say(`made:${g.id}`);
              }}
            >
              make group
            </Button>
            <Button
              testID="make-project"
              variant="secondary"
              size="sm"
              onPress={async () => {
                const p = await call<{ id: string }>("POST", "/v1/project-sessions", { dir: runtime.snapshot.settings.workspace_path });
                made.push(p.id);
                say(`made:${p.id}`);
              }}
            >
              make project
            </Button>
            <Button
              testID="probe"
              variant="secondary"
              size="sm"
              onPress={async () => {
                const { items } = await call<{ items: Array<{ id: string; name?: string | null; archived_at?: string | null }> }>("GET", "/v1/sessions");
                probe.set(JSON.stringify(items.map((s) => [s.id, s.name ?? "", s.archived_at ? 1 : 0])));
              }}
            >
              probe
            </Button>
            <Button
              testID="drop-made"
              variant="secondary"
              size="sm"
              onPress={async () => {
                for (const id of made.splice(0)) await call("DELETE", `/v1/sessions/${id}`).catch(() => null);
                say("dropped");
              }}
            >
              drop made
            </Button>
          </View>
          <Text testID="probe-out" class="text-[12px] text-ink-muted">{`probe:${probe()}`}</Text>
          <Text testID="log" class="text-[12px] text-ink-muted">{`log: ${log().join(" ") || "—"}`}</Text>
        </View>
      </View>

      <If when={menu()}>
        {(m) => (
          <SessionContextMenu
            session={m().session}
            botsById={botsById()}
            isPinned={isPinned(m().session)}
            x={m().x}
            y={m().y}
            onClose={() => menu.set(null)}
            onTogglePin={() => pinned.set(togglePinnedId(pinned(), m().session.id))}
            onViewInfo={() => say(`info:${m().session.id}`)}
            onClearHistory={() => danger.set({ kind: "history", id: m().session.id, busy: false })}
            onToggleArchive={() => void toggleArchive(m().session)}
            onDelete={() => askDelete(m().session)}
            onShowJobView={() => say(`job:${m().session.id}`)}
            onShowMap={m().session.kind === "project" ? () => say(`map:${m().session.id}`) : undefined}
            onOpenProjectDir={() => say(`dir:${m().session.id}`)}
            onOpenProjectTerminal={() => say(`terminal:${m().session.id}`)}
            onRename={() => renaming.set(m().session.id)}
          />
        )}
      </If>
      <If when={danger()}>
        {(d) => (
          <DangerDialog
            copy={dangerCopy(d().kind, copy())}
            busy={d().busy}
            optionChecked={eraseOption()}
            onOptionChange={(v) => eraseOption.set(v)}
            onDismiss={() => danger.set(null)}
            onConfirm={() => void confirmDanger()}
          />
        )}
      </If>
      <ProjectAddMenu
        anchor={plus}
        open={addOpen()}
        onOpenChange={(v) => addOpen.set(v)}
        label={copy().project.add}
        picksFolder={!addPoint()}
        point={addPoint()}
        onNew={(agent) => say(`new:${agent}`)}
        onImport={addPoint() ? undefined : () => say("import")}
        onOpenDir={addPoint() ? () => say("open-dir") : undefined}
        onOpenTerminal={addPoint() ? () => say("open-terminal") : undefined}
      />
    </Scroll>
  );
}
