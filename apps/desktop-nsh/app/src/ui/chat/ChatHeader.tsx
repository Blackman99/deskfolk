/**
 * The bar above a conversation (`ChatHeader.svelte`): the avatar, the title and, under it, who is in
 * it and the Bot's status; the actions (pin, the flow, the conversation's settings) and, on a phone, the
 * back arrow and a ⋯ that folds the actions into a sheet. A Bot at work elsewhere is said on a row of
 * its own under the name. With no conversation it asks you to pick one, and offers the setup guide
 * and a way to make the first Bot.
 */
import { signal, Text, token, View } from "nsh";
import type { SessionSummary } from "@real-bot/protocol";
import { folkMotion } from "../../m/folk-motion";
import { isSessionPinned } from "../../m/sidebar/pinned-sessions";
import { dirDisplay, projectAgentOf } from "../../m/sidebar/project-groups";
import { classifySession, isFileDropSession, youBotPeer } from "../../m/sidebar/session-groups";
import { botWorkStatus, isWorkingStatus, sidebarStatus } from "../../m/sidebar/session-status";
import { sessionPresence, sessionTitle } from "../../m/sidebar/session-title";
import { copy, runtime } from "../../runtime";
import { BottomSheet, SheetItem } from "../BottomSheet";
import { Icon, type IconName } from "../Icon";
import { narrowWindow } from "../Modal";
import { SessionAvatar } from "../SessionAvatar";
import { AgentLogo } from "../settings/AgentLogo";
import { tip } from "../tip";
import { BotElsewhere, elsewhereState } from "./BotElsewhere";
import { BotFace } from "./BotFace";
import { pulseMotion, rosterLabelsOf, statusColor, statusLabelsOf } from "./labels";

