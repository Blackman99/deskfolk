/**
 * On a phone, a settings page's sections as a list (`settings/SettingsSectionList.svelte`), each
 * with a line on what it holds (Models, Prompts); a row opens that section as a page of its own,
 * one level deeper. The rows are one rounded group with a hairline between them, which starts
 * after the icon.
 *
 * Props: `sections` (the ids); `label(of)`; `summary(of)`; `icon(of, size)` (the caller's icon,
 * drawn at 19); `ariaLabel`; `onPick(of)`. Each row's `testID` is `section-<id>`.
 */
import { Text, View, type JSX } from "nsh";
import { Icon } from "../Icon";

export function SettingsSectionList<S extends string>(props: {
  sections: readonly S[];
  label: (of: S) => string;
  summary: (of: S) => string;
  icon: (of: S, size: number) => JSX.Element;
  ariaLabel: string;
  onPick: (of: S) => void;
  testID?: string;
}) {
  return (
    <View role="list" testID={props.testID} accessibilityLabel={props.ariaLabel} class="flex-col rounded-(--radius-lg) overflow-hidden bg-pane">
      <Each of={props.sections} key={(item) => item}>
        {(of, index) => (
          <View
            role="button"
            testID={`section-${of()}`}
            accessibilityLabel={props.label(of())}
            onPress={() => props.onPick(of())}
            class="cursor-pointer select-none relative flex-row items-center gap-3 w-full min-h-16 px-[14px] py-[10px] bg-pane active:bg-row-hover"
          >
            <If when={index() > 0}>
              <View class="absolute left-[45px] right-0 top-0 h-px bg-line" />
            </If>
            {props.icon(of(), 19)}
            <View class="flex-col gap-[3px] min-w-0 shrink grow">
              <Text class="text-[15px] font-medium text-ink leading-[1.3]">{props.label(of())}</Text>
              <Text class="text-[13px] text-ink-muted leading-[1.35] line-clamp-1">
                {props.summary(of())}
              </Text>
            </View>
            <Icon name="chevron-right" size={16} class="tint-ink-muted" />
          </View>
        )}
      </Each>
    </View>
  );
}
