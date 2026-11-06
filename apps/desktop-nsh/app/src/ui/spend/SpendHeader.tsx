/**
 * The ledger's header (`SpendHeader.svelte`): title, the period picker and Refresh, the custom
 * dates, the filter chips, and the two sections as underline tabs. The ledger and the section are
 * the view's; this reads the ledger and calls back. With a tab focused, Left / Right move to the
 * other tab and Home / End to the first / last (`sectionKey` of `SpendView.svelte`), the focus going
 * with them; NSH views take no key events, so the keys are bound through `keymap` while a tab has
 * the focus (as the model ladder's grips do).
 */
import { Text, View, effect, keymap, signal, untracked, windowSize, type ViewRef } from "nsh";
import { DatePicker } from "nsh/base";
import type { MessengerApi } from "../../m/messenger-api.ts";
import type { SpendCopy } from "../../m/spend/spend-copy.ts";
import type { SpendLedger } from "../../m/spend/spend-ledger.svelte.ts";
import type { SpendRangeIssue, SpendRangePreset } from "../../m/spend/spend-query.ts";
import { IconButton } from "../IconButton";
import { narrowWindow } from "../Modal";
import { Select } from "../Select";
import { tip } from "../tip";
import { SpendIcon } from "./SpendIcon";

const RANGES: SpendRangePreset[] = ["today", "last7", "last30", "all", "custom"];
const SECTIONS = ["overview", "details"] as const;

