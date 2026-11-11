/** The ledger's few icons under the names its header uses (`SpendIcon.svelte`). */
import { Icon, type IconName } from "../Icon";

export type SpendIconName = "back" | "refresh" | "chevron" | "filter" | "close" | "arrow" | "coins" | "spark" | "calendar" | "info";

const NAMES: Record<string, IconName> = {
  back: "chevron-left",
  refresh: "refresh",
  chevron: "chevron-down",
  filter: "filter",
  close: "x",
  coins: "coins",
  spark: "sparkle",
  calendar: "calendar",
  info: "info",
};

export function SpendIcon(props: {
  name: SpendIconName;
  size?: 12 | 16 | 20;
  /** A `tint-*` class, and `animate-spin` for the refresh while it loads. */
  class?: string;
}) {
  return <Icon name={NAMES[props.name] ?? "arrow-right"} size={props.size} class={props.class} />;
}
