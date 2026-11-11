/**
 * The job view's keyboard walks on their own: the rail's rows (Up / Down) and the board's cards
 * (Left / Right between columns), with a line saying which row and which card has the focus.
 */
import { signal, Text, View } from "nsh";
import type { Bot, TaskDetail, TicketWithArtifacts } from "@real-bot/protocol";
import type { TicketLanes } from "../src/m/overlays/ticket-lanes.ts";
import { TicketList } from "../src/ui/overlays/TicketList";
import { TicketRail } from "../src/ui/overlays/TicketRail";

const AT = "2026-10-06T04:08:55.000Z";
const BOTS = [{ id: "bot-writer", name: "Writer", avatar: null }] as unknown as Bot[];

function ticket(seq: number, title: string, status: TicketWithArtifacts["status"]): TicketWithArtifacts {
  return {
    id: `tk-${seq}`,
    task_id: "task-1",
    seq,
    title,
    slug: `t${seq}`,
    dir: `tickets/${seq}`,
    spec: "",
    status,
    worker: null,
    owner_bot_id: "bot-writer",
    depends_on: [],
    created_at: AT,
    updated_at: AT,
    closed_at: null,
    artifacts: [],
  } as TicketWithArtifacts;
}

const DETAIL = {
  id: "task-1",
  title: "周报",
  session_id: "group-1",
  closed_at: null,
  status: "active",
  revision: 1,
  ticket_counts: { todo: 2, doing: 1, review: 0, done: 1, parked: 0 },
  tickets: [ticket(1, "收集数据", "done"), ticket(2, "写初稿", "doing"), ticket(3, "排版", "todo"), ticket(4, "发布", "todo")],
} as unknown as TaskDetail;

const LANES: TicketLanes = { cols: 0, gaps: [], byTicket: new Map(), yours: [], loose: [], ranBy: new Map() };

export default function JobKeys() {
  const row = signal<string | null>(null);
  const card = signal<string | null>(null);
  return (
    <View class="flex-1 bg-bg">
      <Text testID="focus-row" class="text-[11px] text-ink-muted">{`row:${row() ?? "-"}`}</Text>
      <Text testID="focus-card" class="text-[11px] text-ink-muted">{`card:${card() ?? "-"}`}</Text>
      <View class="flex-row flex-1 min-h-0">
        <View class="w-[320px] min-h-0">
          <TicketRail
            detail={DETAIL}
            lanes={LANES}
            bots={BOTS}
            youLabel="你"
            deletedLabel="已删除"
            selectedId={null}
            statusFilter="all"
            onPick={() => {}}
            onPickMark={() => {}}
            onClearFilter={() => {}}
            onExpand={() => {}}
            onFocusRow={(id) => row.set(id)}
          />
        </View>
        <View class="flex-1 min-w-0 min-h-0">
          <TicketList
            api={null}
            detail={DETAIL}
            nodes={[]}
            bots={BOTS}
            youLabel="你"
            deletedLabel="已删除"
            selectedId={null}
            onSelect={() => {}}
            onJump={() => {}}
            onOpenArtifacts={() => {}}
            onPatched={() => {}}
            onConflict={() => {}}
            onFocusCard={(id) => card.set(id)}
          />
        </View>
      </View>
    </View>
  );
}
