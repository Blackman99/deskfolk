/** The conversations, newest first, on the window's glass. */
import { List, Text, View } from "nsh";
import type { SessionSummary } from "@real-bot/protocol";
import { bots, connection, openSession, openSessionId, sessions } from "./sync";
import { clock, preview, sessionTitle } from "./titles";

export function Sidebar() {
  return (
    <View class="w-[268px] bg-sidebar" style={{ paddingTop: 44 }}>
      <View class="flex-row items-center justify-between px-4 pb-2" desktop={{ windowDrag: true }}>
        <Text class="text-[13px] font-semibold text-sidebar-foreground">对话</Text>
        <Text class="text-[11px] text-muted-foreground">
          {connection() === "live" ? "" : connection() === "connecting" ? "连接中…" : "已断开，重连中"}
        </Text>
      </View>
      <List
        each={sessions()}
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
  const active = () => openSessionId() === props.session.id;
  return (
    <View
      role="button"
      testID={`session-${props.session.id}`}
      onPress={() => void openSession(props.session.id)}
      class="rounded-[8px] px-3 py-2 gap-[2px] hover:bg-sidebar-accent/60"
      style={{ backgroundColor: active() ? undefined : "transparent" }}
      classList={{ "bg-sidebar-accent": active() }}
    >
      <View class="flex-row items-center gap-2">
        <Text class="flex-1 text-[13px] font-medium text-sidebar-foreground line-clamp-1">
          {sessionTitle(props.session, bots())}
        </Text>
        <Text class="text-[11px] text-muted-foreground">{clock(props.session.updated_at)}</Text>
      </View>
      <View class="flex-row items-center gap-2">
        <Text class="flex-1 text-[12px] text-muted-foreground line-clamp-1">
          {preview(props.session, bots())}
        </Text>
        <If when={(props.session.unread_count ?? 0) > 0}>
          <View class="min-w-[18px] h-[18px] rounded-full bg-primary items-center justify-center px-[5px]">
            <Text class="text-[11px] font-semibold text-primary-foreground">{String(props.session.unread_count)}</Text>
          </View>
        </If>
      </View>
    </View>
  );
}
