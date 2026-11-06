/**
 * A conversation's settings drawer: a Bot's profile pane (tabs), a group's pane, and the drawer
 * around them, in the two places the shell mounts it, beside a workbench pane (`beside`) and as the
 * drawer over the window (and the page on a phone). The story is the shell: it holds the group
 * draft, which section a phone shows and a stand-in for the danger confirm (it writes down what was
 * armed), and reads the daemon back through buttons (the test host has no network of its own).
 *
 * `mode-<place>-<what>` picks what is mounted: `beside` / `drawer`, and `writer` (the Bot's direct),
 * `group` (周报小组) or `nested` (Writer opened from the group, drawer only).
 */
import { Scroll, Text, View, computed, effect, signal, untracked } from "nsh";
import type { Bot, SessionSummary } from "@real-bot/protocol";
import type { ShellDangerConfirm } from "../src/m/overlays/danger-confirm.svelte";
import type { GroupDetailDraft } from "../src/m/panels/group-edit";
import { classifySession, presentBotIds } from "../src/m/sidebar/session-groups";
import { copy, runtime } from "../src/runtime";
import { Button } from "../src/ui/Button";
import { narrowWindow } from "../src/ui/Modal";
import { SessionSettingsDrawer } from "../src/ui/panels/SessionSettingsDrawer";

type Mode = "beside-writer" | "beside-group" | "drawer-writer" | "drawer-group" | "drawer-nested";
const MODES: Mode[] = ["beside-writer", "beside-group", "drawer-writer", "drawer-group", "drawer-nested"];

