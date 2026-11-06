/**
 * Your stops that wait to be lifted, above the list (`HoldsBar.svelte`, ADR 0040 P2): what each
 * holds, since when, and a lift for each. A stop for now is not among them — your next line is the
 * end of it (ADR 0081) — so this is only for one you dropped the job with by a button, which no line
 * of yours ends.
 */
import type { Hold } from "@real-bot/protocol";
import { platform, Scroll, signal, Text, View } from "nsh";
import { formatFullTimestamp, formatMessageTime } from "../../m/chat/chat-view";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { tip } from "../tip";

export function HoldsBar(props: {
  holds: readonly Hold[];
  label: (hold: Hold) => string;
  disabled?: boolean;
  /** Resolves to a refusal to show on its row (an `ApiError`), or nothing. */
  onLift: (hold: Hold) => Promise<unknown> | void;
}) {
  const lifting = signal<string | null>(null);
  /** The stop whose lift was refused, said on its row until you try again. */
  const liftFailed = signal<string | null>(null);
  const touch = () => !platform.desktop;

  async function lift(hold: Hold): Promise<void> {
    lifting.set(hold.id);
    liftFailed.set(null);
    try {
      if (await props.onLift(hold)) liftFailed.set(hold.id);
    } catch {
      liftFailed.set(hold.id);
    } finally {
      lifting.set(null);
    }
  }

  return (
    <If when={props.holds.length > 0}>
      <View testID="holds-bar" role="region" accessibilityLabel={copy().control.holdsTitle} class="mt-1 mx-2 mb-[6px] px-2 py-[6px] border border-line rounded-(--radius-md) bg-line-subtle">
        <View class="flex-row items-center gap-[6px]">
          <Icon name="pause" size={12} class="tint-ink-secondary" />
          <Text class="text-[12px] font-semibold text-ink-secondary">{copy().control.holdsTitle}</Text>
          <Text testID="holds-count" class="text-[12px] font-medium text-ink-muted">{String(props.holds.length)}</Text>
        </View>
        <Scroll class="mt-1" style={{ maxHeight: 132 }}>
          <Each of={props.holds} key={(hold) => hold.id}>
            {(hold) => (
              <View
                testID={`hold-${hold().id}`}
                tooltip={tip(formatFullTimestamp(hold().created_at))}
                class={`flex-row items-center gap-[6px] mb-[2px] ${touch() ? "min-h-[40px]" : "min-h-[26px]"}`}
              >
                <Text tooltip={tip(props.label(hold()))} class="flex-1 min-w-0 text-[12px] text-ink line-clamp-1">{props.label(hold())}</Text>
                <If when={hold().action === "cancel"}>
                  <View class="shrink-0 px-[5px] rounded-(--radius-xs) bg-chip">
                    <Text class="text-[11px] text-ink-secondary">{copy().control.dropped}</Text>
                  </View>
                </If>
                <If
                  when={liftFailed() === hold().id}
                  else={<Text class="shrink-0 font-mono text-[11px] text-ink-muted">{formatMessageTime(hold().created_at)}</Text>}
                >
                  <Text role="text" testID={`hold-failed-${hold().id}`} class="shrink-0 text-[11px] text-danger-text">{copy().control.failed}</Text>
                </If>
                <View
                  role="button"
                  testID={`hold-lift-${hold().id}`}
                  accessibilityLabel={copy().control.lift}
                  disabled={props.disabled || lifting() === hold().id}
                  onPress={() => void lift(hold())}
                  class={`shrink-0 items-center justify-center px-2 bg-pane border border-accent-border rounded-(--radius-sm) hover:bg-brand hover:border-brand group disabled:opacity-[0.5] ${touch() ? "h-[32px] px-3" : "h-[22px]"}`}
                >
                  <Text class="text-[11px] font-medium text-brand group-hover:text-on-accent">{copy().control.lift}</Text>
                </View>
              </View>
            )}
          </Each>
        </Scroll>
      </View>
    </If>
  );
}