export function ChatHeader(props: {
  selected: SessionSummary | null;
  pinnedSessionIds: string[];
  onTogglePin: (sessionId: string) => void;
  onToggleSessionSettings: () => void;
  /**
   * Whether the conversation's settings are open. Left out, the runtime's flag answers for the
   * narrow shell's drawer; a workbench pane says its own, because its sidebar is in its tab.
   */
  settingsOpen?: boolean;
  onCreateBot: () => void;
  onShowOnboarding: () => void;
}) {
  const t = () => copy();
  const settingsOpen = () => props.settingsOpen ?? runtime.sessionSettingsOpen;
  const snapshot = () => runtime.snapshot;
  const botsById = () => new Map(snapshot().bots.map((b) => [b.id, b] as const));
  const visibleBots = () => snapshot().bots.filter((b) => !b.archived_at);
  const roster = () => rosterLabelsOf(t());
  const labels = () => statusLabelsOf(t());
  const kind = () => (props.selected ? classifySession(props.selected) : null);
  const peerBot = () => {
    const peer = props.selected ? youBotPeer(props.selected) : null;
    return peer ? (botsById().get(peer) ?? null) : null;
  };
  const settingsLabel = () => (kind() === "group" ? t().top.groupSettings : t().top.botSettings);
  const fileDrop = () => (props.selected ? isFileDropSession(props.selected) : false);
  /** A project session (ADR 0095): no Bot to open settings on, no flow; pinning it is on its sidebar row. */
  const project = () => (props.selected?.kind === "project" ? props.selected : null);
  const work = () =>
    props.selected ? sidebarStatus(props.selected, snapshot().turns, snapshot().approvals, labels(), snapshot().pendingJudgements) : null;
  const botStatusOf = (botId: string) => botWorkStatus(botId, snapshot().turns, snapshot().approvals, labels(), snapshot().pendingJudgements);
  /**
   * What the line under a direct's name says: how it stands here, or, quiet here while its Bot works
   * elsewhere, the Bot's own state, as its face shows it. The row under the header says where.
   */
  const directStatus = () => {
    const w = work();
    if (w && w.kind !== "idle") return w;
    const bot = peerBot();
    if (!bot || bot.archived_at) return null;
    const peer = botStatusOf(bot.id);
    return isWorkingStatus(peer.kind) ? peer : null;
  };
  const titleOf = (session: SessionSummary) => sessionTitle(session, botsById(), roster());
  const archivedSuffix = (session: SessionSummary) => {
    if (session.archived_at) return ` · ${t().top.archived}`;
    const peer = youBotPeer(session);
    return peer && botsById().get(peer)?.archived_at ? ` · ${t().top.archived}` : "";
  };
  const pinned = () => (props.selected ? isSessionPinned(props.pinnedSessionIds, props.selected.id) : false);
  const traceToggle = () => (runtime.traceOpen ? runtime.closeTrace() : runtime.openTrace(null));
  const narrow = () => narrowWindow();
  const mobileActionsOpen = signal(false);
  const run = (action: () => void) => {
    mobileActionsOpen.set(false);
    action();
  };
  const pulse = pulseMotion(() => true, 1000);
  const elsewhere = elsewhereState(() => peerBot()?.id ?? "", () => props.selected!);
  const hasElsewhere = () => Boolean(props.selected && kind() === "you-bot" && peerBot() && elsewhere.line());

  const TITLE = "text-ink";
  const title = (text: string, testID = "top-title") => (
    <Text role="header" testID={testID} class={`${TITLE} ${narrow() ? "text-[16px] font-semibold" : "text-[15px] font-bold"} line-clamp-1`}>
      {text}
    </Text>
  );
  const subline = (children: unknown) => <View class={`flex-row items-center min-w-0 overflow-hidden ${narrow() ? "gap-[8px]" : "gap-[6px]"}`}>{children as never}</View>;

  const topAction = (opts: { testID: string; icon: IconName; label: string; tip: string; active: boolean; onPress: () => void; expanded?: boolean }) => (
    <View
      role="button"
      testID={opts.testID}
      accessibilityLabel={opts.tip}
      accessibilityState={{ selected: opts.active, expanded: opts.expanded }}
      tooltip={tip(opts.tip)}
      onPress={opts.onPress}
      class={`group flex-row items-center gap-[5px] px-[10px] py-[5px] rounded-(--radius-sm) border ${
        opts.active ? "bg-accent-tint border-accent-border" : "bg-btn-secondary-bg border-line hover:bg-line-subtle hover:border-line-hover"
      }`}
    >
      <Icon name={opts.icon} size={16} class={opts.active ? "tint-brand" : "tint-ink-secondary group-hover:tint-brand"} />
      <Text class={`text-[12px] font-medium whitespace-nowrap ${opts.active ? "text-brand" : "text-ink-secondary group-hover:text-brand"}`}>{opts.label}</Text>
    </View>
  );

  const identityBody = () => (
    <>
      <If
        when={kind() === "you-bot" ? peerBot() : null}
        else={
          <View accessible={false} class="relative shrink-0" style={{ width: 36, height: 36 }}>
            <SessionAvatar session={props.selected!} bots={botsById()} size="top" botStatus={botStatusOf} ringColor={token("pane")} />
            <If when={Boolean(work()?.isBusy)}>
              <View
                testID="top-status-dot"
                class="absolute rounded-full bg-brand"
                style={{ right: 0, bottom: 0, width: 9, height: 9, borderWidth: 2, borderColor: token("pane"), opacity: pulse.opacity }}
              />
            </If>
          </View>
        }
      >
        {(bot) => {
          const status = () => botStatusOf(bot().id);
          return (
            <View accessible={false} class="relative shrink-0" style={{ width: 36, height: 36 }}>
              <BotFace
                id={bot().id}
                name={bot().name}
                avatar={bot().avatar}
                size={36}
                border={1.5}
                letterSize={14}
                motion={bot().archived_at ? "idle" : folkMotion(status().kind)}
              />
              <If when={!bot().archived_at && status().kind !== "idle"}>
                <View
                  testID="top-status-dot"
                  tooltip={tip(`${bot().name}: ${status().label}`)}
                  class="absolute rounded-full"
                  style={{
                    right: 0,
                    bottom: 0,
                    width: 9,
                    height: 9,
                    borderWidth: 2,
                    borderColor: token("pane"),
                    backgroundColor: statusColor(status().kind),
                    opacity: status().isBusy ? pulse.opacity : 1,
                  }}
                />
              </If>
            </View>
          );
        }}
      </If>
      <View class="flex-1 min-w-0 gap-[3px]">
        {title(`${titleOf(props.selected!)}${archivedSuffix(props.selected!)}`)}
        {subline(
          <>
            <If when={kind() === "you-bot" ? peerBot() : null}>
              {(bot) => (
                <>
                  <View testID="top-status" class="flex-row items-center gap-[6px] shrink-0">
                    <If when={!narrow()}>
                      <View
                        class={`w-[6px] h-[6px] rounded-full ${directStatus()?.isBusy ? "bg-brand" : "bg-ok"}`}
                        style={{ opacity: directStatus()?.isBusy ? pulse.opacity : 1 }}
                        accessible={false}
                      />
                    </If>
                    <Text class={`text-[12px] text-ink-muted ${narrow() ? "" : "font-medium"}`}>{directStatus()?.label ?? t().chat.online}</Text>
                  </View>
                  <If when={bot().model}>
                    {(model) =>
                      narrow() ? (
                        <Text testID="top-model" class="min-w-0 shrink text-[12px] text-ink-muted line-clamp-1">{model()}</Text>
                      ) : (
                        <View tooltip={tip(model())} class="px-[6px] py-[1px] rounded-(--radius-xs) bg-chip border border-line min-w-0 shrink">
                          <Text testID="top-model" class="font-mono text-[10px] text-ink-muted line-clamp-1">{model()}</Text>
                        </View>
                      )
                    }
                  </If>
                </>
              )}
            </If>
            <If when={!(narrow() && kind() === "you-bot")}>
              <Text testID="top-presence" class="min-w-0 shrink text-[12px] font-medium text-ink-muted line-clamp-1">
                {sessionPresence(
                  props.selected!,
                  botsById(),
                  t().common.you,
                  kind() === "group" ? t().top.members : kind() === "bot-bot" ? t().top.presenceOpen : "",
                  roster(),
                )}
              </Text>
            </If>
          </>,
        )}
      </View>
    </>
  );

  /** The file conversation and a project session have no Bot to open settings on: their identity is not a button. */
  const plainIdentity = (mark: unknown, name: string, hint: string, hintTip?: string, testID = "top-file-identity") => (
    <View testID={testID} class={`flex-row items-center flex-1 min-w-0 ${narrow() ? "gap-[10px] px-[6px] py-[8px]" : "gap-[12px] py-[4px]"}`}>
      {mark as never}
      <View class="flex-1 min-w-0 gap-[3px]">
        {title(name)}
        <View tooltip={hintTip ? tip(hintTip) : undefined} class="min-w-0">
          <Text testID="top-meta" class="text-[12px] font-medium text-ink-muted line-clamp-1">{hint}</Text>
        </View>
      </View>
    </View>
  );

  return (
    <View
      testID="chat-header"
      role="header"
      class={`flex-row flex-wrap items-center justify-between bg-glass-header border-b border-line ${
        props.selected && narrow() ? "pl-[10px] min-h-[64px] items-stretch gap-0" : "px-[20px] py-[10px] min-h-[58px] gap-[12px]"
      }`}
    >
      <If
        when={props.selected}
        else={
          <>
            <Text role="header" class="text-[15px] font-bold text-ink">{t().top.pickSession}</Text>
            <If when={!snapshot().settings.wizard_complete}>
              <View
                role="button"
                testID="setup-guide-pill"
                onPress={() => props.onShowOnboarding()}
                class="px-[12px] py-[4px] rounded-full bg-warn-bg border border-warn-line hover:border-warn"
              >
                <Text class="text-[12px] font-semibold text-warn-text">{t().onboarding.reopenGuide}</Text>
              </View>
            </If>
            <If when={visibleBots().length === 0}>
              <View role="button" testID="empty-roster" onPress={() => props.onCreateBot()} class="ml-auto group">
                <Text class="text-[13px] text-ink-muted underline group-hover:text-brand">{t().top.emptyRoster}</Text>
              </View>
            </If>
          </>
        }
      >
        {(selected) => (
          <>
            <View class={`flex-row flex-1 min-w-0 items-center ${narrow() ? "gap-0 items-stretch" : "gap-[12px]"}`}>
              <If when={narrow()}>
                <View
                  role="button"
                  testID="top-back"
                  accessibilityLabel={t().sidebar.backToSessions}
                  tooltip={tip(t().sidebar.backToSessions)}
                  onPress={() => (runtime.selectedId = null)}
                  class="items-center justify-center shrink-0 w-[48px] min-h-[64px] active:bg-line-subtle hover:bg-line-subtle"
                >
                  <Icon name="chevron-left" size={20} class="tint-ink-secondary" />
                </View>
              </If>
              <If
                when={fileDrop()}
                else={
                  <If
                    when={project()}
                    else={
                      <View
                        role="button"
                        testID="top-identity"
                        accessibilityLabel={settingsLabel()}
                        accessibilityState={{ expanded: settingsOpen() }}
                        tooltip={tip(settingsLabel())}
                        onPress={() => props.onToggleSessionSettings()}
                        class={`flex-row items-center flex-1 min-w-0 ${narrow() ? "gap-[10px] px-[6px] py-[8px]" : "gap-[12px] px-[8px] py-[4px] -m-[4px] rounded-(--radius-md)"} ${
                          settingsOpen() ? "bg-line-subtle" : "hover:bg-line-subtle"
                        }`}
                      >
                        {identityBody()}
                      </View>
                    }
                  >
                    {(session) =>
                      plainIdentity(
                        <View accessible={false} class="shrink-0 overflow-hidden" style={{ borderRadius: 11 }}>
                          <AgentLogo runner={projectAgentOf(session())} size={36} />
                        </View>,
                        `${titleOf(session())}${archivedSuffix(session())}`,
                        `${t().project.agentNames[projectAgentOf(session())]} · ${dirDisplay(session().project_dir)}`,
                        session().project_dir ?? undefined,
                        "top-project-identity",
                      )
                    }
                  </If>
                }
              >
                {plainIdentity(
                  <View
                    testID="top-file-mark"
                    accessible={false}
                    class="shrink-0 items-center justify-center rounded-(--radius-md) bg-accent-tint"
                    style={{ width: 36, height: 36 }}
                  >
                    <Icon name="file" size={20} class="tint-brand" />
                  </View>,
                  t().sidebar.fileDrop,
                  t().sidebar.fileDropHint,
                )}
              </If>
            </View>

            <If when={!fileDrop() && !project() && !narrow()}>
              <View testID="top-actions" class="flex-row items-center gap-[8px] shrink-0">
                {topAction({
                  testID: "top-pin",
                  icon: "pin",
                  label: pinned() ? t().top.pinned : t().top.pin,
                  tip: pinned() ? t().top.unpin : t().top.pin,
                  active: pinned(),
                  onPress: () => props.onTogglePin(selected().id),
                })}
                {topAction({ testID: "top-trace", icon: "hierarchy", label: t().trace.topAction, tip: t().trace.title, active: runtime.traceOpen, onPress: traceToggle })}
                {topAction({
                  testID: "top-settings",
                  icon: "settings",
                  label: settingsLabel(),
                  tip: settingsLabel(),
                  active: settingsOpen(),
                  expanded: settingsOpen(),
                  onPress: () => props.onToggleSessionSettings(),
                })}
              </View>
            </If>

            <If when={!fileDrop() && !project() && narrow()}>
              <View class="shrink-0">
                <View
                  role="button"
                  testID="top-more"
                  accessibilityLabel={t().top.moreActions}
                  accessibilityState={{ expanded: mobileActionsOpen() }}
                  tooltip={tip(t().top.moreActions)}
                  onPress={() => mobileActionsOpen.set(!mobileActionsOpen())}
                  class={`items-center justify-center w-[48px] min-h-[64px] h-full ${
                    mobileActionsOpen() || runtime.traceOpen || settingsOpen() || pinned() ? "bg-line-subtle" : ""
                  }`}
                >
                  <Icon name="more" size={20} class={mobileActionsOpen() || runtime.traceOpen || settingsOpen() || pinned() ? "tint-brand" : "tint-ink-secondary"} />
                </View>
                {/* The button is there only on a phone's header, so its menu is always a sheet from the bottom. */}
                <If when={mobileActionsOpen()}>
                  <BottomSheet title={t().top.moreActions} closeLabel={t().common.close} onClose={() => mobileActionsOpen.set(false)}>
                    <View role="menu" accessibilityLabel={t().top.moreActions} testID="mobile-actions-menu">
                      <SheetItem
                        role="menuitem"
                        testID="mobile-pin"
                        icon="pin"
                        label={pinned() ? t().top.unpin : t().top.pin}
                        active={pinned()}
                        onPress={() => run(() => props.onTogglePin(selected().id))}
                      />
                      <SheetItem role="menuitem" testID="mobile-trace" icon="hierarchy" label={t().trace.topAction} active={runtime.traceOpen} onPress={() => run(traceToggle)} />
                      <SheetItem
                        role="menuitem"
                        testID="mobile-settings"
                        icon="settings"
                        label={settingsLabel()}
                        active={settingsOpen()}
                        onPress={() => run(() => props.onToggleSessionSettings())}
                      />
                    </View>
                  </BottomSheet>
                </If>
              </View>
            </If>
          </>
        )}
      </If>
      {/* A row of its own under the name and the actions: beside them a phone has no room. */}
      <If when={hasElsewhere()}>
        <View testID="top-elsewhere" class={`w-full ${narrow() ? "pl-[54px] pr-[12px] pb-[10px]" : ""}`}>
          <BotElsewhere botId={peerBot()!.id} here={props.selected!} />
        </View>
      </If>
    </View>
  );
}
