/**
 * The enabled row of the skill, memory and routine editors (`EditorSwitchRow.svelte`): what the
 * switch does on the left, the switch (the caller's `children`) on the right.
 */
import { Text, View, type JSX } from "nsh";

export function EditorSwitchRow(props: { title: string; desc: string; testID?: string; children: JSX.Element }) {
  return (
    <View testID={props.testID} class="flex-row items-center justify-between gap-3 min-h-[40px]">
      <View class="flex-1 min-w-0 gap-[2px]">
        <Text class="text-[14px] font-semibold text-ink">{props.title}</Text>
        <Text class="text-[12px] text-ink-muted">{props.desc}</Text>
      </View>
      {props.children}
    </View>
  );
}
