/** Small parts the trace's cards share. */
import { Text, View } from "nsh";
import type { Ticket } from "@real-bot/protocol";
import { ticketTag } from "../../m/overlays/plan-board.ts";
import { tip } from "../tip";

/** The ticket a card worked in, as its number; the rail says the rest. */
export function TicketTag(props: { ticket: Ticket }) {
  return (
    <View
      tooltip={tip(props.ticket.title)}
      class="shrink-0 px-[5px] border border-line rounded-(--radius-sm) bg-chip"
    >
      <Text class="text-[10px] font-semibold leading-[15px] text-ink-muted font-mono">{ticketTag(props.ticket.seq)}</Text>
    </View>
  );
}
