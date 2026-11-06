/**
 * A card of the General, Remote access and About tabs (`settings/SettingsCard.svelte`): the pane
 * colour, a hairline, 16px of room and a 12px gap between its children. Narrow windows lose the
 * shadow and take 15px of padding.
 *
 * Props: `class` (more classes after the card's own); `testID`; `children`.
 */
import { View, type JSX } from "nsh";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";

export function SettingsCard(props: { class?: string; testID?: string; children?: JSX.Element }) {
  return (
    <View
      testID={props.testID}
      class={`flex-col gap-3 bg-pane border border-line rounded-(--radius-lg) ${narrowWindow() ? "p-[15px]" : "px-[18px] py-4"} ${props.class ?? ""}`}
      style={{ boxShadow: narrowWindow() ? undefined : shadow("xs") }}
    >
      {props.children}
    </View>
  );
}
