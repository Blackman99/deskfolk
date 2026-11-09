/**
 * A conversation's header in a workbench pane (`PaneChatBar.svelte`): who it is with and what they are
 * doing, what is waiting on you here, and the conversation's own actions (pin, flow, settings) in
 * reach. The actions are the tab's, the same list its ⋯ and right-click offer, so the two never
 * disagree. The phone keeps its own header (`ChatHeader`).
 */
import { signal, Text, View } from "nsh";
import type { SessionSummary } from "@real-bot/protocol";
import { waitingInSession } from "../../m/chat/waiting";
import { dirDisplay, isLiveRun, projectAgentOf } from "../../m/sidebar/project-groups";
import { classifySession, isFileDropSession, youBotPeer } from "../../m/sidebar/session-groups";
import { botWorkStatus, sidebarStatus } from "../../m/sidebar/session-status";
import { sessionPresence, sessionTitle } from "../../m/sidebar/session-title";
import { copy, runtime } from "../../runtime";
import { Icon, type IconName } from "../Icon";
import { SessionAvatar } from "../SessionAvatar";
import { AgentLogo } from "../settings/AgentLogo";
import { tip } from "../tip";
import { BotElsewhere } from "./BotElsewhere";
import { pulseMotion, rosterLabelsOf, statusFill, statusInk, statusLabelsOf } from "./labels";
import { settled } from "../workbench/drag-settle";
import { onGlassCard } from "../glass";

/** One of the tab's actions. The workbench owns no icons: the host names one of the app's. */
export type PaneBarAction = {
  id: string;
  label: string;
  icon?: IconName;
  /** Already on: pinned, settings open. */
  active?: boolean;
  run: () => void;
};

