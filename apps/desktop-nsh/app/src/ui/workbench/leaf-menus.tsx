/**
 * What `WorkbenchLeaf` shows for starting something new: the + menu hung off the strip, and an empty
 * pane's own offer. Both hold the same filter field and the host's `menuActions` list; an empty pane
 * without a shaped menu shows the wrapping `emptyActions` instead.
 */
import { Input } from "nsh/base";
import { Overlay, Scroll, Text, View, windowSize, type InputRef, type ViewRef } from "nsh";
import { copy } from "../../runtime";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";
import { shadow, TEXT } from "../styles";
import type { LeafRender, MenuRender } from "./types";

/** The search bar of a new-tab list: a field that takes the focus when the list opens. */
export function FilterField(props: { testID: string; value: () => string; onChange: (value: string) => void; autoFocus?: boolean }) {
  let input: InputRef | null = null;
  if (props.autoFocus) queueMicrotask(() => input?.focus());
  return (
    <View
      testID={`${props.testID}-bar`}
      class="flex-row items-center gap-[6px] shrink-0 mb-1 px-2 h-[30px] rounded-(--radius-md) bg-bg border border-line focus-within:border-field-focus-border"
    >
      <Icon name="search" size={16} class="tint-ink-muted" />
      <Input
        testID={props.testID}
        ref={(node) => (input = node as InputRef)}
        value={props.value()}
        onChange={(e) => props.onChange(e.value)}
        placeholder={copy().pane.findOpen}
        accessibilityLabel={copy().pane.findOpen}
        autoCorrect={false}
        autoCapitalize="none"
        class="flex-1 min-w-0 p-0 text-[12px] text-ink"
      />
    </View>
  );
}

/**
 * The + menu: listed, and only as wide as the menu (a row of chips grew with every shell), the list
 * scrolling inside. Hangs under the +, from its left edge; the overlay flips it up or inward where
 * it would run off the window. Escape and a press outside close it.
 */
export function NewTabMenu(props: {
  leafId: string;
  anchor: ViewRef | null;
  filter: () => string;
  onFilter: (value: string) => void;
  menuActions?: MenuRender;
  emptyActions?: LeafRender;
  onClose: () => void;
}) {
  const body = () => (props.menuActions ? props.menuActions(props.leafId, props.filter(), props.onClose) : props.emptyActions?.(props.leafId));
  return (
    <Overlay anchor={props.anchor} placement="bottom" align="start" offset={4} margin={8} onPressOutside={() => props.onClose()} onCancel={() => props.onClose()}>
      <View
        role="menu"
        testID="wb-new-menu"
        accessibilityLabel={copy().pane.newTab}
        class="w-[280px] p-[6px] rounded-(--radius-lg) bg-pane border border-line overflow-hidden"
        style={{ maxHeight: Math.min(420, windowSize().height - 48), maxWidth: windowSize().width - 16, boxShadow: shadow("menu") }}
      >
        <FilterField testID="wb-new-query" value={props.filter} onChange={props.onFilter} autoFocus />
        <Scroll testID="wb-new-scroll" style={{ flexShrink: 1, minHeight: 0 }}>
          {body}
        </Scroll>
      </View>
    </Overlay>
  );
}

/** A pane with no tab: what it is for, the ways to start something new, and the list to fill it. */
export function EmptyPane(props: {
  leafId: string;
  filter: () => string;
  onFilter: (value: string) => void;
  menuActions?: MenuRender;
  emptyActions?: LeafRender;
  emptyLead?: LeafRender;
}) {
  const t = () => copy().pane;
  return (
    <View testID="wb-empty" class="flex-1 items-center justify-center gap-4 px-4 py-6 min-h-0">
      <View class="items-center gap-1 shrink-0">
        <View accessible={false} class="mb-2">
          <BrandMark variant="art" size={64} />
        </View>
        <Text testID="wb-empty-title" class="font-semibold text-ink" style={{ fontSize: TEXT.heading, textAlign: "center" }}>
          {t().empty}
        </Text>
        <Text testID="wb-empty-hint" class="text-ink-muted" style={{ fontSize: TEXT.small, textAlign: "center" }}>
          {props.menuActions || props.emptyActions ? t().emptyPick : t().emptyHint}
        </Text>
      </View>
      <If when={props.emptyLead}>
        {(lead) => (
          <View testID="wb-empty-lead" class="flex-row flex-wrap justify-center gap-2">
            {lead()(props.leafId)}
          </View>
        )}
      </If>
      <If
        when={props.menuActions}
        else={
          <If when={props.emptyActions}>
            {(actions) => (
              <View testID="wb-empty-actions" class="flex-row flex-wrap justify-center gap-2">
                {actions()(props.leafId)}
              </View>
            )}
          </If>
        }
      >
        {(menu) => (
          <View
            role="menu"
            testID="wb-empty-card"
            accessibilityLabel={t().newTab}
            class="p-[6px] rounded-(--radius-lg) bg-pane border border-line min-h-0 shrink"
            style={{ width: 300, maxWidth: "100%", maxHeight: 360, boxShadow: shadow("menu") }}
          >
            <FilterField testID="wb-empty-query" value={props.filter} onChange={props.onFilter} />
            <Scroll testID="wb-empty-scroll" style={{ flexShrink: 1, minHeight: 0 }}>
              {() => menu()(props.leafId, props.filter(), () => {})}
            </Scroll>
          </View>
        )}
      </If>
    </View>
  );
}
