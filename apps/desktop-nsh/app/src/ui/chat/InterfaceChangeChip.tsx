/**
 * Under a Bot's reply: the interface change it made without a card, and the way back (ADR 0106). Not a
 * message (`InterfaceChangeChip.svelte`). Its Undo is one of the floor (ADR 0108).
 */
import { signal, Text, View } from "nsh";
import type { InterfaceRevisionHead } from "@real-bot/protocol";
import type { MessengerApi } from "../../m/messenger-api";
import { copy } from "../../runtime";
import { floor } from "../interface/floor";
import { tip } from "../tip";

export function InterfaceChangeChip(props: {
  /** The turns the reply belongs to. */
  turnIds: readonly string[];
  recent: readonly InterfaceRevisionHead[];
  api: MessengerApi | null;
}) {
  const chip = () => copy().ui.chip;
  /** A change a card let through has its Undo on the card. */
  const heads = () => props.recent.filter((row) => row.actor === "bot" && !row.approval_id && row.turn_id !== null && props.turnIds.includes(row.turn_id));
  const undone = signal<Record<string, boolean>>({});
  const failed = signal<Record<string, boolean>>({});
  const busy = signal<string | null>(null);

  async function undo(id: string): Promise<void> {
    if (!props.api || busy()) return;
    busy.set(id);
    try {
      await props.api.undoInterfaceRevision(id);
      undone.set({ ...undone(), [id]: true });
    } catch {
      failed.set({ ...failed(), [id]: true });
    } finally {
      busy.set(null);
    }
  }

  return (
    <Each of={heads()} key={(h) => h.id}>
      {(head) => (
        <View testID="interface-chip" class="flex-row items-baseline gap-[8px] min-w-0 max-w-full mt-[6px]">
          <Text class="shrink-0 text-[12px] font-semibold text-ink-muted">{chip().changed}</Text>
          <If when={head().changes[0]}>
            <View class="min-w-0 shrink" tooltip={tip(head().changes.join("\n"))}>
              <Text class="text-[12px] text-ink-secondary line-clamp-1">{head().changes[0]}</Text>
            </View>
          </If>
          <If
            when={undone()[head().id]}
            else={
              <If
                when={head().undoable && !failed()[head().id]}
                else={<Text class="shrink-0 text-[12px] text-ink-muted">{chip().cannotUndo}</Text>}
              >
                <View
                  role="button"
                  ref={floor("interface-undo", { ink: "brand", ground: ["pane"] })}
                  testID="interface-undo"
                  disabled={busy() === head().id}
                  onPress={() => void undo(head().id)}
                  class="cursor-pointer select-none disabled:cursor-default shrink-0 disabled:opacity-[0.6]"
                >
                  <Text class="text-[12px] text-brand">{chip().undo}</Text>
                </View>
              </If>
            }
          >
            <Text class="shrink-0 text-[12px] text-ink-muted">{chip().undone}</Text>
          </If>
        </View>
      )}
    </Each>
  );
}
