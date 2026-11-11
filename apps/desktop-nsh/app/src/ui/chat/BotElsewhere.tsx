/**
 * Where else the Bot of a direct is at work (`BotElsewhere.svelte`). Its avatar says it is busy
 * wherever that is; this says where, beside the header, and takes you there: one place is one press,
 * more open a list, the ones waiting on you first. Nothing shows while it works nowhere else. The
 * list is a menu at the pill on a desktop, a sheet from the bottom on a phone.
 */
import { effect, signal, Text, View } from "nsh";
import { Menu, MenuItem } from "nsh/base";
import type { SessionSummary } from "@real-bot/protocol";
import { botWorkPlaces, elsewhereLine, type WorkPlace } from "../../m/sidebar/bot-elsewhere";
import { classifySession } from "../../m/sidebar/session-groups";
import { isWorkingStatus, sessionStatus } from "../../m/sidebar/session-status";
import { sessionTitle } from "../../m/sidebar/session-title";
import { copy, runtime } from "../../runtime";
import { BottomSheet } from "../BottomSheet";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { tip } from "../tip";
import { pulseMotion, rosterLabelsOf, statusLabelsOf } from "./labels";

const PILL: Record<string, string> = {
  waiting_approval: "bg-warn-bg",
  waiting_ask: "bg-purple-bg",
};
const PILL_INK: Record<string, string> = {
  waiting_approval: "text-warn-text",
  waiting_ask: "text-purple-text",
};
const PILL_TINT: Record<string, string> = {
  waiting_approval: "tint-warn-text",
  waiting_ask: "tint-purple-text",
};

/** Where else a Bot is at work besides `here`, as the header reads it: the places, the one line, and the trigger's lead status. */
export function elsewhereState(botId: () => string, here: () => SessionSummary) {
  const snapshot = () => runtime.snapshot;
  const botsById = () => new Map(snapshot().bots.map((b) => [b.id, b] as const));
  const roster = () => rosterLabelsOf(copy());
  const labels = () => statusLabelsOf(copy());
  const places = () => {
    const s = snapshot();
    return botWorkPlaces(botId(), here().id, s.sessions, s.turns, s.approvals, labels(), s.pendingJudgements);
  };
  const alsoHere = () => {
    const s = snapshot();
    return isWorkingStatus(
      sessionStatus(
        here().id,
        s.turns.filter((turn) => turn.bot_id === botId()),
        s.approvals,
        labels(),
        s.pendingJudgements.filter((j) => j.bot_id === botId()),
      ).kind,
    );
  };
  const line = () => elsewhereLine(places(), alsoHere(), botsById(), roster(), copy().sidebar.elsewhere);
  return { botsById, roster, places, line };
}

export function BotElsewhere(props: {
  botId: string;
  /** The conversation on screen, left out of the places. */
  here: SessionSummary;
}) {
  const t = () => copy();
  const { botsById, roster, places, line } = elsewhereState(() => props.botId, () => props.here);
  /** The trigger's colour: waiting on you outranks working, as in the list. */
  const lead = () => places()[0]?.status.kind ?? "idle";
  const open = signal(false);
  const dot = pulseMotion(() => Boolean(places()[0]?.status.isBusy), 1800);

  const kindLabel = (place: WorkPlace) => {
    const kind = classifySession(place.session);
    return kind === "group" ? t().sidebar.groups : kind === "bot-bot" ? t().sidebar.botBot : t().sidebar.youBot;
  };
  const go = (place: WorkPlace) => {
    open.set(false);
    void runtime.selectSession(place.session.id);
  };
  // Done everywhere else meanwhile: the list goes with it.
  effect(() => {
    if (places().length < 2) open.set(false);
  });

  const row = (place: WorkPlace) => (
    <>
      <Text class="text-[11px] text-ink-muted">{kindLabel(place)}</Text>
      <Text class="flex-1 min-w-0 text-[13px] text-ink line-clamp-1">{sessionTitle(place.session, botsById(), roster())}</Text>
      <Text class={`text-[12px] font-semibold ${PILL_INK[place.status.kind] ?? "text-brand"}`}>{place.status.label}</Text>
    </>
  );

  const pill = () => (
    <View
      role="button"
      testID="elsewhere-trigger"
      accessibilityLabel={line() ?? ""}
      tooltip={tip(line() ?? "")}
      accessibilityState={{ expanded: places().length > 1 ? open() : undefined }}
      onPress={() => {
        if (places().length === 1) go(places()[0]!);
        else if (narrowWindow()) open.set(!open());
      }}
      class={`cursor-pointer select-none flex-row items-center gap-[6px] min-w-0 h-[26px] pl-[10px] pr-[8px] rounded-full active:scale-[0.97] ${PILL[lead()] ?? "bg-accent-tint"}`}
    >
      <View class={`shrink-0 w-[6px] h-[6px] rounded-full ${lead() === "waiting_approval" ? "bg-warn-text" : lead() === "waiting_ask" ? "bg-purple-text" : "bg-brand"}`} style={{ opacity: dot.opacity }} accessible={false} />
      <Text testID="elsewhere-text" class={`min-w-0 shrink text-[12px] font-semibold line-clamp-1 ${PILL_INK[lead()] ?? "text-brand"}`}>{line()}</Text>
      <Icon name={places().length > 1 ? "chevron-down" : "chevron-right"} size={12} class={PILL_TINT[lead()] ?? "tint-brand"} />
    </View>
  );

  return (
    <If when={line()}>
      <View testID="elsewhere" class="min-w-0">
        <If
          when={places().length > 1 && !narrowWindow()}
          else={pill()}
        >
          <Menu
            open={open()}
            onOpenChange={(e) => open.set(e.open)}
            placement="bottom"
            align="start"
            offset={6}
            popupClass="min-w-[240px] max-w-[360px] p-[4px] bg-pane border border-line rounded-(--radius-md)"
            popupStyle={{ boxShadow: shadow("menu") }}
            trigger={pill()}
          >
            <Each of={places()} key={(p) => p.session.id}>
              {(place) => (
                <MenuItem
                  testID={`elsewhere-place-${place().session.id}`}
                  accessibilityLabel={sessionTitle(place().session, botsById(), roster())}
                  onSelect={() => go(place())}
                  class="cursor-pointer select-none flex-row items-baseline gap-[8px] px-[10px] py-[7px] rounded-(--radius-sm) hover:bg-chip focus-visible:bg-chip"
                >
                  {row(place())}
                </MenuItem>
              )}
            </Each>
          </Menu>
        </If>
        <If when={open() && places().length > 1 && narrowWindow()}>
          <BottomSheet title={t().sidebar.elsewhere.menu} closeLabel={t().common.close} onClose={() => open.set(false)}>
            <View role="menu" accessibilityLabel={t().sidebar.elsewhere.menu}>
              <Each of={places()} key={(p) => p.session.id}>
                {(place) => (
                  <View
                    role="menuitem"
                    testID={`elsewhere-place-${place().session.id}`}
                    accessibilityLabel={sessionTitle(place().session, botsById(), roster())}
                    onPress={() => go(place())}
                    class="cursor-pointer select-none flex-row items-baseline gap-[8px] w-full p-[12px] rounded-(--radius-sm) active:bg-chip"
                  >
                    {row(place())}
                  </View>
                )}
              </Each>
            </View>
          </BottomSheet>
        </If>
      </View>
    </If>
  );
}