export function SpendHeader(props: {
  copy: SpendCopy;
  ledger: SpendLedger;
  api: MessengerApi | null;
  section: "overview" | "details";
  switchSection: (next: "overview" | "details") => void;
  /** The narrow page's way out. A desktop pane leaves this unset and has no back button. */
  onClose?: () => void;
  backLabel?: string;
  /** The ledger is narrower than 620 points (its container query); defaults to a phone-sized window. */
  narrow?: boolean;
}) {
  const narrow = () => props.narrow ?? narrowWindow();

  /** The tab that has the keyboard focus, if any. */
  const tabFocus = signal<(typeof SECTIONS)[number] | null>(null);
  const tabs: Partial<Record<(typeof SECTIONS)[number], ViewRef>> = {};
  effect(() => {
    const current = tabFocus();
    if (current === null) return;
    const go = (next: (typeof SECTIONS)[number]) => {
      props.switchSection(next);
      tabFocus.set(next);
      tabs[next]?.focus();
    };
    const other = current === "overview" ? "details" : "overview";
    const off = [
      keymap.bind("left", () => go(other), { when: "always" }),
      keymap.bind("right", () => go(other), { when: "always" }),
      keymap.bind("home", () => go("overview"), { when: "always" }),
      keymap.bind("end", () => go("details"), { when: "always" }),
    ];
    return () => off.forEach((fn) => fn());
  });
  const copy = () => props.copy;

  function rangeMessage(issue: SpendRangeIssue): string {
    if (issue === "blank") return copy().rangeBlank;
    if (issue === "reversed") return copy().rangeReversed;
    return copy().rangeInvalid;
  }

  const date = (which: "customFrom" | "customTo", label: string, testID: string) => {
    const value = () => props.ledger.view[which] || null;
    return (
      <View class={`min-w-0 flex-1 gap-1 ${narrow() ? "" : "flex-row items-center gap-2"}`}>
        <Text class="text-[12px] font-medium text-ink-muted shrink-0">{label}</Text>
        <DatePicker
          value={value()}
          accessibilityLabel={label}
          onChange={(e) => {
            props.ledger.view[which] = typeof e.value === "string" ? e.value.slice(0, 10) : "";
          }}
          trigger={
            <View
              testID={testID}
              role="button"
              accessibilityLabel={label}
              class={`flex-row items-center gap-2 w-full px-[10px] border rounded-(--radius-sm) bg-input-bg hover:border-line-hover ${narrow() ? "h-[40px]" : "h-[38px]"} ${props.ledger.rangeIssue ? "border-danger" : "border-line"}`}
            >
              <SpendIcon name="calendar" size={12} />
              <Text class="flex-1 text-[12px] text-ink">{value() ?? copy().dash}</Text>
            </View>
          }
        />
      </View>
    );
  };

  return (
    <View
      testID="spend-header"
      class={`bg-pane relative shrink-0 border-b border-line ${narrow() ? "pt-[6px] px-[6px]" : "pt-4 px-6"}`}
    >
      <View class={`flex-row items-center justify-between min-w-0 ${narrow() ? "gap-1 min-h-[48px]" : "gap-4"}`}>
        <View class={`flex-row items-center flex-1 min-w-0 ${narrow() ? "gap-[2px]" : "gap-3"} ${narrow() && !props.onClose ? "pl-2" : ""}`}>
          <If when={props.onClose}>
            <IconButton testID="spend-back" icon="chevron-left" label={props.backLabel ?? ""} size="lg" onPress={() => props.onClose?.()} />
          </If>
          <View class="flex-1 min-w-0">
            <Text role="header" class={`text-ink ${narrow() ? "text-[17px] font-semibold" : "text-[20px] font-semibold"}`}>
              {copy().title}
            </Text>
            <If when={!narrow()}>
              <Text class="mt-[2px] text-[12px] text-ink-muted">{copy().subtitle}</Text>
            </If>
          </View>
        </View>

        <View class={`flex-row items-center shrink-0 ${narrow() ? "gap-[2px]" : "gap-[10px]"}`}>
          <View class="w-[150px]">
            <Select
              testID="spend-period"
              size="sm"
              ariaLabel={copy().period}
              value={props.ledger.view.range}
              options={RANGES.map((range) => ({ value: range, label: copy().ranges[range] }))}
              onChange={(value) => props.ledger.setRange(value as SpendRangePreset)}
            />
          </View>
          <View
            testID="spend-refresh"
            role="button"
            tooltip={tip(copy().refresh)}
            accessibilityLabel={copy().refresh}
            disabled={props.ledger.loading || !!props.ledger.rangeIssue || !props.api}
            onPress={() => props.ledger.refresh()}
            class={`group items-center justify-center shrink-0 disabled:opacity-[0.4] hover:bg-line-subtle ${narrow() ? "w-[44px] h-[44px] rounded-full" : "w-[38px] h-[38px] border border-line rounded-(--radius-sm) bg-pane hover:border-line-hover"}`}
          >
            <SpendIcon name="refresh" class={`${props.ledger.loading ? "animate-spin " : ""}tint-ink-muted group-hover:tint-ink`} />
          </View>
        </View>
      </View>

      <If when={props.ledger.view.range === "custom"}>
        <View testID="spend-custom-dates" class={`gap-2 ${narrow() ? "mt-2 mb-[10px] px-2" : "mt-3"}`}>
          <View class={`flex-row items-center gap-3 ${narrow() ? "" : "max-w-[520px]"}`}>
            {date("customFrom", copy().from, "spend-from")}
            <If when={!narrow()}>
              <Text class="text-[13px] text-ink-muted" accessible={false}>
                →
              </Text>
            </If>
            {date("customTo", copy().to, "spend-to")}
          </View>
          <If when={props.ledger.rangeIssue}>
            {(issue) => (
              <Text testID="spend-range-error" role="alert" class="text-[12px] font-medium text-danger-text">
                {rangeMessage(issue())}
              </Text>
            )}
          </If>
        </View>
      </If>

      <If when={props.ledger.chips.length > 0}>
        <View testID="spend-chips" accessibilityLabel={copy().filters} class={`flex-row flex-wrap items-center gap-2 pt-[10px] pb-1 ${narrow() ? "px-2" : ""}`}>
          <SpendIcon name="filter" size={12} />
          <Each of={props.ledger.chips} key={(chip) => chip.key}>
            {(chip) => (
              <View
                testID={`spend-chip-${chip().key}`}
                role="button"
                accessibilityLabel={copy().clearFilter(chip().label)}
                onPress={() => chip().clear()}
                class={`group flex-row items-center gap-[6px] max-w-[320px] px-[10px] border border-accent-border rounded-full bg-accent-tint hover:opacity-80 ${narrow() ? "min-h-[44px] py-[6px] px-3" : "min-h-[32px] py-1"}`}
              >
                <Text class="shrink text-[12px] font-medium text-brand line-clamp-1">{chip().label}</Text>
                <SpendIcon name="close" size={12} class="tint-brand opacity-80" />
              </View>
            )}
          </Each>
          <View
            testID="spend-clear-all"
            role="button"
            onPress={() => {
              props.ledger.drill = {};
            }}
            class="group flex-row items-center min-h-[32px] px-1"
          >
            <Text class="text-[12px] font-medium text-ink-muted group-hover:text-ink">{copy().clearAll}</Text>
          </View>
        </View>
      </If>

      <View class={`flex-row justify-between items-end gap-4 ${narrow() ? "mt-[2px]" : "mt-[10px]"}`}>
        <View role="tablist" accessibilityLabel={copy().title} class={`flex-row ${narrow() ? "flex-1" : "gap-[22px]"}`}>
          {SECTIONS.map((name) => (
            <View
              testID={`spend-tab-${name}`}
              role="tab"
              focusable
              ref={(node: ViewRef) => (tabs[name] = node)}
              accessibilityState={{ selected: props.section === name }}
              onFocus={() => tabFocus.set(name)}
              onBlur={() => untracked(() => tabFocus() === name && tabFocus.set(null))}
              onPress={() => {
                tabFocus.set(name);
                props.switchSection(name);
              }}
              class={`items-center border-b-2 ${narrow() ? "flex-1 justify-center min-h-[44px] pt-[10px] pb-2" : "min-h-[36px] pt-2 pb-[7px] px-[2px] justify-center"} ${props.section === name ? "border-brand" : "border-transparent"}`}
            >
              <Text
                class={`${narrow() ? "text-[14px]" : "text-[13px]"} ${props.section === name ? `font-semibold ${narrow() ? "text-brand" : "text-ink"}` : `font-medium ${narrow() ? "text-ink-secondary" : "text-ink-muted"}`}`}
              >
                {name === "overview" ? copy().overview : copy().details}
              </Text>
            </View>
          ))}
        </View>
        <If when={!narrow() || windowSize().width > 360}>
          <Text
            testID="spend-update-status"
            class={`text-[11px] text-ink-muted ${narrow() ? "absolute right-2 -top-[14px]" : "self-center"}`}
            style={narrow() ? { pointerEvents: "none" } : undefined}
          >
            {props.ledger.loading && props.ledger.summary ? copy().refreshing : ""}
          </Text>
        </If>
      </View>
    </View>
  );
}
