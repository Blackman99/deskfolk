/**
 * Small pieces the job view's ticket surfaces share: an actor's face (the 15–16px round avatar on a
 * rail row, a card and the inspector), the status dot and its colours, the quiet text link a card
 * and the inspector put under a ticket, and the card's status menu (a pill: the Svelte board's
 * `Select` dressed as a pill). Pure and presentational.
 */
import { Image, Text, View, signal } from "nsh";
import { Menu, MenuItem } from "nsh/base";
import type { TicketStatus, TicketWithArtifacts } from "@real-bot/protocol";
import type { ActorFace } from "../../m/overlays/plan-board.ts";
import { statusOptionsFor } from "../../m/overlays/ticket-labels.ts";
import { copy } from "../../runtime";
import { BottomSheet, SheetItem } from "../BottomSheet";
import { Icon, type IconName } from "../Icon";
import { narrowWindow } from "../Modal";
import { cssColor, shadow } from "../styles";
import { tip } from "../tip";

/** A status's own text colour: todo and parked are quiet, doing is the interaction colour. */
export const STATUS_TEXT: Record<TicketStatus, string> = {
  todo: "text-ink-muted",
  doing: "text-brand",
  review: "text-purple-text",
  done: "text-ok-text",
  parked: "text-ink-muted",
};

/** The dot before a status, in the column's colour. */
export const STATUS_DOT: Record<TicketStatus, string> = {
  todo: "bg-ink-muted",
  doing: "bg-brand",
  review: "bg-purple-text",
  done: "bg-ok-text",
  parked: "bg-ink-muted",
};

/** A round avatar: the Bot's picture or its letter on its palette; `face` null draws nothing. */
export function ActorDot(props: { face: ActorFace; size: number; font: number; class?: string; testID?: string; tooltip?: string }) {
  const palette = () => props.face.palette;
  return (
    <View
      testID={props.testID}
      tooltip={props.tooltip ? tip(props.tooltip) : undefined}
      class={`shrink-0 rounded-full border border-line overflow-hidden items-center justify-center ${props.class ?? ""}`}
      style={{
        width: props.size,
        height: props.size,
        backgroundColor: palette() ? cssColor(palette()!.bg) : undefined,
        borderColor: palette() ? cssColor(palette()!.border) : undefined,
      }}
    >
      <If
        when={props.face.src}
        else={
          <Text class="font-bold" style={{ fontSize: props.font, color: palette() ? cssColor(palette()!.text) : undefined }}>
            {props.face.letter}
          </Text>
        }
      >
        {(src) => <Image src={src()} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
      </If>
    </View>
  );
}

/** A status as plain words with its dot: the rail's stage, a card's status without an api. */
export function StageText(props: { status: TicketStatus; label: string; testID?: string; size?: number }) {
  return (
    <View testID={props.testID} class="shrink-0 flex-row items-center gap-1">
      <View class={`w-[6px] h-[6px] rounded-full ${STATUS_DOT[props.status]}`} />
      <Text class={`font-semibold ${STATUS_TEXT[props.status]}`} style={{ fontSize: props.size ?? 11 }}>
        {props.label}
      </Text>
    </View>
  );
}

/** A quiet text link under a ticket (「N 个文件」, 「在轨迹里看」); lights on hover. */
export function TicketLink(props: {
  label: string;
  icon?: IconName;
  title?: string;
  disabled?: boolean;
  testID?: string;
  size?: number;
  onPress: () => void;
}) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      tooltip={props.title ? tip(props.title) : undefined}
      disabled={props.disabled}
      onPress={props.onPress}
      class="group flex-row items-center gap-1 px-1 py-[3px] rounded-(--radius-xs) hover:bg-accent-tint disabled:opacity-[0.5]"
    >
      <If when={props.icon}>{(icon) => <Icon name={icon()} size={12} class="tint-ink-muted group-hover:tint-brand" />}</If>
      <Text class="font-medium text-ink-muted group-hover:text-brand" style={{ fontSize: props.size ?? 11 }}>
        {props.label}
      </Text>
    </View>
  );
}

/**
 * The card's status menu: a pill of the stage's dot, name and a chevron; the choices open under it
 * (a desktop menu; a phone's sheet from the bottom). Picking the status it has is no change.
 */
export function StatusPill(props: { ticket: TicketWithArtifacts; label: string; disabled?: boolean; onChange: (status: string) => void }) {
  const open = signal(false);
  const options = () => statusOptionsFor(props.ticket, copy());
  const pick = (value: string) => {
    open.set(false);
    if (value !== props.ticket.status) props.onChange(value);
  };
  const trigger = (
    <View
      role="button"
      testID="ticket-status"
      accessibilityLabel={copy().plan.changeStatus}
      accessibilityState={{ expanded: open(), disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => {
        if (narrowWindow()) open.set(!open());
      }}
      class={`shrink-0 flex-row items-center gap-1 pl-[7px] pr-1 py-[2px] rounded-full border border-transparent hover:bg-line-subtle hover:border-line disabled:opacity-[0.5] ${STATUS_TEXT[props.ticket.status]}`}
    >
      <View class={`w-[6px] h-[6px] rounded-full ${STATUS_DOT[props.ticket.status]}`} />
      <Text class={`text-[11px] font-semibold ${STATUS_TEXT[props.ticket.status]}`}>{props.label}</Text>
      <Icon name="chevron-down" size={12} class="tint-ink-muted" />
    </View>
  );
  return (
    <View class="shrink-0 relative">
      <If when={!narrowWindow()} else={trigger}>
        <Menu
          open={open()}
          placement="bottom"
          align="end"
          offset={4}
          onOpenChange={(e) => open.set(e.open)}
          trigger={trigger}
          popupClass="min-w-[132px] p-1 bg-pane border border-line rounded-(--radius-md)"
          popupStyle={{ boxShadow: shadow("menu") }}
        >
          <Each of={options()} key={(option) => option.value}>
            {(option) => (
              <MenuItem
                testID={`ticket-status-${option().value}`}
                accessibilityLabel={option().label}
                onSelect={() => pick(option().value)}
                class="px-[10px] py-[6px] rounded-(--radius-sm) hover:bg-chip focus:bg-chip"
              >
                <Text class={`text-[12px] ${option().value === props.ticket.status ? "font-semibold text-brand" : "text-ink"}`}>{option().label}</Text>
              </MenuItem>
            )}
          </Each>
        </Menu>
      </If>
      <If when={narrowWindow() && open()}>
        <BottomSheet title={copy().plan.changeStatus} closeLabel={copy().common.close} onClose={() => open.set(false)}>
          <View role="menu" accessibilityLabel={copy().plan.changeStatus}>
            <Each of={options()} key={(option) => option.value}>
              {(option) => (
                <SheetItem
                  role="menuitem"
                  testID={`ticket-status-${option().value}`}
                  label={option().label}
                  active={option().value === props.ticket.status}
                  onPress={() => pick(option().value)}
                />
              )}
            </Each>
          </View>
        </BottomSheet>
      </If>
    </View>
  );
}
