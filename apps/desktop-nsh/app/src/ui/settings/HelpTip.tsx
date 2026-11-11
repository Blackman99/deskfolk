/**
 * A "?" beside a heading whose explanation would otherwise sit under it as a paragraph
 * (`settings/HelpTip.svelte`). On a desktop, hover or focus shows it; a press pins it until a press
 * elsewhere or Escape. On a phone a tap opens and closes it. It is nsh/base's `HoverCard`, so the
 * bubble floats over the settings body and nothing clips it.
 *
 * Not carried over: the Svelte closed the bubble on any scroll of the page; NSH reports no scroll
 * of an ancestor to a popup, so a pinned tip stays until a press elsewhere or Escape.
 *
 * Props: `text` (what the tip says); `label` (the button's accessible name, e.g. "About Claude
 * Agent"); `testID` (the button's; the bubble is `${testID}-text`, default `help-tip`).
 */
import { platform, signal, Text, View } from "nsh";
import { HoverCard } from "nsh/base";
import { shadow } from "../styles";

export function HelpTip(props: { text: string; label: string; testID?: string }) {
  const id = () => props.testID ?? "help-tip";
  const pinned = signal(false);
  const hovering = signal(false);
  const open = () => pinned() || hovering();
  const close = () => {
    pinned.set(false);
    hovering.set(false);
  };
  return (
    <HoverCard
      open={open()}
      openDelay={0}
      closeDelay={120}
      placement="bottom"
      offset={6}
      margin={8}
      onOpenChange={(e) => {
        if (e.reason === "triggerPress") {
          // Touch screens: a tap opens and closes it.
          if (open()) close();
          else pinned.set(true);
        } else if (e.open) hovering.set(true);
        else if (e.reason === "hover" || e.reason === "focus") hovering.set(false);
        else close();
      }}
      popupClass="max-w-[320px] px-[10px] py-2 border border-line rounded-(--radius-sm) bg-pane"
      popupStyle={{ boxShadow: shadow("md") }}
      trigger={
        <View
          role="button"
          testID={id()}
          accessibilityLabel={props.label}
          accessibilityState={{ expanded: open() }}
          onPress={() => {
            if (!platform.desktop) return;
            if (pinned()) close();
            else pinned.set(true);
          }}
          class={`cursor-pointer select-none w-4 h-4 shrink-0 items-center justify-center rounded-full border ${open() ? "border-ink-muted" : "border-line"}`}
        >
          <Text class={`text-[10px] font-semibold leading-[10px] ${open() ? "text-ink" : "text-ink-muted"}`}>?</Text>
        </View>
      }
    >
      <Text testID={`${id()}-text`} class="text-[12px] font-[450] leading-[1.5] text-ink text-left">
        {props.text}
      </Text>
    </HoverCard>
  );
}
