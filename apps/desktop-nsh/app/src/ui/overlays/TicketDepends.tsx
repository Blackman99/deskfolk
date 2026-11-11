/**
 * What a ticket waits for, as a list of the plan's other tickets to tick, opened from its settings
 * (`overlays/TicketDepends.svelte`).
 */
import { Text, View } from "nsh";
import type { TaskDetail, TicketWithArtifacts } from "@real-bot/protocol";
import { ticketTag } from "../../m/overlays/plan-board.ts";
import type { TicketEdits } from "../../m/overlays/ticket-edits.svelte.ts";
import { copy } from "../../runtime";
import { Checkbox } from "../Checkbox";
import { tip } from "../tip";

/** Whether `other` already waits on `ticket`, directly or through others: choosing it would make a loop. */
function wouldLoop(detail: TaskDetail, ticket: TicketWithArtifacts, other: TicketWithArtifacts): boolean {
  const byId = new Map(detail.tickets.map((row) => [row.id, row] as const));
  const seen = new Set<string>();
  const stack = [...(other.depends_on ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === ticket.id) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id)?.depends_on ?? []));
  }
  return false;
}

export function TicketDepends(props: { detail: TaskDetail; ticket: TicketWithArtifacts; edits: TicketEdits }) {
  const others = () => props.detail.tickets.filter((other) => other.id !== props.ticket.id);
  return (
    <View
      accessibilityLabel={copy().plan.dependsHint}
      testID="ticket-depends"
      class="w-full gap-1 px-2 py-[6px] border border-line rounded-(--radius-sm) bg-chip"
    >
      <Text class="text-[11px] text-ink-muted">{copy().plan.dependsHint}</Text>
      <Each of={others()} key={(other) => other.id}>
        {(other) => {
          const chosen = () => (props.ticket.depends_on ?? []).includes(other().id);
          const loops = () => !chosen() && wouldLoop(props.detail, props.ticket, other());
          const parked = () => !chosen() && other().status === "parked";
          const blocked = () => loops() || parked();
          return (
            <View
              testID={`ticket-depends-${other().seq}`}
              tooltip={loops() ? tip(copy().plan.dependsLoop) : parked() ? tip(copy().plan.dependsParked) : undefined}
              class={blocked() ? "opacity-[0.55]" : ""}
            >
              <Checkbox
                checked={chosen()}
                disabled={props.edits.patchingId === props.ticket.id || blocked()}
                accessibilityLabel={`${ticketTag(other().seq)} ${other().title}`}
                onChange={() => void props.edits.toggleDepends(props.ticket, other().id)}
                class="min-w-0"
              >
                <View class="flex-row items-center gap-[6px] min-w-0">
                  <Text class="text-[12px] font-mono text-ink-secondary">{ticketTag(other().seq)}</Text>
                  <Text class="text-[12px] text-ink-secondary line-clamp-1 min-w-0">{other().title}</Text>
                </View>
              </Checkbox>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
