/**
 * The window: the conversations on the glass, the open one on a card, and the native panes
 * (terminal, PDF). Every screen reads the messenger's runtime (`src/runtime.ts`).
 */
import { effect, host, signal, Text, View } from "nsh";
import { Composer, Transcript } from "./Conversation";
import { initialPane, initialSession } from "./launch";
import { runtime } from "./runtime";
import { Sidebar, titleOf } from "./Sidebar";
import { PdfPane, TerminalPane } from "./Tools";

type Pane = "chat" | "terminal" | "pdf";

export function Main() {
  const pane = signal<Pane>((initialPane as Pane | null) ?? "chat");
  runtime.start();
  // What start-up checks wait for (scripts/ci-smoke.ts, package.ts --measure): the first snapshot.
  let announced = false;
  effect(() => {
    if (announced || runtime.connection !== "connected") return;
    announced = true;
    console.log(`ready: ${runtime.snapshot.sessions.length} conversations`);
  });
  const wanted = initialSession;
  if (wanted) {
    let opened = false;
    effect(() => {
      if (opened || runtime.connection !== "connected") return;
      opened = true;
      void runtime.selectSession(wanted);
    });
  }
  const title = () => {
    const open = runtime.snapshot.sessions.find((s) => s.id === runtime.selectedId);
    return open ? titleOf(open) : "Deskfolk Dev";
  };
  return (
    <View class="flex-1 flex-row">
      <Sidebar />
      <View class="flex-1 my-2 mr-2 rounded-[12px] bg-card border border-border overflow-hidden">
        <View class="h-[44px] flex-row items-center gap-3 border-b border-border px-4" desktop={{ windowDrag: true }}>
          <Text class="flex-1 text-[14px] font-semibold text-card-foreground line-clamp-1">{title()}</Text>
          <Tab label="对话" value="chat" pane={pane()} onSelect={(p) => pane.set(p)} />
          <Tab label="终端" value="terminal" pane={pane()} onSelect={(p) => pane.set(p)} />
          <Tab label="PDF" value="pdf" pane={pane()} onSelect={(p) => pane.set(p)} />
          <View role="button" onPress={() => void host.call("shell.newWindow")} class="rounded-[6px] px-2 py-1 hover:bg-muted">
            <Text class="text-[12px] text-muted-foreground">新窗口</Text>
          </View>
        </View>
        <If when={pane() === "chat"}>
          <If when={runtime.selectedId} else={<Text class="m-auto text-[13px] text-muted-foreground">从左边选一个对话</Text>}>
            {() => (
              <View class="flex-1">
                <Transcript />
                <Composer />
              </View>
            )}
          </If>
        </If>
        <If when={pane() === "terminal"}>
          <TerminalPane />
        </If>
        <If when={pane() === "pdf"}>
          <PdfPane />
        </If>
      </View>
    </View>
  );
}

function Tab(props: { label: string; value: Pane; pane: Pane; onSelect: (p: Pane) => void }) {
  return (
    <View role="button" onPress={() => props.onSelect(props.value)} class="rounded-[6px] px-2 py-1" classList={{ "bg-accent": props.pane === props.value }}>
      <Text
        class="text-[12px]"
        classList={{ "text-accent-foreground": props.pane === props.value, "text-muted-foreground": props.pane !== props.value }}
      >
        {props.label}
      </Text>
    </View>
  );
}
