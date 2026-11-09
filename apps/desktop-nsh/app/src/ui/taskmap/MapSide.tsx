/**
 * The map's side column (`MapSide.svelte`, ADR 0096): each lead (the agent, or every Bot of a
 * conversation, ADR 0097) and what it is on, the subagents sent out, what was asked (your lines and
 * your answers), and the moments worth a look.
 */
import { Image, Scroll, Text, View, effect, type ScrollRef } from "nsh";
import type { Copy } from "../../m/copy";
import type { CharacterLook } from "../../m/taskmap/characters";
import { statusText, type FrameActor } from "../../m/taskmap/frame";
import type { MomentText } from "../../m/taskmap/moment-text";
import type { Quest } from "../../m/taskmap/timeline";
import { cssColor } from "../styles";
import { MapLogo } from "./MapLogo";

type T = Copy["taskmap"];

const CHIP: Record<string, { bg: string; ink: string }> = {
  work: { bg: "bg-accent-tint", ink: "text-brand" },
  walk: { bg: "bg-chip", ink: "text-ink-secondary" },
  idle: { bg: "bg-chip", ink: "text-ink-secondary" },
  fail: { bg: "bg-danger-bg", ink: "text-danger-text" },
  back: { bg: "bg-ok-bg", ink: "text-ok-text" },
  none: { bg: "bg-chip", ink: "text-ink-secondary" },
};

/** A ring in the character's colour round its logo, as the box-shadow pair did. */
const ring = (color: string, inner: number, outer: number) => ({ borderWidth: outer - inner, borderColor: color });

