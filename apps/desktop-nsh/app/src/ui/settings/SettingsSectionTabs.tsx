/**
 * A settings page's sections as tabs along its top (`settings/SettingsSectionTabs.svelte`), one
 * open under them (Models, Prompts). The row scrolls sideways when the tabs outrun the window
 * rather than push the dialog wider. Each tab's `testID` is `${id}-tab-${section}` (the Svelte
 * element id); the page draws its own panel.
 *
 * Props: `id`; `sections` (the ids); `active`; `label(of)`; `count(of)` (the number on a tab; a tab
 * with 0 shows none); `warn(of)` (that number in the warning colour); `icon(of, size, active)`
 * (the caller's icon at 15; `active` lets it take the brand tint on the open tab, which Svelte did
 * through the parent's `color`); `ariaLabel`; `onPick(of)`.
 */
import { Scroll, Text, View, type JSX } from "nsh";
import { Tab, Tabs } from "nsh/base";

export function SettingsSectionTabs<S extends string>(props: {
  id: string;
  sections: readonly S[];
  active: S;
  label: (of: S) => string;
  count?: (of: S) => number;
  warn?: (of: S) => boolean;
  icon: (of: S, size: number, active: boolean) => JSX.Element;
  ariaLabel: string;
  onPick: (of: S) => void;
}) {
  const number = (of: S) => props.count?.(of) ?? 0;
  return (
    <Scroll horizontal scrollbar={false} class="shrink-0 bg-pane border-b border-line">
      <Tabs class="flex-row items-stretch gap-[6px] px-4">
        <Each of={props.sections} key={(item) => item}>
          {(of) => (
            <Tab
              testID={`${props.id}-tab-${of()}`}
              selected={props.active === of()}
              onPress={() => props.onPick(of())}
              class="group shrink-0 flex-row items-center gap-[7px] min-h-[44px] px-2 pt-[10px] pb-[8px] border-b-2 border-transparent selected:border-brand focus-visible:border-brand"
            >
              {props.icon(of(), 15, props.active === of())}
              <Text class="text-[13px] font-medium line-clamp-1 text-ink-secondary group-hover:text-ink group-selected:text-brand group-selected:font-semibold">
                {props.label(of())}
              </Text>
              <If when={number(of()) > 0}>
                <View
                  testID={`${props.id}-tab-${of()}-count`}
                  class={`min-w-[18px] px-[5px] rounded-(--radius-full) items-center ${
                    props.warn?.(of()) ? "bg-warn-bg" : props.active === of() ? "bg-accent-tint" : "bg-chip"
                  }`}
                >
                  <Text
                    class={`text-[11px] font-semibold leading-4 ${
                      props.warn?.(of()) ? "text-warn-text" : props.active === of() ? "text-brand" : "text-ink-secondary"
                    }`}
                  >
                    {String(number(of()))}
                  </Text>
                </View>
              </If>
            </Tab>
          )}
        </Each>
      </Tabs>
    </Scroll>
  );
}
