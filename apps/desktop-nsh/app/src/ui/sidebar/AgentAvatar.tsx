/**
 * A project session's portrait in the list (`sidebar/AgentAvatar.svelte`, ADR 0095):
 * - In compact desktop rows (`compact`): a bare 16px brand glyph (`AgentMark`) with no glaring white tile.
 * - In tiles and phone rows: the agent's tile with an optional status dot on its corner.
 */
import { cleanup, computed, createMotion, effect, token, View } from "nsh";
import type { ProjectAgent } from "@real-bot/protocol";
import type { SessionStatusResult } from "../../m/sidebar/session-status";
import { LoopsHeld } from "../interface/motion";
import { AgentLogo, AgentMark } from "../settings/AgentLogo";
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
  /** Bare compact glyph without white tile background or duplicate corner dot (desktop tree rows & live strip). */
  compact?: boolean;
  /** Hide the corner status dot when the row already renders its own status indicator. */
  hideStatusDot?: boolean;
  testID?: string;
}) {
  const edge = () => props.edge ?? (props.compact ? 18 : rowAvatarEdge());
  const logo = () => (props.compact ? Math.max(14, edge() - 2) : Math.round(edge() * 0.8));
  const shown = () => (!props.compact && !props.hideStatusDot && props.status && props.status.kind !== "idle" ? props.status : null);
  // A boolean of its own: the status is a new object with every streamed token, and the effect below
  // restarted the animation each time (eight avatars, half a millisecond each, per token).
  const held = LoopsHeld();
  const pulsing = computed(() => {
    const s = shown();
    return !held() && Boolean(s && (s.isBusy || s.kind === "running" || s.kind === "replying"));
  });

  const pulse = createMotion();
  effect(() => {
    if (!pulsing()) return void pulse.reset();
    void pulse.play({ duration: 1000, iterations: "infinite", keyframes: { opacity: [0.35, 1, 0.35], scale: [0.85, 1.15, 0.85] } });
    cleanup(() => pulse.reset());
  });

  return (
    <View
      testID={props.testID ?? "agent-avatar"}
      accessible={false}
      tooltip={tip(props.title)}
      class="relative items-center justify-center shrink-0"
      style={{ width: edge(), height: edge() }}
    >
      <If
        when={props.compact}
        else={
          <View class="overflow-hidden" style={{ width: logo(), height: logo(), borderRadius: logo() * 0.3 }}>
            <AgentLogo runner={props.agent} size={logo()} />
          </View>
        }
      >
        <AgentMark runner={props.agent} size={logo()} />
      </If>
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
