/**
 * A conversation's tab, which is also its header (`ChatTabLabel.svelte`): the avatar and its status
 * dot sit before the name, and the header's second line is the tooltip; a project session's avatar is
 * its agent's mark.
 */
import { Text, token, View } from "nsh";
import type { SessionSummary } from "@real-bot/protocol";
import { dirDisplay, isLiveRun, projectAgentOf } from "../../m/sidebar/project-groups";
import { classifySession, isFileDropSession, youBotPeer } from "../../m/sidebar/session-groups";
import { botWorkStatus, sidebarStatus } from "../../m/sidebar/session-status";
import { sessionPresence } from "../../m/sidebar/session-title";
import { copy, runtime } from "../../runtime";
import { Icon } from "../Icon";
import { SessionAvatar } from "../SessionAvatar";
import { AgentLogo } from "../settings/AgentLogo";
import { tip } from "../tip";
import { pulseMotion, rosterLabelsOf, statusLabelsOf } from "./labels";

export function ChatTabLabel(props: {
  session: SessionSummary;
  /** The tab's name, the same words the rest of the workbench uses for this conversation. */
  title: string;
  /** The tab's own surface: the dot and the stacked faces are ringed in it, so they read as cut out. */
  ringColor?: string;
}) {
  const t = () => copy();
  const snapshot = () => runtime.snapshot;
  const botsById = () => new Map(snapshot().bots.map((b) => [b.id, b] as const));
  const kind = () => classifySession(props.session);
  const fileDrop = () => isFileDropSession(props.session);
  const peerBot = () => {
    const peer = youBotPeer(props.session);
    return peer ? (botsById().get(peer) ?? null) : null;
  };
  const work = () => sidebarStatus(props.session, snapshot().turns, snapshot().approvals, statusLabelsOf(t()), snapshot().pendingJudgements);
  const botStatusOf = (botId: string) =>
    botWorkStatus(botId, snapshot().turns, snapshot().approvals, statusLabelsOf(t()), snapshot().pendingJudgements);
  const archived = () => (props.session.archived_at || peerBot()?.archived_at ? ` · ${t().top.archived}` : "");
  /** What the header's second line says, so a folded header loses nothing. */
  const detail = () => {
    const session = props.session;
    if (fileDrop()) return t().sidebar.fileDropHint;
    if (kind() === "project") return dirDisplay(session.project_dir);
    if (kind() === "you-bot" && peerBot()) {
      const status = work().kind !== "idle" ? work().label : t().chat.online;
      return peerBot()!.model ? `${status} · ${peerBot()!.model}` : status;
    }
    const prefix = kind() === "group" ? t().top.members : kind() === "bot-bot" ? t().top.presenceOpen : "";
    return sessionPresence(session, botsById(), t().common.you, prefix, rosterLabelsOf(t()));
  };
  const ring = () => props.ringColor ?? token("pane");
  const dot = pulseMotion(() => true, 1000);
  const Dot = () => (
    <View
      testID="tab-status-dot"
      accessible={false}
      class="absolute rounded-full bg-brand"
      style={{ right: 0, bottom: 0, width: 7, height: 7, borderWidth: 1.5, borderColor: ring(), opacity: dot.opacity, zIndex: 5 }}
    />
  );

  return (
    <View testID="chat-tab" tooltip={tip(`${props.title}${archived()}\n${detail()}`)} class="flex-row items-center gap-[6px] min-w-0 max-w-full">
      <View accessible={false} class="relative shrink-0 items-center justify-center w-[20px] h-[20px]">
        <If
          when={fileDrop()}
          else={
            <If
              when={kind() === "project"}
              else={
                <If
                  when={kind() === "you-bot" ? peerBot() : null}
                  else={
                    <>
                      <SessionAvatar session={props.session} bots={botsById()} size="tab" ringColor={ring()} />
                      <If when={work().isBusy}>
                        <Dot />
                      </If>
                    </>
                  }
                >
                  {/* The Bot's own dot, the way the header draws it: what that Bot is doing anywhere. */}
                  <SessionAvatar session={props.session} bots={botsById()} size="tab" ringColor={ring()} botStatus={botStatusOf} />
                </If>
              }
            >
              <View class="w-[20px] h-[20px] overflow-hidden" style={{ borderRadius: 6 }}>
                <AgentLogo runner={projectAgentOf(props.session)} size={20} />
              </View>
              <If when={isLiveRun(snapshot().agentRuns[props.session.id])}>
                <Dot />
              </If>
            </If>
          }
        >
          <View testID="tab-file-mark" class="w-[20px] h-[20px] rounded-full bg-accent-tint items-center justify-center">
            <Icon name="file" size={12} class="tint-brand" />
          </View>
        </If>
      </View>
      {/* The idle ink a tab that is not shown reads in (`.wb-tab-button`); the shown tab's in full ink, as `PaneTabLabel`'s. */}
      <Text testID="chat-tab-name" class="min-w-0 shrink line-clamp-1 text-[12px] text-tab-idle-ink group-selected:text-ink">
        {props.title}
      </Text>
    </View>
  );
}
