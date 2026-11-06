/**
 * Prompts one line each (`settings/PromptRowList.svelte`): title, what it is, who edited it and any
 * answers that did not read. One card, a hairline between rows. The Svelte laid the three columns
 * out on a shared grid; here the title takes a fixed share so the rows still line up. `stacked`
 * (and a narrow window) put the title over one line of what it is, as on a phone.
 *
 * Props: `items`; `ui` (the language the titles are in); `botNames` (Bots by id, to name the one
 * that edited a prompt); `onOpen(item)`; `stacked`. Each row's `testID` is `prompt-${id}`.
 */
import type { Locale, PromptSummary } from "@real-bot/protocol";
import { Text, View } from "nsh";
import { copy } from "../../runtime";
import { failuresOf, promptChip } from "../../m/settings/prompts-view.ts";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { tip } from "../tip";

/** A chip's classes by tone (`.prompts-chip.is-*`). */
export function chipClass(tone: string): { box: string; text: string } {
  if (tone === "edited") return { box: "bg-accent-tint border-accent-border", text: "text-brand" };
  if (tone === "conflict" || tone === "warn") return { box: "bg-warn-bg border-warn-line", text: "text-warn-text" };
  return { box: "bg-chip border-line", text: "text-ink-muted" };
}

export function PromptChip(props: { tone: string; label: string; testID?: string }) {
  const k = () => chipClass(props.tone);
  return (
    <View testID={props.testID} class={`px-[7px] py-px border rounded-(--radius-full) ${k().box}`}>
      <Text class={`text-[11px] font-semibold ${k().text}`}>{props.label}</Text>
    </View>
  );
}

export function PromptRowList(props: {
  items: readonly PromptSummary[];
  ui: Locale;
  botNames: ReadonlyMap<string, string>;
  onOpen: (item: PromptSummary) => void;
  stacked?: boolean;
}) {
  const c = () => copy().prompts;
  const stacked = () => props.stacked === true || narrowWindow();
  const row = (item: PromptSummary, index: number) => {
    const chip = promptChip(item, props.botNames, c());
    const failures = failuresOf(item);
    return (
      <View
        role="button"
        testID={`prompt-${item.id}`}
        accessibilityLabel={item.title[props.ui]}
        onPress={() => props.onOpen(item)}
        class={`group gap-[10px] pl-3 pr-[10px] hover:bg-row-hover focus-visible:border focus-visible:border-brand ${index > 0 ? "border-t border-line-subtle" : ""} ${stacked() ? "flex-row items-center py-[10px]" : "flex-row items-center py-[9px] gap-[14px]"}`}
      >
        <View class={`min-w-0 shrink grow ${stacked() ? "flex-col gap-[2px]" : "flex-row items-center gap-[14px]"}`}>
          <Text class={`min-w-0 text-[13px] font-semibold text-ink line-clamp-1 ${stacked() ? "" : "w-[36%] shrink-0"}`}>{item.title[props.ui]}</Text>
          <View class="min-w-0 shrink grow" tooltip={tip(item.summary[props.ui])}>
            <Text class="text-[12px] text-ink-muted line-clamp-1">{item.summary[props.ui]}</Text>
          </View>
        </View>
        <View class="flex-row items-center justify-end gap-[6px] shrink-0">
          <If when={chip.tone !== "default"}>
            <PromptChip testID={`prompt-${item.id}-chip`} tone={chip.tone} label={chip.label} />
          </If>
          <If when={failures > 0}>
            <PromptChip testID={`prompt-${item.id}-failures`} tone="warn" label={c().parseFailures(failures)} />
          </If>
          <Icon name="chevron-right" size={16} class="tint-ink-muted opacity-[0.6] group-hover:opacity-100" />
        </View>
      </View>
    );
  };
  return (
    <View
      role="list"
      class="flex-col border border-line rounded-(--radius-md) bg-pane overflow-hidden"
      style={{ boxShadow: shadow("xs") }}
    >
      {() => props.items.map(row)}
    </View>
  );
}
