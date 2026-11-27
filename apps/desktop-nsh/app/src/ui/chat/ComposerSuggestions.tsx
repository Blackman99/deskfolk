/**
 * The row of drafted next lines above the box (`ComposerSuggestions.svelte`): one chip each, picking
 * one drafts it into the box; with none, the note that nothing came out. The chips stay one row and
 * scroll sideways (a trackpad scrolls natively; a mouse wheel over the row turns vertical ticks
 * sideways via `onWheel`). The Svelte one fades the edge that has more behind it with a CSS mask;
 * NSH has no mask, so a short gradient of the pane colour is not drawn and the row simply ends at
 * the edge.
 *
 * Also holds `SuggestButton`, the ✨ control shared by both composers' tool rows.
 */
import { platform, Scroll, signal, Text, View, type ScrollRef } from "nsh";
import { onWheel } from "../../platform/wheel";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { tip } from "../tip";

export type ComposerSuggestion = { id: string; label: string; prompt: string };

export function ComposerSuggestions(props: {
  suggestions: readonly ComposerSuggestion[];
  onPickPrompt: (prompt: string) => void;
  /** Narrow / phone docked bottom bar: tighter bottom padding and comfortable touch targets. */
  docked?: boolean;
  /** Reports the scroll bar's laid-out size (stories check it does not collapse to zero height). */
  onLayout?: (size: { width: number; height: number }) => void;
}) {
  let rowRef: ScrollRef | null = null;
  const viewWidth = signal(0);
  const contentWidth = signal(0);
  const scrollX = signal(0);

  /** A trackpad already scrolls the row sideways; a mouse wheel only turns up and down. */
  onWheel(
    () => rowRef,
    (e) => {
      if (Math.abs(e.dy) <= Math.abs(e.dx) || contentWidth() <= viewWidth()) return;
      const max = Math.max(0, contentWidth() - viewWidth());
      const next = Math.max(0, Math.min(max, scrollX() + e.dy));
      scrollX.set(next);
      rowRef?.scrollTo({ x: next, animated: false });
    },
  );

  const padding = () =>
    props.docked
      ? { paddingLeft: platform.desktop ? 10 : 16, paddingRight: platform.desktop ? 10 : 16, paddingTop: 8, paddingBottom: 2 }
      : { paddingLeft: 4, paddingRight: 8, paddingTop: 4, paddingBottom: 10 };

  return (
    <View role="group" accessibilityLabel={copy().chat.suggestNext} class="w-full min-w-0 shrink-0">
      <Scroll
        testID="composer-suggestions"
        horizontal
        scrollbar={false}
        ref={(node) => (rowRef = node as ScrollRef | null)}
        onLayout={(e) => {
          viewWidth.set(e.bounds.size.width);
          props.onLayout?.(e.bounds.size);
        }}
        onScroll={(e) => scrollX.set(e.offset.x)}
        class="w-full min-w-0 shrink-0"
        contentStyle={padding()}
      >
        <View class="flex-row items-center gap-[6px]" onLayout={(e) => contentWidth.set(e.bounds.size.width)}>
          <If
            when={props.suggestions.length > 0}
            else={<Text role="text" testID="suggest-note" class="px-[6px] py-1 text-[12px] text-ink-muted">{copy().composer.suggestNone}</Text>}
          >
            <Each of={props.suggestions} key={(s) => s.id}>
              {(suggestion) => (
                <View
                  role="button"
                  testID="suggest-chip"
                  tooltip={tip(suggestion().prompt)}
                  accessibilityLabel={suggestion().label}
                  onPress={() => props.onPickPrompt(suggestion().prompt)}
                  class={`cursor-pointer select-none shrink-0 justify-center px-[10px] py-1 rounded-full bg-chip border border-line hover:bg-accent-tint hover:border-accent-border group ${props.docked ? "min-h-[30px]" : ""}`}
                >
                  <Text class="text-[12px] font-medium text-ink group-hover:text-brand">{suggestion().label}</Text>
                </View>
              )}
            </Each>
          </If>
        </View>
      </Scroll>
    </View>
  );
}

/** The ✨ button on both composers' tool rows: one press drafts next lines, pressing again puts them away. */
export function SuggestButton(props: {
  sizeClass: string;
  label: string;
  disabled?: boolean;
  active?: boolean;
  loading?: boolean;
  /** Subtle circular button fill when sitting beside an inline input pill on a phone. */
  filled?: boolean;
  onPress: () => void;
}) {
  return (
    <View
      role="button"
      testID="suggest-button"
      tooltip={tip(props.label)}
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled, selected: props.active, busy: props.loading }}
      disabled={props.disabled}
      onPress={props.onPress}
      class={`cursor-pointer select-none disabled:cursor-default group shrink-0 items-center justify-center rounded-full active:scale-[0.96] disabled:opacity-[0.4] ${props.sizeClass} ${props.active ? "bg-accent-tint border border-accent-border" : props.filled ? "bg-chip border border-line hover:bg-line-subtle" : "hover:bg-line-subtle"}`}
    >
      <Icon
        name={props.loading ? "spinner" : "sparkles"}
        size={props.filled ? 20 : 16}
        class={`${props.loading ? "animate-spin " : ""}${props.active || props.loading ? "tint-brand" : "tint-ink-secondary group-hover:tint-ink"}`}
      />
    </View>
  );
}
