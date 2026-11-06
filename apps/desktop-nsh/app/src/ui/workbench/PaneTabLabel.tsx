/**
 * Every tab that is not a live conversation: its kind's picture before the name (`PaneTabLabel.svelte`).
 * The pictures are the ones the app opens these from: the tools menu's terminal, calendar, ledger and
 * usage, the workspace button's folder, the header's flow board.
 */
import { Text, View } from "nsh";
import type { IconName } from "../Icon";
import { Icon } from "../Icon";
import { tip } from "../tip";
import type { PaneKind } from "../../m/workbench/pane-content.ts";

/**
 * A kind's picture. A preview is a parcel, apart from the workspace's folder. A conversation that is
 * gone has none of these and gets a speech bubble: the tab stays until it is closed.
 */
const ICON_NAMES: Partial<Record<PaneKind, IconName>> = {
  terminal: "terminal",
  workspace: "folder",
  routines: "calendar",
  spend: "dollar",
  usage: "gauge",
  roles: "nodes",
  trace: "hierarchy",
  preview: "package",
  map: "minimap",
};

export function PaneTabLabel(props: {
  /** Null for a tab this build cannot read, which keeps its bare name. */
  kind: PaneKind | null;
  title: string;
}) {
  return (
    <View testID="pane-tab" tooltip={tip(props.title)} class="flex-row items-center gap-[6px] min-w-0 max-w-full">
      <If when={props.kind}>
        {(kind) => (
          <View testID={`pane-tab-icon-${kind()}`} accessible={false} class="items-center justify-center w-4 h-4 shrink-0">
            <Icon name={ICON_NAMES[kind()] ?? "message"} size={16} />
          </View>
        )}
      </If>
      <Text testID="pane-tab-name" class="min-w-0 shrink line-clamp-1 text-[12px] text-tab-idle-ink group-selected:text-ink">
        {props.title}
      </Text>
    </View>
  );
}
