/**
 * Deskfolk on NSH (dev build): the conversations on the window's glass, the open one on a card,
 * and the spike's native panes (terminal, PDF). Phase 0 of docs/adr/0107.
 */
import { host, mount, signal, Text, View } from "nsh";
import { Composer, Transcript } from "./src/Conversation";
import { Sidebar } from "./src/Sidebar";
import { initialPane, initialSession } from "./src/api";
import { bots, openSession, openSessionId, sessions, start } from "./src/sync";
import { sessionTitle } from "./src/titles";
import { PdfPane, TerminalPane } from "./src/Tools";

type Pane = "chat" | "terminal" | "pdf";

function App() {
  const pane = signal<Pane>((initialPane as Pane | null) ?? "chat");
  start();
  if (initialSession) void openSession(initialSession);
  const title = () => {
    const open = sessions().find((s) => s.id === openSessionId());
    return open ? sessionTitle(open, bots()) : "Deskfolk Dev";
  };
  return (
    <View class="flex-1 flex-row">
      <Sidebar />
      <View class="flex-1 my-2 mr-2 rounded-[12px] bg-card border border-border overflow-hidden">
        <View class="h-[44px] flex-row items-center gap-3 border-b border-border px-4" desktop={{ windowDrag: true }}>
          <Text class="flex-1 text-[14px] font-semibold text-card-foreground line-clamp-1">
            {title()}
          </Text>
          <Tab label="对话" value="chat" pane={pane()} onSelect={(p) => pane.set(p)} />
          <Tab label="终端" value="terminal" pane={pane()} onSelect={(p) => pane.set(p)} />
          <Tab label="PDF" value="pdf" pane={pane()} onSelect={(p) => pane.set(p)} />
          <View
            role="button"
            onPress={() => void host.call("shell.newWindow")}
            class="rounded-[6px] px-2 py-1 hover:bg-muted"
          >
            <Text class="text-[12px] text-muted-foreground">新窗口</Text>
          </View>
        </View>
        <If when={pane() === "chat"}>
          <If
            when={openSessionId()}
            else={<Text class="m-auto text-[13px] text-muted-foreground">从左边选一个对话</Text>}
          >
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
    <View
      role="button"
      onPress={() => props.onSelect(props.value)}
      class="rounded-[6px] px-2 py-1"
      classList={{ "bg-accent": props.pane === props.value }}
    >
      <Text
        class="text-[12px]"
        classList={{
          "text-accent-foreground": props.pane === props.value,
          "text-muted-foreground": props.pane !== props.value,
        }}
      >
        {props.label}
      </Text>
    </View>
  );
}

mount(App);
