/** The conversations, newest first, on the window's glass; titles as the messenger gives them. */
import { List, Text, View } from "nsh";
import type { Bot, SessionSummary } from "@real-bot/protocol";
import { USER_MEMBER } from "@real-bot/protocol";
import { sessionTitle } from "./m/sidebar/session-title.ts";
import { copy, runtime } from "./runtime";

function botsById(): ReadonlyMap<string, Bot> {
  return new Map(runtime.snapshot.bots.map((bot) => [bot.id, bot]));
}

export function titleOf(session: SessionSummary): string {
  const t = copy();
  const labels = { deleted: t.top.deleted, archived: t.top.archived, fileDrop: t.sidebar.fileDrop, projectUntitled: t.project.untitled };
  return sessionTitle(session, botsById(), labels) || "…";
}

function preview(session: SessionSummary): string {
  const last = session.last_message;
  if (!last) return "";
  const who = last.author === USER_MEMBER ? "你：" : "";
  return `${who}${last.body.replace(/\s+/g, " ").slice(0, 80)}`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d.toDateString() === new Date().toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function sorted(): SessionSummary[] {
  return [...runtime.snapshot.sessions]
    .filter((s) => !s.archived_at)
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
}

export function Sidebar() {
  return (
    <View class="w-[268px] bg-sidebar" style={{ paddingTop: 44 }}>
      <View class="flex-row items-center justify-between px-4 pb-2" desktop={{ windowDrag: true }}>
        <Text class="text-[13px] font-semibold text-sidebar-foreground">对话</Text>
        <Text class="text-[11px] text-muted-foreground" testID="connection">
          {runtime.connection === "connected" ? "" : runtime.connection === "connecting" ? "连接中…" : "已断开，重连中"}
        </Text>
      </View>
      <List
        each={sorted()}
        keyExtractor={(s) => s.id}
        class="flex-1"
        contentClass="px-2 pb-3 gap-[2px]"
        estimatedItemSize={56}
        empty={<Text class="px-4 py-6 text-[13px] text-muted-foreground">还没有对话</Text>}
      >
        {(session) => <Row session={session()} />}
      </List>
    </View>
  );
}

function Row(props: { session: SessionSummary }) {
  const active = () => runtime.selectedId === props.session.id;
  return (
    <View
      role="button"
      testID={`session-${props.session.id}`}
      onPress={() => void runtime.selectSession(props.session.id)}
      class="rounded-[8px] px-3 py-2 gap-[2px] hover:bg-sidebar-accent/60"
      classList={{ "bg-sidebar-accent": active() }}
    >
      <View class="flex-row items-center gap-2">
        <Text class="flex-1 text-[13px] font-medium text-sidebar-foreground line-clamp-1">{titleOf(props.session)}</Text>
        <Text class="text-[11px] text-muted-foreground">{clock(props.session.updated_at)}</Text>
      </View>
      <View class="flex-row items-center gap-2">
        <Text class="flex-1 text-[12px] text-muted-foreground line-clamp-1">{preview(props.session)}</Text>
        <If when={(props.session.unread_count ?? 0) > 0}>
          <View class="min-w-[18px] h-[18px] rounded-full bg-primary items-center justify-center px-[5px]">
            <Text class="text-[11px] font-semibold text-primary-foreground">{String(props.session.unread_count)}</Text>
          </View>
        </If>
      </View>
    </View>
  );
}
