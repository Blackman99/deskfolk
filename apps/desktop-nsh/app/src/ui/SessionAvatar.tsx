/**
 * A conversation's avatar (`SessionAvatar.svelte`): one Bot is a rounded square (a folk stands on its
 * own and acts out the Bot's status), you a circle, and a group's members overlap as heads, up to
 * three and a "+N" for the rest. A status dot sits at the corner when the Bot has something to say.
 */
import { Image, Text, View, createMotion, effect, signal, token, type ViewStyle } from "nsh";
import type { Bot, SessionSummary } from "@real-bot/protocol";
import { botAvatarColor, compositeAvatarLayout, isFolkAvatar, sessionAvatars } from "../m/avatar";
import { folkMotion } from "../m/folk-motion";
import { rosterLetter } from "../m/sidebar/roster-letter";
import { youBotPeer } from "../m/sidebar/session-groups";
import type { SessionStatusResult } from "../m/sidebar/session-status";
import { FolkAvatar } from "./FolkAvatar";
import { Icon } from "./Icon";
import { shadow } from "./styles";
import { tip } from "./tip";

export type SessionAvatarSize = "tab" | "sm" | "md" | "top" | "hero";

export const AVATAR_EDGE: Record<SessionAvatarSize, number> = { tab: 20, sm: 28, md: 40, top: 36, hero: 44 };
/** The status dot's edge and border by avatar size. */
const DOT: Record<SessionAvatarSize, { edge: number; border: number }> = {
  tab: { edge: 7, border: 1.5 },
  sm: { edge: 7.5, border: 1.5 },
  md: { edge: 9.5, border: 2 },
  top: { edge: 9, border: 2 },
  hero: { edge: 12, border: 2.5 },
};

type Pct = `${number}%`;
type Slot = { left?: Pct; right?: Pct; top?: Pct; bottom?: Pct; ring: boolean };
/** Where each member sits, per layout: `[width %, letter scale, slots]` (the messenger's CSS, slot by slot). */
const LAYOUT = {
  pair: { width: 62, letter: 0.28, slots: [{ left: "0%", top: "0%", ring: false }, { right: "0%", bottom: "0%", ring: true }] as Slot[] },
  triad: {
    width: 58,
    letter: 0.26,
    slots: [{ left: "21%", top: "0%", ring: false }, { left: "0%", bottom: "0%", ring: true }, { right: "0%", bottom: "0%", ring: true }] as Slot[],
  },
  quad: {
    width: 52,
    letter: 0.24,
    slots: [
      { left: "0%", top: "0%", ring: false },
      { right: "0%", top: "0%", ring: true },
      { left: "0%", bottom: "0%", ring: true },
      { right: "0%", bottom: "0%", ring: true },
    ] as Slot[],
  },
} as const;

/** `var(--av-3-bg)` (the messenger's palette) as the theme token it is. */
const palette = (value: string): string => {
  const name = /--([\w-]+)/.exec(value)?.[1];
  return name ? token(name as never) : value;
};

const DOT_COLOR: Record<string, string> = {
  running: "brand",
  replying: "brand",
  waiting_approval: "warn",
  waiting_ask: "purple",
  failed: "danger",
  interrupted: "danger",
};

