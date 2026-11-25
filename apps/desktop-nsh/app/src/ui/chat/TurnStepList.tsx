/**
 * What a working message's last line opens onto (`TurnStepList.svelte`): the steps going on now,
 * each said whole, and what a running command is printing as it prints it. Escape closes it.
 */
import { cleanup, computed, effect, keymap, Scroll, Text, View, type ScrollRef } from "nsh";
import type { StepRow } from "../../m/chat/turn-activity.ts";
import { shadow } from "../styles";

export function TurnStepList(props: {
  id?: string;
  /** Who is doing it, and how many things: the list's heading and its region name. */
  title: string;
  rows: StepRow[];
  /** What a command has printed, while this conversation is the one watching it. */
  outputOf?: (callId: string) => string | null;
  /**
   * Its text is a selection area of its own (default true). False inside a transcript that is one
   * area: it joins it, and a right click goes to that area's `onContextMenu` (`workbench/pane-menu.ts`).
   */
  selectable?: boolean;
  onClose: () => void;
}) {
  let list: ScrollRef | undefined;
  let atEnd = true;
  // From the list's mount to its first layout (the Scroll's `onLayout`), as in `CommandActivity`.
  let placing = false;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const toEnd = () => list?.scrollTo({ y: 1_000_000, animated: false });
  const followEnd = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      if (atEnd) toEnd();
    }, 0);
  };
  cleanup(() => {
    if (pending) clearTimeout(pending);
  });
  // Follow new steps the way a terminal does, unless you have scrolled up to read. By the count
  // (`computed`), not `props.rows`: the array is rebuilt every 250 ms as the step clocks tick, and
  // following the array snapped the list back to the bottom four times a second while you scrolled up.
  const count = computed(() => props.rows.length);
  effect(() => {
    void count();
    if (atEnd) followEnd();
  });
  effect(() => keymap.bind("escape", () => props.onClose(), { when: "always" }));
  return (
    <View
      testID={props.id ?? "turn-steps"}
      selectable={props.selectable !== false}
      accessibilityLabel={props.title}
      class="w-full max-w-[560px] mt-[6px] px-[10px] pt-[8px] pb-[9px] bg-pane border border-line rounded-(--radius-lg)"
      style={{ boxShadow: shadow("sm") }}
    >
      <Text class="mb-[6px] text-[12px] font-semibold text-ink-muted">{props.title}</Text>
      <Scroll
        testID="turn-steps-scroll"
        ref={(node) => {
          list = node;
          atEnd = true;
          placing = true;
        }}
        class="max-h-[216px]"
        contentClass="gap-[3px]"
        onLayout={() => {
          if (!placing) return;
          placing = false;
          if (atEnd) toEnd();
        }}
        onScroll={(e) => {
          atEnd = e.contentSize.height - e.offset.y - e.size.height < 8;
        }}
      >
        <Each of={props.rows} key={(row) => row.id}>
          {(row) => {
            const output = () => (row().shell && props.outputOf ? props.outputOf(row().id) : null);
            return (
              <View class="gap-[3px]">
                <View testID="turn-step" class="flex-row items-baseline gap-[6px]">
                  <View class="w-[14px] items-center justify-center">
                    <View class="w-[6px] h-[6px] rounded-full bg-brand opacity-[0.7]" />
                  </View>
                  <If
                    when={row().open}
                    else={<Text class="flex-1 min-w-0 text-[12px] leading-[1.45] text-ink">{row().text}</Text>}
                  >
                    {(open: () => () => void) => (
                      <View role="button" testID="turn-step-open" onPress={() => open()()} class="cursor-pointer select-none group flex-1 min-w-0">
                        <Text class="text-[12px] leading-[1.45] text-ink group-hover:text-brand">{row().text}</Text>
                      </View>
                    )}
                  </If>
                  <If when={row().time}>
                    <Text class="text-[11px] text-ink-muted font-mono">{row().time}</Text>
                  </If>
                </View>
                <If when={output()}>
                  {(text: () => string) => (
                    <Scroll testID="turn-step-output" class="ml-[20px] max-h-[160px] rounded-(--radius-sm) bg-chip">
                      <Text class="px-[8px] py-[6px] text-[11px] leading-[1.45] font-mono text-ink-muted">{text()}</Text>
                    </Scroll>
                  )}
                </If>
              </View>
            );
          }}
        </Each>
      </Scroll>
    </View>
  );
}