export function MapSide(props: {
  t: T;
  /** Each character's name, figure and whose model it works on, by index. */
  looks: readonly CharacterLook[];
  /** Show each lead's own figure rather than its logo: a Bot is known by its face. */
  faces: boolean;
  actors: readonly FrameActor[];
  colors: readonly string[];
  place: (q: number) => string;
  follow: number;
  quests: readonly Quest[];
  quest: number;
  moments: readonly (MomentText & { v: number })[];
  live: number;
  when: (at: number) => string;
  /** A conversation by name, and whether to say it: a plan worked in more than one. */
  conv?: (sessionId: string) => string;
  showConv?: boolean;
  onFollow: (b: number) => void;
  onJump: (v: number) => void;
}) {
  const leads = () => props.actors.filter((a) => a.lead);
  const subs = () => props.actors.filter((a) => !a.lead);
  const conv = (id: string) => (props.conv ?? (() => ""))(id);
  const t = () => props.t;

  /**
   * The line a lead is working for. A project session's agent, the one at the playhead; a Bot, your
   * newest line before its step, in the conversation of that step when the plan is in several.
   */
  const forLineOf = (a: FrameActor): string => {
    let q: Quest | undefined;
    if (!props.faces) q = props.quests[props.quest];
    else if (a.at !== null) {
      for (const line of props.quests) if (line.at <= a.at && (!props.showConv || !a.sessionId || line.sessionId === a.sessionId)) q = line;
    }
    if (!q) return "";
    return q.kind === "say" ? t().forLine(q.text.slice(0, 40)) : t().forAnswer(q.answers.join("；").slice(0, 40));
  };

  // A long list of what was asked scrolls in its card; the line being worked for is kept in sight.
  let saidList: ScrollRef | null = null;
  const rows: { y: number; h: number }[] = [];
  let viewH = 0;
  let scrolled = 0;
  const keep = () => {
    const row = rows[props.quest];
    if (!saidList || !row || viewH <= 0) return;
    if (row.y < scrolled) saidList.scrollTo({ y: row.y, animated: false });
    else if (row.y + row.h > scrolled + viewH) saidList.scrollTo({ y: row.y + row.h - viewH, animated: false });
  };
  effect(() => {
    void props.quest;
    void props.quests.length;
    queueMicrotask(keep);
  });

  const MainCard = (p: { main: FrameActor }) => {
    const look = () => props.looks[p.main.b];
    const name = () => look()?.name ?? p.main.short;
    const forLine = () => forLineOf(p.main);
    const following = () => props.follow === p.main.b;
    return (
      <View role="region" testID={`taskmap-lead-${p.main.b}`} class="shrink-0 px-3 py-[10px] bg-pane border border-line rounded-(--radius-lg)">
        <View class="flex-row gap-3 items-start">
          <View
            class={`shrink-0 ${props.faces ? "w-[40px] h-[40px] rounded-full bg-chip overflow-hidden" : "rounded-(--radius-sm)"}`}
            style={ring(cssColor(props.colors[p.main.b] ?? "#146a7c"), 0, 2)}
          >
            <If when={props.faces && look()?.avatar ? look()!.avatar : null} else={<If when={look()}>{(l) => <MapLogo source={l().source} size={40} />}</If>}>
              {(src) => <Image src={src()} style={{ width: 36, height: 36 }} accessible={false} />}
            </If>
          </View>
          <View class="flex-1 min-w-0 gap-[3px]">
            <View class="flex-row items-center gap-[6px]">
              <Text class="text-[14px] font-bold text-ink">{name()}</Text>
              <Text class={`text-[11px] font-semibold rounded-full px-2 py-px ${CHIP[p.main.status]!.bg} ${CHIP[p.main.status]!.ink}`}>{statusText(p.main, t())}</Text>
              <FollowButton
                testID={`taskmap-follow-${p.main.b}`}
                on={following()}
                label={following() ? t().stopFollowOf(name()) : t().followOf(name())}
                text={t().follow}
                onPress={() => props.onFollow(p.main.b)}
              />
            </View>
            <Text class="text-[13px] text-ink line-clamp-1">
              {p.main.verb ? `${t().at(props.place(p.main.tile))} · ${p.main.verb}${p.main.file ? ` ${p.main.file}` : ""}` : t().status.none}
            </Text>
            <Text class="text-[13px] text-ink-muted line-clamp-1">
              {`${props.showConv && p.main.sessionId ? `${conv(p.main.sessionId)} · ` : ""}${forLine() ? `${forLine()} · ` : ""}${t().stepLine(p.main.step, p.main.fails)}`}
            </Text>
            <If when={p.main.hasModel ? look() : undefined}>
              {(l) => (
                <View class="flex-row items-center gap-[5px]">
                  <MapLogo source={l().source} size={12} />
                  <Text class="flex-1 min-w-0 text-[13px] text-ink-secondary line-clamp-1">{t().ranBy(l().source.name, p.main.modelShort)}</Text>
                </View>
              )}
            </If>
          </View>
        </View>
      </View>
    );
  };

  return (
    <View testID="taskmap-side" class="flex-1 min-h-0 gap-2">
      <Each of={leads()} key={(a) => a.key}>{(main) => <MainCard main={main()} />}</Each>

      <If when={subs().length > 0}>
        <View role="region" testID="taskmap-subs" class="shrink-0 px-3 py-[10px] bg-pane border border-line rounded-(--radius-lg)">
          <View class="flex-row items-baseline justify-between gap-2 mb-[6px]">
            <Text class="text-[13px] font-bold text-ink">{t().card.subs}</Text>
            <Text class="text-[13px] text-ink-muted">{t().card.subsHint}</Text>
          </View>
          <Each of={subs()} key={(a) => a.key}>
            {(sub) => {
              const following = () => props.follow === sub().b;
              return (
                <View class="flex-row items-center gap-2 py-[3px]">
                  <View class="shrink-0 rounded-(--radius-sm)" style={{ ...ring(cssColor(props.colors[sub().b] ?? "#146a7c"), 0, 1), opacity: sub().present ? 1 : 0.5 }}>
                    <If when={props.looks[sub().b]}>{(l) => <MapLogo source={l().source} size={24} />}</If>
                  </View>
                  <View class="flex-1 min-w-0 gap-[3px]">
                    <View class="flex-row items-center gap-[6px]">
                      <Text class="text-[14px] font-bold" style={{ color: cssColor(props.colors[sub().b] ?? "#146a7c") }}>{sub().short}</Text>
                      <Text class={`text-[11px] font-semibold rounded-full px-2 py-px ${CHIP[sub().status]!.bg} ${CHIP[sub().status]!.ink}`}>{statusText(sub(), t())}</Text>
                    </View>
                    <Text class="text-[13px] text-ink-muted line-clamp-1">{`${sub().description ?? ""}${sub().modelShort ? ` · ${sub().modelShort}` : ""}`}</Text>
                  </View>
                  <FollowButton
                    testID={`taskmap-follow-${sub().b}`}
                    on={following()}
                    disabled={!sub().present}
                    label={following() ? t().stopFollowOf(sub().short) : t().followOf(sub().short)}
                    text={t().follow}
                    onPress={() => props.onFollow(sub().b)}
                  />
                </View>
              );
            }}
          </Each>
        </View>
      </If>

      <If when={props.quests.length > 0 || props.moments.length > 0}>
        <View testID="taskmap-split" class="flex-1 min-h-0 gap-2">
          <If when={props.quests.length > 0}>
            <View
              role="region"
              testID="taskmap-said"
              class="px-3 py-[10px] bg-pane border border-line rounded-(--radius-lg) overflow-hidden shrink min-h-0"
              style={{ minHeight: props.quests.length > 2 ? 120 : 0 }}
            >
              <View class="flex-row items-baseline justify-between gap-2 mb-[6px]">
                <Text class="text-[13px] font-bold text-ink">{t().card.said}</Text>
                <Text class="text-[13px] text-ink-muted">{t().card.saidHint}</Text>
              </View>
              <Scroll
                ref={(node) => (saidList = node)}
                class="shrink min-h-0"
                onLayout={(e) => { viewH = e.bounds.size.height; keep(); }}
                onScroll={(e) => { scrolled = e.offset.y; }}
              >
                <Each of={props.quests}>
                  {(q, i) => (
                    <View
                      role="button"
                      testID={`taskmap-quest-${i()}`}
                      accessibilityState={{ selected: i() === props.quest }}
                      onLayout={(e) => { rows[i()] = { y: e.bounds.origin.y, h: e.bounds.size.height }; }}
                      onPress={() => props.onJump(q().v)}
                      class={`cursor-pointer select-none flex-row gap-2 items-start w-full px-[6px] py-[5px] rounded-(--radius-sm) border ${i() === props.quest ? "bg-accent-tint border-accent-border" : "border-transparent hover:bg-row-hover"}`}
                      style={{ opacity: i() > props.quest ? 0.55 : 1 }}
                    >
                      <Text class="font-mono text-[13px] text-ink-muted">{props.when(q().at)}</Text>
                      <Text class="flex-1 min-w-0 text-[13px] text-ink line-clamp-1">
                        <Text class="font-bold text-brand">{q().kind === "say" ? t().card.you : t().card.answer}</Text>
                        <If when={props.showConv && q().sessionId}>
                          {() => <Text class="text-[11px] text-ink-secondary">{` ${conv(q().sessionId!)}`}</Text>}
                        </If>
                        {` ${q().kind === "say" ? (q() as Extract<Quest, { kind: "say" }>).text : (q() as Extract<Quest, { kind: "answer" }>).answers.join("；")}`}
                      </Text>
                    </View>
                  )}
                </Each>
              </Scroll>
            </View>
          </If>

          <If when={props.moments.length > 0}>
            <View role="region" testID="taskmap-moments" class="px-3 py-[10px] bg-pane border border-line rounded-(--radius-lg) overflow-hidden shrink min-h-[120px]">
              <View class="flex-row items-baseline justify-between gap-2 mb-[6px]">
                <Text class="text-[13px] font-bold text-ink">{t().card.moments}</Text>
                <Text class="text-[13px] text-ink-muted">{t().card.momentsHint}</Text>
              </View>
              <Scroll class="shrink min-h-0">
                <Each of={props.moments}>
                  {(m, i) => (
                    <View
                      role="button"
                      testID={`taskmap-moment-${i()}`}
                      accessibilityState={{ selected: i() === props.live }}
                      onPress={() => props.onJump(Math.max(0, m().v - 1))}
                      class={`cursor-pointer select-none flex-row gap-2 items-start w-full px-[6px] py-[5px] rounded-(--radius-sm) border ${i() === props.live ? "bg-accent-tint border-accent-border" : "border-transparent hover:bg-row-hover"}`}
                    >
                      <View class="w-[8px] h-[8px] rounded-full shrink-0 mt-[5px]" style={{ backgroundColor: cssColor(m().color) }} />
                      <View class="flex-1 min-w-0">
                        <Text class="text-[13px] font-semibold text-ink">{m().title}</Text>
                        <Text class="text-[11px] text-ink-muted">{m().sub}</Text>
                      </View>
                    </View>
                  )}
                </Each>
              </Scroll>
            </View>
          </If>
        </View>
      </If>
    </View>
  );
}

/** The small "follow" toggle of a card (`.tm-follow-btn`). */
function FollowButton(props: { on: boolean; disabled?: boolean; label: string; text: string; testID: string; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.on, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class={`cursor-pointer select-none disabled:cursor-default ml-auto shrink-0 min-h-[24px] px-2 justify-center rounded-(--radius-sm) border disabled:opacity-[0.45] ${props.on ? "bg-brand border-brand" : "bg-pane border-line"}`}
    >
      <Text class={`text-[11px] font-semibold ${props.on ? "text-on-accent" : "text-ink"}`}>{props.text}</Text>
    </View>
  );
}
