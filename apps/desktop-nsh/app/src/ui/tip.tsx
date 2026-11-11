/**
 * The app's tooltip bubble (the pointer's hint on desktops), given as an element's `tooltip` prop:
 * `<View tooltip={tip("Pin")}>`. Dark ink on a pale bubble, 12pt, as the messenger's `title`s read.
 */
import { Text } from "nsh";
import { Tooltip } from "nsh/base";

export function tip(label: string) {
  return (
    <Tooltip delay={500} class="rounded-[6px] bg-ink px-[8px] py-[4px]">
      <Text class="text-[12px] text-pane">{label}</Text>
    </Tooltip>
  );
}
