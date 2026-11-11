/** Which Bot an editor sheet's item belongs to (`EditorOwnerBadge.svelte`): the skill, memory and routine sheets all show it. */
import { Text, View } from "nsh";
import { Icon } from "../Icon";
import { tip } from "../tip";

export function EditorOwnerBadge(props: { name: string; /** The hover text. */ title: string; testID?: string }) {
  return (
    <View
      testID={props.testID}
      tooltip={tip(props.title)}
      class="flex-row items-center gap-[5px] px-2 py-[2px] rounded-full bg-sidebar-bg border border-line shrink-0"
    >
      <Icon name="user" size={12} class="tint-ink-muted" />
      <Text class="text-[12px] font-medium text-ink-muted">{props.name}</Text>
    </View>
  );
}
