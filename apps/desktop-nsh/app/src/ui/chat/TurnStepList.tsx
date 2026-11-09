/**
 * What a working message's last line opens onto (`TurnStepList.svelte`): the steps going on now,
 * each said whole, and what a running command is printing as it prints it. Escape closes it.
 */
import { effect, keymap, Scroll, Text, View, type ScrollRef } from "nsh";
import type { StepRow } from "../../m/chat/turn-activity.ts";
import { shadow } from "../styles";

export function TurnStepList(props: {
  id?: string;
  /** Who is doing it, and how many things: the list's heading and its region name. */
  title: string;
  rows: StepRow[];
  /** What a command has printed, while this conversation is the one watching it. */
  outputOf?: (callId: string) => string | null;
  onClose: () => void;
}) {
  let list: ScrollRef | undefined;
  // Follow the end of the list, the way a terminal does.
  effect(() => {
    void props.rows.length;
    setTimeout(() => list?.scrollTo({ y: 1_000_000, animated: false }), 0);
  });
  effect(() => keymap.bind("escape", () => props.onClose(), { when: "always" }));
  return (
    <View
      testID={props.id ?? "turn-steps"}
      selectable
      accessibilityLabel={props.title}
      class="w-full max-w-[560px] mt-[6px] px-[10px] pt-[8px] pb-[9px] bg-pane border border-line rounded-(--radius-lg)"
      style={{ boxShadow: shadow("sm") }}
    >
      <Text class="mb-[6px] text-[12px] font-semibold text-ink-muted">{props.title}</Text>
      <Scroll ref={(node) => (list = node)} class="max-h-[216px]" contentClass="gap-[3px]">
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
                    <Scroll testID="turn-step-output" class="ml-[20px] max-h-[160px] rounded-(--radius-sm) bg-code-bg">
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
