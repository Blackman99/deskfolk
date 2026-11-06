/**
 * A project session's portrait in the list (`sidebar/AgentAvatar.svelte`, ADR 0095): its agent's
 * tile in a Bot avatar's place and shape, a size smaller (four fifths of the row's avatar), with the
 * run's status dot on its corner where a Bot's avatar carries its own. The box is the avatar's full
 * size, so the text and the row's height stay a Bot's.
 */
import { createMotion, effect, token, View } from "nsh";
import type { ProjectAgent } from "@real-bot/protocol";
import type { SessionStatusResult } from "../../m/sidebar/session-status";
import { AgentLogo } from "../settings/AgentLogo";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";

/** The row's avatar edge: 40 on a desktop, 48 on a phone. */
export const rowAvatarEdge = (): number => (narrowWindow() ? 48 : 40);

const DOT_COLOR: Record<string, string> = {
  running: "brand",
  replying: "brand",
  waiting_approval: "warn",
  waiting_ask: "purple",
  failed: "danger",
  interrupted: "danger",
};

export function AgentAvatar(props: {
  agent: ProjectAgent;
  /** Its tip: the agent's name. */
  title: string;
  status?: SessionStatusResult | null;
  /** The colour the status dot's border is drawn in, the surface the avatar stands on. */
  ringColor?: string;
  /** The avatar's edge when it is not the row's (the pinned strip's). */
  edge?: number;
  testID?: string;
}) {
  const edge = () => props.edge ?? rowAvatarEdge();
  const logo = () => Math.round(edge() * 0.8);
  const shown = () => (props.status && props.status.kind !== "idle" ? props.status : null);
  const pulsing = () => {
    const s = shown();
    return Boolean(s && (s.isBusy || s.kind === "running" || s.kind === "replying"));
  };

  const pulse = createMotion();
  effect(() => {
    if (pulsing()) void pulse.play({ duration: 1000, iterations: "infinite", keyframes: { opacity: [0.35, 1, 0.35], scale: [0.85, 1.15, 0.85] } });
    else pulse.reset();
  });

  return (
    <View
      testID={props.testID ?? "agent-avatar"}
      accessible={false}
      tooltip={tip(props.title)}
      class="relative items-center justify-center shrink-0"
      style={{ width: edge(), height: edge() }}
    >
      <View class="overflow-hidden" style={{ width: logo(), height: logo(), borderRadius: logo() * 0.3 }}>
        <AgentLogo runner={props.agent} size={logo()} />
      </View>
      <If when={shown()}>
        {(s) => (
          <View
            testID="avatar-status-dot"
            class="rounded-full"
            style={{
              position: "absolute",
              right: (edge() - logo()) / 2,
              bottom: (edge() - logo()) / 2,
              width: 9.5,
              height: 9.5,
              borderWidth: 2,
              borderColor: props.ringColor ?? token("sidebar-bg"),
              backgroundColor: s().isBusy ? token("brand") : token((DOT_COLOR[s().kind] ?? "ok") as never),
              opacity: pulsing() ? pulse.opacity : 1,
              transform: pulsing() ? [...pulse.transform] : [],
            }}
          />
        )}
      </If>
    </View>
  );
}
