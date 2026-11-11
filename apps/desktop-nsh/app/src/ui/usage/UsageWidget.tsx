/**
 * Every agent's usage as a small ball over the main window (ADR 0080). Its ring is as full as what
 * is used of the tightest window of all. Pointed at, the ball opens into a column of the agents,
 * each ringed by its own tightest window (a dashed ring: today's records only); pointing at one
 * opens a card beside it with every account of that agent. Dragged anywhere; dropped by the left
 * or right edge it docks there, tucked away to a tab. Clicks pin it open (touch, or to keep it), its
 * context menu hides it, and Tools › Usage brings it back open (`UsageWidget.svelte`).
 *
 * On NSH the ball, the card and the menu are `Overlay`s, nested so that a press in any of them is
 * inside the widget; Escape and a press outside close it. The folding is instant, not the
 * messenger's clip-path morph, and the card appears in place instead of growing out of its bubble.
 */
import { Canvas, cleanup, effect, Overlay, PanResponder, Path2D, Scroll, signal, Text, token, View, windowSize } from "nsh";
import type { UsageAgent } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { usageCheckedTime, usageLatestCheck, usageLevel, usageTightest, usageUsed, usageUsedText } from "../../m/usage/usage.ts";
import { usageDrop, usageWidget } from "../../m/usage/usage-widget.svelte.ts";
import { shadow } from "../styles";
import { AgentLogo } from "../settings/AgentLogo";
import { tip } from "../tip";
import { UsageAgentSection } from "./UsageAgentSection";
import { drawRing, levelColor } from "./ring";
import { persistUsageWidget, useUsageFeed } from "./usage-session";

/** The ball's box and each agent's slot in the column. */
const SLOT = 48;
const DRAG_PX = 4;
const MARGIN = 8;
/** Moving between the column and a card crosses a gap: this long before it all folds away. */
const LEAVE_MS = 320;
const CARD_W = 340;
/** Tucked, only this much of the ball stays in the window: a tab in the gutter beside the content. */
const TUCK_SHOWN = 8;

const key = (agent: UsageAgent) => `${agent.runner}:${agent.custom_id ?? ""}`;
/** Each agent's tightest window over all its accounts; null for one with today's records only. */
const tightestOf = (agent: UsageAgent) => usageTightest(agent.accounts.flatMap((account) => (account.available ? account.windows : [])));

const BORDER = { normal: "border-line", warn: "border-warn", danger: "border-danger" } as const;
const TUCKED = { normal: "bg-accent-tint", warn: "bg-warn-bg", danger: "bg-danger-bg" } as const;

const GLYPH_TICK = new Path2D("M14 15.5l3-3");
const GLYPH_DIAL = new Path2D("M8.6 18.5a6 6 0 1 1 10.8 0");

