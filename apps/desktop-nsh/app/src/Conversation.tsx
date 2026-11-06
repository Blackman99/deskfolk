/** The open conversation: its lines (an inverted list, newest at the bottom) and the composer. */
import { effect, List, type ListRef, Text, View } from "nsh";
import { Input, TextView } from "nsh/base";
import type { Message, Turn } from "@real-bot/protocol";
import { USER_MEMBER } from "@real-bot/protocol";
import { isLiveStatus } from "./m/chat/transcript.ts";
import { scrollProbe } from "./launch";
import { runtime } from "./runtime";
import { clock } from "./Sidebar";

/** The open conversation's lines, newest first (the inverted list's order). */
function messages(): Message[] {
  const id = runtime.selectedId;
  return runtime.snapshot.messages
    .filter((m) => m.session_id === id && (m.kind as string) !== "profile_change" && !m.withdrawn_at)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

function liveTurns(): Turn[] {
  const id = runtime.selectedId;
  return runtime.snapshot.turns.filter((t) => t.session_id === id && isLiveStatus(t.status));
}

function olderCursor(): string | null {
  return runtime.activeView?.messageNext ?? null;
}

function authorName(author: string): string {
  if (author === USER_MEMBER) return "你";
  return runtime.snapshot.bots.find((b) => b.id === author)?.name ?? "Bot";
}

type Row = { kind: "message"; id: string; message: Message } | { kind: "turn"; id: string; turn: Turn };

export function Transcript() {
  // Item 0 sits at the bottom of an inverted list: the live turns first, then the newest line.
  const rows = (): Row[] => [
    ...liveTurns().map((turn): Row => ({ kind: "turn", id: `turn:${turn.id}`, turn })),
    ...messages().map((message): Row => ({ kind: "message", id: message.id, message })),
  ];
  let list: ListRef | undefined;
  if (scrollProbe) runScrollProbe(() => list);
  return (
    <List
      ref={(node) => (list = node)}
      each={rows()}
      keyExtractor={(row) => row.id}
      inverted
      class="flex-1"
      contentClass="px-6 py-4 gap-4"
      estimatedItemSize={96}
      onLoadMore={() => void runtime.loadOlderMessages()}
      empty={<Text class="px-6 py-10 text-[13px] text-muted-foreground">这里还没有消息</Text>}
    >
      {(row) => <RowView row={row()} />}
    </List>
  );
}

/**
 * Development check (`--scroll-probe`): once a conversation is open, scrolls a line a frame from
 * the newest to the oldest, so the list keeps approaching its end and loads every older page on the
 * way, then back down; NSH's monitor (`--fps`) logs the frames meanwhile.
 */
function runScrollProbe(list: () => ListRef | undefined) {
  let started = false;
  effect(() => {
    if (started || messages().length < 30) return;
    started = true;
    let index = 0;
    let direction = 1;
    const began = Date.now();
    let reported = began;
    const step = () => {
      const node = list();
      if (!node) return;
      const last = messages().length + liveTurns().length - 1;
      if (Date.now() - reported > 2000) {
        reported = Date.now();
        console.log(`scroll probe: ${messages().length} lines, older ${olderCursor() ? "yes" : "no"}, at ${index}`);
      }
      if (direction === 1 && index >= last && !olderCursor()) direction = -1;
      index = Math.max(0, Math.min(last, index + direction));
      node.scrollToIndex({ index, animated: false, viewPosition: 1 });
      if (direction === -1 && index === 0) {
        console.log(`scroll probe: done in ${Date.now() - began} ms over ${messages().length} lines`);
        return;
      }
      setTimeout(step, 16);
    };
    console.log("scroll probe: start");
    setTimeout(step, 500);
  });
}

function RowView(props: { row: Row }) {
  return (
    <If
      when={props.row.kind === "message" ? props.row.message : null}
      else={<LiveTurn turn={(props.row as { turn: Turn }).turn} />}
    >
      {(message) => <Line message={message()} />}
    </If>
  );
}

function Line(props: { message: Message }) {
  const mine = () => props.message.author === USER_MEMBER;
  return (
    <If
      when={mine()}
      else={
        <View class="gap-1 max-w-[760px]">
          <View class="flex-row items-baseline gap-2">
            <Text class="text-[13px] font-semibold text-foreground">{authorName(props.message.author)}</Text>
            <Text class="text-[11px] text-muted-foreground">{clock(props.message.created_at)}</Text>
          </View>
          <TextView markdown={props.message.body} selectable class="text-[14px] text-foreground" />
        </View>
      }
    >
      <View class="items-end gap-1">
        <View class="max-w-[620px] rounded-[14px] bg-you px-3 py-2">
          <TextView
            markdown={props.message.body}
            selectable
            class="text-[14px] text-you-foreground"
            classes={{ paragraph: "text-you-foreground", link: "text-you-foreground underline" }}
          />
        </View>
        <Text class="text-[11px] text-muted-foreground">{clock(props.message.created_at)}</Text>
      </View>
    </If>
  );
}

function LiveTurn(props: { turn: Turn }) {
  return (
    <View class="gap-1 max-w-[760px]">
      <View class="flex-row items-baseline gap-2">
        <Text class="text-[13px] font-semibold text-foreground">{authorName(props.turn.bot_id)}</Text>
        <Text class="text-[11px] text-primary">
          {props.turn.status === "running" ? "正在回复…" : "等你处理"}
        </Text>
      </View>
      <If when={props.turn.partial_text}>
        {(text) => (
          <TextView markdown={text()} options={{ streaming: true }} selectable class="text-[14px] text-foreground" />
        )}
      </If>
    </View>
  );
}

/** The open conversation's draft is the runtime's (`runtime.draft`), so it survives switching away. */
export function Composer() {
  const busy = () => runtime.activeView?.sending ?? false;
  const submit = async () => {
    if (!runtime.draft.trim() || busy()) return;
    await runtime.send();
  };
  return (
    <View class="border-t border-border px-4 py-3 flex-row items-end gap-2">
      <Input
        value={runtime.draft}
        onChange={(e) => (runtime.draft = e.value)}
        onSubmit={() => void submit()}
        submitBehavior="submit"
        multiline
        placeholder="说点什么… 回车发送，⇧回车换行"
        class="flex-1 min-h-[36px] max-h-[160px] rounded-[10px] border border-input bg-background px-3 py-2 text-[14px] text-foreground"
        testID="composer"
      />
      <View
        role="button"
        onPress={() => void submit()}
        class="h-[36px] rounded-[10px] bg-primary px-4 items-center justify-center active:bg-primary/90"
        style={{ opacity: busy() || !runtime.draft.trim() ? 0.5 : 1 }}
      >
        <Text class="text-[13px] font-medium text-primary-foreground">发送</Text>
      </View>
    </View>
  );
}