export function PaneChatBar(props: {
  session: SessionSummary;
  /** The tab's actions: pin, the flow, the conversation's settings. */
  actions: PaneBarAction[];
}) {
  const t = () => copy();
  /** On a glass card (`glass.ts`) this leaves its ground to the card, as `content-glass.css` does. */
  const glassCard = onGlassCard();
  const snapshot = () => runtime.snapshot;
  const botsById = () => new Map(snapshot().bots.map((b) => [b.id, b] as const));
  const roster = () => rosterLabelsOf(t());
  const labels = () => statusLabelsOf(t());
  const kind = () => classifySession(props.session);
  const work = () => sidebarStatus(props.session, snapshot().turns, snapshot().approvals, labels(), snapshot().pendingJudgements);
  const presence = () =>
    sessionPresence(
      props.session,
      botsById(),
      t().common.you,
      kind() === "group" ? t().top.members : kind() === "bot-bot" ? t().top.presenceOpen : "",
      roster(),
    );
  const projectLive = () => kind() === "project" && isLiveRun(snapshot().agentRuns[props.session.id]);
  /** With its reply done it is live only for its background tasks (ADR 0095, 25). */
  const projectAtRest = () => projectLive() && snapshot().agentRuns[props.session.id]?.idle === true;
  const peerId = () => (kind() === "you-bot" ? youBotPeer(props.session) : null);
  const peerModel = () => {
    const id = peerId();
    return id ? (botsById().get(id)?.model ?? null) : null;
  };
  const waiting = () =>
    waitingInSession(snapshot().messages, snapshot().approvals, snapshot().turns, props.session.id, runtime.notificationCapabilities.pending_ask_v1);
  const approvals = () => waiting().filter((w) => w.kind === "approval");
  const asks = () => waiting().filter((w) => w.kind === "ask");
  const settingsAction = () => props.actions.find((a) => a.id === "settings");
  const botStatusOf = (botId: string) => botWorkStatus(botId, snapshot().turns, snapshot().approvals, labels(), snapshot().pendingJudgements);
  const jump = (id: string) => void runtime.setHighlightedMessage(id, props.session.id);

  /** A narrow pane keeps the pills and the icons; the words go first (560), then the pills' words (420). */
  const width = signal(1000);
  const roomy = settled(() => width() > 560);
  const wide = settled(() => width() > 420);
  const pulse = pulseMotion(() => true, 1800);
  const Pulse = (p: { fill: string }) => <View accessible={false} class={`w-[6px] h-[6px] rounded-full ${p.fill}`} style={{ opacity: pulse.opacity }} />;

  const pill = (id: "approval" | "ask", icon: IconName, label: string, to: string) => (
    <View
      role="button"
      testID={`bar-pill-${id}`}
      accessibilityLabel={label}
      onPress={() => jump(to)}
      class={`cursor-pointer select-none flex-row items-center h-[26px] rounded-full active:scale-[0.97] border ${wide() ? "gap-[5px] pl-[8px] pr-[10px]" : "px-[8px]"} ${
        id === "approval" ? "bg-warn-bg border-warn-line hover:border-warn" : "bg-purple-bg border-purple-line hover:border-purple"
      }`}
    >
      <Icon name={icon} size={12} class={id === "approval" ? "tint-warn-text" : "tint-purple-text"} />
      <If when={wide()}>
        <Text class={`text-[12px] font-semibold ${id === "approval" ? "text-warn-text" : "text-purple-text"}`}>{label}</Text>
      </If>
    </View>
  );

  return (
    <If when={!isFileDropSession(props.session)}>
      <View
        testID="pane-chat-bar"
        role="header"
        onLayout={(e) => width.set(e.bounds.size.width)}
        class={`flex-row items-center shrink-0 gap-[10px] min-h-[52px] pl-[12px] pr-[8px] py-[6px] ${glassCard() ? "" : "bg-pane"} border-b border-line-subtle`}
      >
        <View
          role="button"
          testID="bar-identity"
          accessibilityLabel={settingsAction()?.label}
          tooltip={tip(settingsAction()?.label ?? "")}
          disabled={!settingsAction()}
          onPress={() => settingsAction()?.run()}
          class={`cursor-pointer select-none disabled:cursor-default flex-row items-center gap-[10px] min-w-0 shrink pl-[4px] pr-[10px] py-[4px] rounded-(--radius-md) ${
            settingsAction()?.active ? "bg-row-hover" : "hover:bg-row-hover"
          }`}
        >
          <If
            when={kind() === "project"}
            else={<SessionAvatar session={props.session} bots={botsById()} size="top" botStatus={botStatusOf} />}
          >
            <View accessible={false} class="shrink-0 overflow-hidden" style={{ borderRadius: 10 }}>
              <AgentLogo runner={projectAgentOf(props.session)} size={32} />
            </View>
          </If>
          <View class="min-w-0 shrink gap-[1px]">
            <Text role="header" testID="bar-title" class="text-[15px] font-semibold text-ink line-clamp-1">
              {sessionTitle(props.session, botsById(), roster())}
            </Text>
            <View class="flex-row items-center gap-[8px] min-w-0 overflow-hidden">
              <If when={projectLive()}>
                <View testID="bar-status-live" class="flex-row items-center gap-[5px]">
                  <Pulse fill="bg-brand" />
                  <Text class="text-[12px] font-semibold text-brand">{projectAtRest() ? t().sidebar.statusBackground : t().project.live}</Text>
                </View>
              </If>
              <If when={work().kind !== "idle"}>
                <View testID="bar-status" class="flex-row items-center gap-[5px]">
                  <If when={work().isBusy}>
                    <Pulse fill={statusFill(work().kind)} />
                  </If>
                  <Text class={`text-[12px] font-semibold ${statusInk(work().kind)}`}>{work().label}</Text>
                </View>
              </If>
              <If when={roomy()}>
                <If
                  when={peerModel()}
                  else={
                    <If
                      when={kind() === "project"}
                      else={
                        /* A direct's presence is "you ↔ the Bot", which the title already says. */
                        <If when={presence() && kind() !== "you-bot"}>
                          <Text testID="bar-presence" class="text-[12px] text-ink-muted line-clamp-1">{presence()}</Text>
                        </If>
                      }
                    >
                      <View tooltip={tip(props.session.project_dir ?? "")} class="min-w-0 shrink">
                        <Text testID="bar-presence" class="text-[12px] text-ink-muted line-clamp-1">
                          {`${t().project.agentNames[projectAgentOf(props.session)]} · ${dirDisplay(props.session.project_dir)}`}
                        </Text>
                      </View>
                    </If>
                  }
                >
                  {(model) => (
                    <View tooltip={tip(model())} class="px-[6px] rounded-(--radius-xs) bg-chip min-w-0 shrink" style={{ height: 18, justifyContent: "center" }}>
                      <Text testID="bar-model" class="font-mono text-[11px] text-ink-secondary line-clamp-1">{model()}</Text>
                    </View>
                  )}
                </If>
              </If>
            </View>
          </View>
        </View>

        <If when={peerId()}>{(id) => <BotElsewhere botId={id()} here={props.session} />}</If>

        <If when={approvals().length > 0 || asks().length > 0}>
          <View testID="bar-waiting" class="flex-row items-center gap-[6px] shrink-0">
            <If when={approvals().length > 0}>
              {pill("approval", "shield-check", t().stream.waitingJump.approvals(approvals().length), approvals()[0]!.id)}
            </If>
            <If when={asks().length > 0}>{pill("ask", "help-circle", t().stream.waitingJump.asks(asks().length), asks()[0]!.id)}</If>
          </View>
        </If>

        <View class="flex-row items-center gap-[2px] ml-auto shrink-0">
          <Each of={props.actions} key={(a) => a.id}>
            {(action) => (
              <View
                role="button"
                testID={`bar-action-${action().id}`}
                accessibilityLabel={action().label}
                accessibilityState={action().id === "pin" ? { selected: Boolean(action().active) } : undefined}
                tooltip={tip(action().label)}
                onPress={() => action().run()}
                class={`cursor-pointer select-none group flex-row items-center justify-center gap-[6px] min-w-[32px] h-[32px] px-[8px] rounded-[8px] active:scale-[0.94] ${
                  action().active ? "bg-accent-tint" : "hover:bg-row-hover"
                }`}
              >
                <If when={action().icon}>
                  {(icon) => <Icon name={icon()} size={16} class={action().active ? "tint-brand" : "tint-ink-muted group-hover:tint-ink"} />}
                </If>
                <If when={roomy() && (action().id === "trace" || action().id === "map")}>
                  <Text class={`text-[13px] font-semibold ${action().active ? "text-brand" : "text-ink-muted group-hover:text-ink"}`}>{action().label}</Text>
                </If>
              </View>
            )}
          </Each>
        </View>
      </View>
    </If>
  );
}