export function UsageWidget() {
  persistUsageWidget();
  const { feed, client, locale } = useUsageFeed();
  const agents = () => feed.agents ?? [];
  const worst = () => agents().reduce((most, agent) => Math.max(most, tightestOf(agent)?.percent ?? 0), 0);
  const anyWindow = () => agents().some((agent) => tightestOf(agent) !== null);
  const visible = () => !usageWidget.hidden && agents().length > 0;
  const checked = () => usageCheckedTime(usageLatestCheck(agents()), locale());
  const viewW = () => windowSize().width;
  const viewH = () => windowSize().height;

  const pointing = signal(false);
  const keyboard = signal(false);
  /** The agent pointed at or picked, for its card. */
  const active = signal<string | null>(null);
  const pinnedAgent = signal<string | null>(null);
  const menuAt = signal<{ x: number; y: number } | null>(null);
  const dragAt = signal<{ left: number; top: number } | null>(null);
  const cardH = signal(0);
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  let swallowUntil = 0;
  cleanup(() => {
    clearTimeout(leaveTimer);
    clearTimeout(blurTimer);
  });

  const place = () => usageWidget.place;
  const docked = () => (dragAt() ? null : place().dock);
  const expanded = () => dragAt() === null && (pointing() || keyboard() || usageWidget.open || menuAt() !== null);
  const tucked = () => docked() !== null && !expanded();
  const top = () => {
    const drag = dragAt();
    return drag ? drag.top : Math.round(place().top * Math.max(0, viewH() - SLOT));
  };
  /** The ball's own left edge in the window. */
  const left = () => {
    const drag = dragAt();
    if (drag) return drag.left;
    const at = place();
    if (at.dock === null) return Math.round(at.left * Math.max(0, viewW() - SLOT));
    return at.dock === "left" ? 0 : Math.max(0, viewW() - SLOT);
  };
  /** The column grows toward the roomier half: down from a ball in the top half, up from one below. */
  const upward = () => top() + SLOT / 2 > viewH() / 2;
  /** Cards open toward the middle of the window. */
  const cardLeftward = () => left() + SLOT / 2 > viewW() / 2;
  const columnH = () => SLOT + agents().length * SLOT + 4;
  const boxH = () => (expanded() ? columnH() : SLOT);
  const boxW = () => (tucked() ? TUCK_SHOWN : SLOT);
  const boxLeft = () => (tucked() && docked() === "right" ? viewW() - TUCK_SHOWN : left());
  const boxTop = () => (expanded() && upward() ? top() - (columnH() - SLOT) : top());
  const shownAgent = () => (expanded() ? (agents().find((agent) => key(agent) === (pinnedAgent() ?? active())) ?? null) : null);
  const level = () => usageLevel(worst());

  function enter(): void {
    clearTimeout(leaveTimer);
    pointing.set(true);
  }

  function leave(): void {
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => {
      pointing.set(false);
      if (!usageWidget.open) active.set(null);
    }, LEAVE_MS);
  }

  function pointAt(agent: UsageAgent): void {
    if (pinnedAgent() && pinnedAgent() !== key(agent)) pinnedAgent.set(null);
    active.set(key(agent));
  }

  function pick(agent: UsageAgent): void {
    pointAt(agent);
    pinnedAgent.set(pinnedAgent() === key(agent) && usageWidget.open ? null : key(agent));
    usageWidget.open = true;
  }

  /** Only a keyboard's focus keeps it open; it goes with the focus, unless the focus moves within it. */
  function focused(): void {
    clearTimeout(blurTimer);
    keyboard.set(true);
  }

  function blurred(): void {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => keyboard.set(false), 0);
  }

  function closeAll(): void {
    usageWidget.open = false;
    keyboard.set(false);
    pinnedAgent.set(null);
    active.set(null);
    pointing.set(false);
  }

  function escape(): void {
    menuAt.set(null);
    closeAll();
  }

  function hide(): void {
    menuAt.set(null);
    pinnedAgent.set(null);
    active.set(null);
    usageWidget.hide();
  }

  function onBallPress(): void {
    if (Date.now() < swallowUntil) return;
    usageWidget.open = !usageWidget.open;
    if (!usageWidget.open) pinnedAgent.set(null);
  }

  let origin = { left: 0, top: 0 };
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => Math.hypot(g.dx, g.dy) >= DRAG_PX,
    onPanResponderGrant: () => {
      origin = { left: boxLeft() + (docked() === "left" && tucked() ? 0 : 0), top: top() };
      usageWidget.open = false;
      pinnedAgent.set(null);
      active.set(null);
    },
    onPanResponderMove: (_e, g) => {
      dragAt.set({
        left: Math.min(Math.max(0, origin.left + g.dx), Math.max(0, viewW() - SLOT)),
        top: Math.min(Math.max(0, origin.top + g.dy), Math.max(0, viewH() - SLOT)),
      });
    },
    onPanResponderRelease: () => {
      const drag = dragAt();
      if (!drag) return;
      usageWidget.move(usageDrop(drag.left, drag.top, SLOT, SLOT, viewW(), viewH()));
      dragAt.set(null);
      swallowUntil = Date.now() + 300;
    },
    onPanResponderTerminate: () => dragAt.set(null),
  });

  // Tools › Usage (or the menu bar) opened it: the column, with the first agent's card.
  effect(() => {
    if (!usageWidget.open || pinnedAgent() || active() || agents().length === 0) return;
    pinnedAgent.set(key(agents()[0]!));
  });

  /** Where the card stands: beside its agent's bubble, toward the middle, kept on screen. */
  const cardBox = () => {
    const agent = shownAgent();
    const index = agent ? agents().findIndex((a) => key(a) === key(agent)) : -1;
    if (index < 0) return { left: 0, top: 0 };
    const y = upward() ? top() - (index + 1) * SLOT : top() + (index + 1) * SLOT;
    const x = cardLeftward() ? left() - 8 - CARD_W : left() + SLOT + 8;
    const clampedTop = Math.max(MARGIN, Math.min(y - 6, viewH() - MARGIN - cardH()));
    return { left: Math.max(MARGIN, Math.min(x, viewW() - CARD_W - MARGIN)), top: clampedTop };
  };

  const open = () => menuAt() !== null || usageWidget.open || shownAgent() !== null;

  return (
    <>
      <If when={visible()}>
        <Overlay
          style={{ left: boxLeft(), top: boxTop() }}
          onPressOutside={() => {
            menuAt.set(null);
            if (usageWidget.open) closeAll();
          }}
          onCancel={open() ? escape : undefined}
        >
          <View
            testID="usage-widget"
            accessible={false}
            style={{ width: boxW(), height: boxH(), overflow: tucked() ? "hidden" : "visible" }}
            onMouseEnter={enter}
            onMouseLeave={leave}
          >
            <View
              testID="usage-shell"
              class={`border rounded-[24px] bg-pane overflow-hidden items-center ${BORDER[level()]} ${tucked() ? TUCKED[level()] : ""}`}
              style={{
                width: SLOT,
                height: boxH(),
                marginLeft: tucked() && docked() === "left" ? TUCK_SHOWN - SLOT : 0,
                flexDirection: upward() ? "column-reverse" : "column",
                boxShadow: shadow("md"),
              }}
            >
              <View
                testID="usage-ball"
                role="button"
                accessibilityLabel={copy().usage.widget}
                accessibilityState={{ expanded: expanded() }}
                tooltip={tip(usageWidget.open ? copy().usage.close : copy().usage.show)}
                class="cursor-pointer select-none w-[46px] h-[46px] shrink-0 rounded-full items-center justify-center"
                onPress={onBallPress}
                onContextMenu={(e) => menuAt.set({ x: e.pagePosition.x, y: e.pagePosition.y })}
                onFocus={focused}
                onBlur={blurred}
                {...pan.panHandlers}
              >
                <Canvas
                  accessible={false}
                  style={{ width: 40, height: 40, opacity: tucked() ? 0 : 1 }}
                  draw={(cx) => {
                    const color = levelColor(level());
                    drawRing(cx, { box: 40, view: 28, radius: 12, width: 2.5, used: anyWindow() ? usageUsed(worst()) : null, color, track: token("line") });
                    const s = 40 / 28;
                    cx.save();
                    cx.scale(s, s);
                    cx.strokeStyle = color;
                    cx.lineWidth = 1.8;
                    cx.lineCap = "round";
                    cx.stroke(GLYPH_TICK);
                    cx.stroke(GLYPH_DIAL);
                    cx.restore();
                  }}
                />
              </View>
              <If when={expanded()}>
                <View
                  testID="usage-column"
                  accessibilityLabel={copy().usage.title}
                  class="items-center shrink-0"
                  style={{ flexDirection: upward() ? "column-reverse" : "column", paddingTop: upward() ? 2 : 0, paddingBottom: upward() ? 0 : 2 }}
                >
                  {() =>
                    agents().map((agent) => {
                      const tightest = () => tightestOf(agent);
                      const tone = () => (tightest() ? usageLevel(tightest()!.percent) : "today");
                      const label = () =>
                        `${agent.runner === "claude_code" ? "Claude" : agent.label}${tightest() ? ` ${copy().usage.used(usageUsedText(tightest()!.percent))}` : ""}`;
                      return (
                        <View class="w-[48px] h-[48px] items-center justify-center">
                          <View
                            testID={`usage-bubble-${key(agent)}`}
                            role="button"
                            accessibilityLabel={label()}
                            accessibilityValue={{ text: tone() }}
                            class={`cursor-pointer select-none w-[42px] h-[42px] rounded-full items-center justify-center hover:bg-row-hover ${shownAgent() && key(shownAgent()!) === key(agent) ? "bg-row-hover" : ""}`}
                            onMouseEnter={() => pointAt(agent)}
                            onFocus={() => {
                              focused();
                              pointAt(agent);
                            }}
                            onBlur={blurred}
                            onPress={() => pick(agent)}
                          >
                            <Canvas
                              accessible={false}
                              style={{ position: "absolute", left: 0, top: 0, width: 42, height: 42 }}
                              draw={(cx) => {
                                const t = tightest();
                                drawRing(cx, {
                                  box: 42,
                                  view: 32,
                                  radius: 14.5,
                                  width: t ? 2 : 1.5,
                                  used: t ? usageUsed(t.percent) : null,
                                  color: levelColor(t ? usageLevel(t.percent) : "normal"),
                                  track: token("line"),
                                  dashed: !t,
                                });
                              }}
                            />
                            <View class="w-[26px] h-[26px] rounded-full overflow-hidden" accessible={false}>
                              <AgentLogo runner={agent.runner} size={26} />
                            </View>
                          </View>
                        </View>
                      );
                    })
                  }
                </View>
              </If>
            </View>
            <If when={shownAgent()}>
              {(agent) => (
                <Overlay
                  style={{ left: cardBox().left, top: cardBox().top, width: CARD_W }}
                  onPressOutside={() => {}}
                  onCancel={escape}
                >
                  <View
                    testID={`usage-card-${key(agent())}`}
                    role="region"
                    accessibilityLabel={agent().runner === "claude_code" ? "Claude" : agent().label}
                    class="bg-pane border border-line rounded-[12px] overflow-hidden"
                    style={{ width: CARD_W, boxShadow: shadow("lg") }}
                    onLayout={(e) => cardH.set(e.bounds.size.height)}
                    onMouseEnter={enter}
                    onMouseLeave={leave}
                    onFocus={focused}
                    onBlur={blurred}
                  >
                    <Scroll style={{ maxHeight: Math.min(viewH() * 0.7, viewH() - 16) }} contentClass="gap-[10px] py-[12px] px-[14px]">
                      <UsageAgentSection agent={agent()} locale={locale()} now={feed.now} logoSize={28} large />
                      <If when={agent().accounts.length === 0}>
                        <Text testID="usage-card-note" class="text-[12px] leading-[18px] text-ink-muted">{copy().usage.todayOnlyHint}</Text>
                      </If>
                      <View class="flex-row items-center gap-[8px] pt-[10px] border-t border-line">
                        <Text testID="usage-card-checked" class="flex-1 min-w-0 text-[11px] text-ink-muted line-clamp-1">
                          {checked() ? (feed.failed ? copy().usage.stale(checked()!) : copy().usage.checkedAt(checked()!)) : ""}
                        </Text>
                        <View
                          testID="usage-card-refresh"
                          role="button"
                          disabled={feed.busy}
                          onPress={() => {
                            const api = client();
                            if (api) void feed.load(api, true);
                          }}
                          class="cursor-pointer select-none disabled:cursor-default shrink-0 px-[8px] py-[3px] border border-line rounded-(--radius-md) hover:bg-row-hover disabled:opacity-[0.6]"
                        >
                          <Text class="text-[11px] text-ink">{feed.busy ? copy().usage.refreshing : copy().usage.refresh}</Text>
                        </View>
                      </View>
                    </Scroll>
                  </View>
                </Overlay>
              )}
            </If>
            <If when={menuAt()}>
              {(at) => (
                <Overlay
                  anchor={{ x: at().x, y: at().y }}
                  placement="bottom"
                  align="start"
                  margin={MARGIN}
                  onPressOutside={() => menuAt.set(null)}
                  onCancel={() => menuAt.set(null)}
                >
                  <View role="menu" testID="usage-menu" class="p-[5px] bg-pane border border-line rounded-(--radius-md)" style={{ boxShadow: shadow("menu") }}>
                    <View
                      role="menuitem"
                      testID="usage-menu-hide"
                      onPress={hide}
                      class="cursor-pointer select-none px-[10px] py-[6px] rounded-(--radius-sm) hover:bg-row-hover focus-visible:bg-row-hover"
                    >
                      <Text class="text-[12px] text-ink">{copy().usage.hide}</Text>
                    </View>
                  </View>
                </Overlay>
              )}
            </If>
          </View>
        </Overlay>
      </If>
      <If when={usageWidget.open && !visible() && feed.agents !== null && agents().length === 0}>
        <Overlay style={{ right: MARGIN, top: MARGIN, width: CARD_W }} onPressOutside={closeAll} onCancel={closeAll}>
          <View
            testID="usage-card-empty"
            role="region"
            accessibilityLabel={copy().usage.title}
            class="p-[14px] bg-pane border border-line rounded-[12px]"
            style={{ width: CARD_W, boxShadow: shadow("lg") }}
          >
            <Text testID="usage-empty" class="text-[12px] leading-[18px] text-ink-muted">{copy().usage.empty}</Text>
          </View>
        </Overlay>
      </If>
    </>
  );
}