export default function PanelsC() {
  const mode = signal<Mode | null>(null);
  const log = signal("—");
  const probe = signal("");
  const profileFailed = signal(false);
  const paneMobileDetail = signal(false);
  const detail = signal<GroupDetailDraft>({ sessionId: null, name: "", nameError: undefined, failed: false, pullPick: "" });
  const nested = signal<string | null>(null);

  const writer = computed<Bot | null>(() => runtime.snapshot.bots.find((b) => b.name === "Writer") ?? null);
  const direct = computed<SessionSummary | null>(() => {
    const w = writer();
    return w ? (runtime.snapshot.sessions.find((s) => classifySession(s) === "you-bot" && presentBotIds(s).includes(w.id)) ?? null) : null;
  });
  // Found by its name once, then by its id: the story renames it.
  let groupId: string | null = null;
  const group = computed<SessionSummary | null>(() => {
    const rows = runtime.snapshot.sessions;
    const row = groupId ? rows.find((s) => s.id === groupId) : rows.find((s) => s.kind === "group" && s.name === "周报小组");
    if (row && !groupId) groupId = row.id;
    return row ?? null;
  });
  const sessionsById = () => new Map(runtime.snapshot.sessions.map((s) => [s.id, s] as const));
  const botsById = () => new Map(runtime.snapshot.bots.map((b) => [b.id, b] as const));

  const placed = () => {
    const m = mode();
    return m?.endsWith("group") || m?.endsWith("nested") ? group() : m ? direct() : null;
  };

  // The shell resets the draft on every session change.
  effect(() => {
    const session = placed();
    if (!session) return;
    if (untracked(detail).sessionId === session.id) return;
    detail.set({ sessionId: session.id, name: session.kind === "group" ? (session.name ?? "") : "", nameError: undefined, failed: false, pullPick: "" });
  });

  /** The shell's danger confirm, as far as the drawer uses it: the story writes down what was armed. */
  const armed = signal("");
  const danger = {
    get dangerConfirm() {
      return null;
    },
    set dangerConfirm(value: { kind: string } | null) {
      armed.set(value ? value.kind : "");
    },
    get drawerHasDanger() {
      return armed() !== "";
    },
    clearDanger: (...kinds: string[]) => log.set(`danger-cleared:${kinds.join(",")}`),
    dismissDangerConfirm: () => armed.set(""),
    openDeleteBotConfirm: (id?: string) => log.set(`delete-bot${id ? `:${id === writer()?.id ? "writer" : id}` : ""}`),
    openDeleteGroupConfirm: (id?: string) => log.set(`delete-group${id ? ":" + (id === group()?.id ? "group" : id) : ""}`),
    openClearHistoryConfirm: (id?: string) => log.set(`clear-history${id ? ":" + (id === direct()?.id ? "direct" : id === group()?.id ? "group" : id) : ""}`),
  };

  const open = (next: Mode) => {
    paneMobileDetail.set(false);
    profileFailed.set(false);
    nested.set(next === "drawer-nested" ? (writer()?.id ?? null) : null);
    mode.set(next);
    const m = next.endsWith("group") || next.endsWith("nested") ? group() : direct();
    if (m) void runtime.selectSession(m.id);
    if (next.startsWith("drawer")) runtime.sessionSettingsOpen = true;
  };
  const closeDrawer = () => {
    runtime.closeSessionSettings();
    nested.set(null);
  };
  effect(() => {
    // The shell closes the drawer by clearing the flag; the story follows it.
    if (!runtime.sessionSettingsOpen && untracked(mode)?.startsWith("drawer")) mode.set(null);
  });

  const drawerOn = () => mode()?.startsWith("drawer") === true;
  const profileBot = () => {
    const m = mode();
    if (m === "drawer-writer") return writer();
    if (m === "drawer-nested") return nested() ? writer() : null;
    return null;
  };
  const narrow = () => narrowWindow();

  // What the daemon holds, read from here.
  const readDaemon = async (name: string, read: (get: <T>(path: string) => Promise<T>) => Promise<string>) => {
    probe.set("");
    const client = runtime.client;
    if (!client) return probe.set(`${name}:no client`);
    probe.set(`${name}:${await read((path) => client.get(path))}`);
  };
  const probeBot = () =>
    readDaemon("bot", async (get) => {
      const row = (await get<{ items: Bot[] }>("/v1/bots")).items.find((b) => b.id === writer()?.id);
      return row ? `${row.name}|${row.duties}|${row.archived_at ? "archived" : "active"}` : "missing";
    });
  const probeGroup = () =>
    readDaemon("group", async (get) => {
      const row = (await get<{ items: SessionSummary[] }>("/v1/sessions")).items.find((s) => s.id === group()?.id);
      return row ? `${row.name}|${row.archived_at ? "archived" : "active"}|${presentBotIds(row).length}` : "missing";
    });

  return (
    <View class="flex-1 bg-bg">
      <Scroll class="shrink-0 max-h-[120px]">
        <View class="flex-row flex-wrap gap-2 p-3">
          {MODES.map((m) => (
            <Button testID={`mode-${m}`} size="sm" onPress={() => open(m)}>{m}</Button>
          ))}
          <Button testID="tool-probe-bot" size="sm" onPress={() => void probeBot()}>bot?</Button>
          <Button testID="tool-probe-group" size="sm" onPress={() => void probeGroup()}>group?</Button>
          <Button testID="tool-unarchive-group" size="sm" onPress={() => void runtime.restoreSession(group()?.id ?? "")}>unarchive</Button>
        </View>
        <Text testID="probe" class="text-[12px] text-ink-muted px-3">{probe()}</Text>
        <Text testID="panels-c-log" class="text-[12px] text-ink-muted px-3 pb-2">{`log=${log()} armed=${armed()}`}</Text>
      </Scroll>
      <View class="flex-1 min-h-0">
        <If when={mode()?.startsWith("beside") && placed() ? placed() : null}>
          {(session) => <Mount beside={{ sessionId: session().id, botId: null }} />}
        </If>
        <If when={drawerOn()}>
          <Mount beside={null} />
        </If>
      </View>
    </View>
  );

  function Mount(mount: { beside: { sessionId: string; botId: string | null } | null }) {
    return (
      <SessionSettingsDrawer
        beside={mount.beside}
        narrow={narrow()}
        botsById={botsById()}
        sessionsById={sessionsById()}
        danger={danger as unknown as ShellDangerConfirm}
        openProfile={(botId) => {
          log.set(`open-profile:${botId === writer()?.id ? "writer" : botId}`);
          if (drawerOn()) nested.set(botId);
        }}
        closePaneSide={() => mode.set(null)}
        selected={placed()}
        selectedKind={placed() ? classifySession(placed()!) : null}
        nestedProfile={nested() !== null && mode() === "drawer-nested"}
        profileBot={profileBot()}
        closeNestedProfile={() => {
          nested.set(null);
          paneMobileDetail.set(false);
        }}
        closeCurrentDrawerScreen={() => {
          if (nested() && narrow()) return closeDrawer();
          if (paneMobileDetail()) return paneMobileDetail.set(false);
          if (nested()) return nested.set(null);
          closeDrawer();
        }}
        profileFailed={profileFailed()}
        onProfileFailedChange={(value) => profileFailed.set(value)}
        paneMobileDetail={paneMobileDetail()}
        onPaneMobileDetailChange={(value) => paneMobileDetail.set(value)}
        groupDetail={detail()}
        onGroupDetailChange={(value) => detail.set(value)}
      />
    );
  }
}
