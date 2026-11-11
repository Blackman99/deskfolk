/**
 * One setting on a line (`settings/SettingsRow.svelte`): its name and what it does on the left, its
 * control on the right. At 540px or less the control goes under the text.
 *
 * Props: `title`; `desc`; `titleId` (the Svelte id for `aria-labelledby`; here the title's
 * `testID`, since NSH has no label-by link); `titleAfter` (on the title's line, after it: a short
 * mark that must not make the row taller); `notes` (more under the description); `children` (the
 * control); `last` (the row is the card's last: no rule under it, 2px of room instead of 12; the
 * Svelte `:last-child`, which NSH has no selector for, so the caller says it).
 */
import { Text, View, type JSX } from "nsh";
import { widthAtMost } from "../../platform/viewport";

export function SettingsRow(props: {
  title: string;
  desc: string;
  titleId?: string;
  titleAfter?: JSX.Element;
  notes?: JSX.Element;
  last?: boolean;
  testID?: string;
  children?: JSX.Element;
}) {
  const stacked = () => widthAtMost(540);
  const title = () => (
    <Text testID={props.titleId} class="text-[13px] font-medium text-ink leading-[1.3]">
      {props.title}
    </Text>
  );
  return (
    <View
      testID={props.testID}
      class={`flex-row justify-between gap-4 px-[2px] pt-3 ${props.last ? "pb-[2px]" : "pb-3 border-b border-line-subtle"} ${stacked() ? "flex-col items-start gap-2" : "items-center"}`}
    >
      <View class="flex-col gap-[2px] min-w-0 shrink grow">
        <If when={props.titleAfter} else={title()}>
          <View class="flex-row items-center gap-[6px] min-w-0">
            {title()}
            {props.titleAfter}
          </View>
        </If>
        <Text class="text-[12px] text-ink-muted leading-[1.35]">{props.desc}</Text>
        {props.notes}
      </View>
      <View class={`flex-row items-center shrink-0 ${stacked() ? "w-full justify-end" : ""}`}>{props.children}</View>
    </View>
  );
}