export function SessionAvatar(props: {
  session: SessionSummary;
  bots: ReadonlyMap<string, Bot>;
  size?: SessionAvatarSize;
  class?: string;
  botStatus?: (botId: string) => SessionStatusResult | undefined;
  /** Where the Bot is at work, said in the dot's tip in place of the bare status. */
  statusNote?: string | null;
  /** The colour a stacked member's ring is drawn in, the surface the avatar stands on (the sidebar's by default). */
  ringColor?: string;
  testID?: string;
}) {
  const size = () => props.size ?? "md";
  const edge = () => AVATAR_EDGE[size()];
  const avatars = () => sessionAvatars(props.session, props.bots);
  const plan = () => compositeAvatarLayout(avatars());
  const failed = signal<Record<string, string>>({});
  const overflowTooltip = () => (plan().overflowCount > 0 ? `+${plan().overflowCount} (${plan().overflowNames.join(", ")})` : "");
  const targetBotId = () => {
    const peer = youBotPeer(props.session);
    if (peer) return peer;
    const list = avatars();
    return plan().layout === "single" && list.length === 1 && props.bots.has(list[0]!.id) ? list[0]!.id : null;
  };
  const targetBot = () => {
    const id = targetBotId();
    return id ? (props.bots.get(id) ?? null) : null;
  };
  const status = (): SessionStatusResult | undefined => {
    const id = targetBotId();
    const bot = targetBot();
    return id && bot && !bot.archived_at && props.botStatus ? props.botStatus(id) : undefined;
  };
  const isGroup = () => props.session.kind === "group";
  const single = () => plan().layout === "single";
  const ring = () => props.ringColor ?? token("sidebar-bg");

  const pulse = createMotion();
  effect(() => {
    const s = status();
    if (s?.isBusy || s?.kind === "running" || s?.kind === "replying") {
      void pulse.play({ duration: 1000, iterations: "infinite", keyframes: { opacity: [0.35, 1, 0.35], scale: [0.85, 1.15, 0.85] } });
    } else pulse.reset();
  });

  const slotStyle = (i: number): ViewStyle => {
    const p = plan();
    if (p.layout === "single") return { width: "100%", height: "100%" };
    const spec = LAYOUT[p.layout as "pair" | "triad" | "quad"];
    const slot = spec.slots[i === -1 ? spec.slots.length - 1 : i] ?? spec.slots[spec.slots.length - 1]!;
    const { ring: ringed, ...place } = slot;
    return {
      position: "absolute",
      width: `${spec.width}%` as Pct,
      height: `${spec.width}%` as Pct,
      ...place,
      ...(ringed ? { boxShadow: `0 0 0 ${(edge() * 0.045).toFixed(2)}px ${ring()}` } : {}),
    };
  };
  /** Rounded square for one Bot (not a group), circle for stacked heads. */
  const radius = () => (single() && !isGroup() ? edge() * 0.3 : edge());
  const letterSize = () => edge() * (single() ? 0.38 : (LAYOUT[plan().layout as "pair" | "triad" | "quad"]?.letter ?? 0.28));

  return (
    <View
      testID={props.testID}
      accessible={false}
      class={`relative items-center justify-center shrink-0 ${props.class ?? ""}`}
      style={{
        width: edge(),
        height: edge(),
        borderRadius: edge(),
      }}
    >
      <If
        when={plan().layout !== "empty"}
        else={
          <View class="w-full h-full items-center justify-center rounded-full border border-line bg-chip">
            <Icon name="users" size={20} />
          </View>
        }
      >
        <Each of={plan().visible} key={(a) => a.id}>
          {(avatar, i) => {
            const acting = () => single() && isFolkAvatar(avatar().avatar);
            const folk = () => isFolkAvatar(avatar().avatar);
            const colors = () => botAvatarColor(avatar().id);
            return (
              <View
                tooltip={tip(avatar().name ?? "Bot")}
                class="items-center justify-center overflow-hidden border"
                style={{
                  ...slotStyle(i()),
                  borderRadius: single() && !isGroup() ? radius() : edge(),
                  backgroundColor: folk() ? "transparent" : palette(colors().bg),
                  borderColor: folk() ? "transparent" : palette(colors().border),
                  overflow: folk() ? "visible" : "hidden",
                }}
              >
                <If
                  when={folk() && avatar().avatar}
                  else={
                    <If
                      when={avatar().src && failed()[avatar().id] !== avatar().src}
                      else={
                        <Text class="font-bold" style={{ fontSize: letterSize(), color: palette(colors().text) }}>
                          {avatar().name ? rosterLetter(avatar().name!) : "?"}
                        </Text>
                      }
                    >
                      <Image
                        src={avatar().src!}
                        accessibilityLabel={avatar().name ?? ""}
                        onError={() => failed.set({ ...failed(), [avatar().id]: avatar().src! })}
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    </If>
                  }
                >
                  <FolkAvatar avatar={avatar().avatar!} motion={acting() ? folkMotion(status()?.kind) : "idle"} />
                </If>
              </View>
            );
          }}
        </Each>
        <If when={plan().overflowCount > 0}>
          <View
            tooltip={tip(overflowTooltip())}
            class="items-center justify-center overflow-hidden border border-accent-border bg-chip"
            style={{ ...slotStyle(-1), borderRadius: edge() }}
          >
            <Text class="font-bold text-brand" style={{ fontSize: edge() * 0.22 }}>
              +{plan().overflowCount > 99 ? "99" : plan().overflowCount}
            </Text>
          </View>
        </If>
        <If when={status() && status()!.kind !== "idle" ? status() : null}>
          {(s) => (
            <View
              testID="avatar-status-dot"
              tooltip={tip(`${targetBot()?.name ?? "Bot"}: ${props.statusNote ?? s().label}`)}
              class="rounded-full"
              style={{
                position: "absolute",
                right: 0,
                bottom: 0,
                width: DOT[size()].edge,
                height: DOT[size()].edge,
                borderWidth: DOT[size()].border,
                borderColor: ring(),
                backgroundColor: s().isBusy ? token("brand") : token((DOT_COLOR[s().kind] ?? "ok") as never),
                opacity: s().isBusy || s().kind === "running" || s().kind === "replying" ? pulse.opacity : 1,
                transform: s().isBusy || s().kind === "running" || s().kind === "replying" ? [...pulse.transform] : [],
              }}
            />
          )}
        </If>
      </If>
    </View>
  );
}
