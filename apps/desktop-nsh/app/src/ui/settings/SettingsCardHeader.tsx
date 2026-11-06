/**
 * The head of a General or Remote access card (`settings/SettingsCardHeader.svelte`): an optional
 * icon, the title over its subtitle, and what sits beside them.
 *
 * Props: `title`; `subtitle`; `icon` (before the title: the caller's icon box); `after` (after the
 * title, still in the left group); `end` (the far end of the head).
 */
import { Text, View, type JSX } from "nsh";

export function SettingsCardHeader(props: {
  title: string;
  subtitle: string;
  icon?: JSX.Element;
  after?: JSX.Element;
  end?: JSX.Element;
  testID?: string;
}) {
  return (
    <View testID={props.testID} class="flex-row items-center justify-between gap-3">
      <View class="flex-row items-center gap-[10px] min-w-0 shrink">
        {props.icon}
        <View class="flex-col min-w-0 shrink">
          <Text role="header" class="text-[14px] font-semibold text-ink leading-[1.25]">
            {props.title}
          </Text>
          <Text class="mt-[2px] text-[12px] text-ink-muted leading-[1.35]">{props.subtitle}</Text>
        </View>
        {props.after}
      </View>
      {props.end}
    </View>
  );
}
