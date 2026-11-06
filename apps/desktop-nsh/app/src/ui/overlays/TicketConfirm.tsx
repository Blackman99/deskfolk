/**
 * A move that waits on your word because a hand-over is still open, and a save that did not go
 * through (`overlays/TicketConfirm.svelte`).
 */
import { Text, View } from "nsh";
import type { TicketWithArtifacts } from "@real-bot/protocol";
import type { TicketEdits } from "../../m/overlays/ticket-edits.svelte.ts";
import { copy } from "../../runtime";

export function TicketConfirm(props: { ticket: TicketWithArtifacts; edits: TicketEdits }) {
  const pending = () => {
    const move = props.edits.confirming;
    return move && move.id === props.ticket.id ? move : null;
  };
  return (
    <>
      <If when={pending()}>
        {(move) => {
          const said = () => copy().plan.board.pendingMove(copy().plan.ticketStatus[move().status]);
          return (
            <View accessibilityLabel={said()} testID="ticket-confirm" class="gap-[6px] px-2 py-[6px] rounded-(--radius-sm) bg-warn-bg">
              <Text class="text-[11px] leading-[1.45] text-warn-text">{said()}</Text>
              <View class="flex-row gap-2">
                <View
                  role="button"
                  testID="ticket-confirm-go"
                  onPress={() => props.edits.queueMove(props.ticket.id, move().status)}
                  class="px-2 py-[2px] rounded-(--radius-sm) border border-warn-line bg-pane"
                >
                  <Text class="text-[11px] font-semibold text-warn-text">{copy().plan.board.moveAnyway}</Text>
                </View>
                <View
                  role="button"
                  testID="ticket-confirm-keep"
                  onPress={() => props.edits.keepCard(props.ticket.id)}
                  class="px-2 py-[2px] rounded-(--radius-sm) border border-line bg-pane"
                >
                  <Text class="text-[11px] text-ink">{copy().plan.board.keep}</Text>
                </View>
              </View>
            </View>
          );
        }}
      </If>
      <If when={props.edits.errorId === props.ticket.id}>
        <Text testID="ticket-error" class="text-[11px] text-danger-text">{copy().plan.saveFailed}</Text>
      </If>
    </>
  );
}
