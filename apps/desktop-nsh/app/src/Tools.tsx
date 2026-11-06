/** The spike's two native panes: a terminal on the runtime's pty, and a PDF from this Mac. */
import { colorScheme, effect, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { Terminal as TerminalInfo } from "@real-bot/protocol";
import { api, initialPdf } from "./api";
import { Pdf, Terminal } from "./native";
import { workspacePath } from "./sync";

export function TerminalPane() {
  const terminalId = signal<string | null>(null);
  const error = signal<string | null>(null);
  const ensure = async (cwd: string) => {
    try {
      const list = await api<{ items: TerminalInfo[] }>("/v1/terminals");
      const live = list.items.find((t) => t.status === "live");
      const terminal = live ?? (await api<TerminalInfo>("/v1/terminals", { method: "POST", body: { cwd, rows: 30, cols: 100 } }));
      terminalId.set(terminal.id);
    } catch (e) {
      error.set(String(e));
    }
  };
  // Opens once the workspace is known (the snapshot brings it).
  effect(() => {
    const cwd = workspacePath();
    if (cwd && !terminalId()) void ensure(cwd);
  });
  return (
    <View class="flex-1">
      <If when={terminalId()} else={<Text class="p-6 text-[13px] text-muted-foreground">{error() ?? (workspacePath() ? "正在打开终端…" : "还没有工作区：在设置里选一个")}</Text>}>
        {(id) => (
          <Terminal
            terminalId={id()}
            fontSize={13}
            dark={colorScheme() === "dark"}
            onExit={() => terminalId.set(null)}
            onError={(e) => error.set(e.message)}
            style={{ flex: 1 }}
          />
        )}
      </If>
    </View>
  );
}

export function PdfPane() {
  const path = signal(initialPdf);
  const shown = signal(initialPdf);
  const status = signal("输入一个本机 PDF 的绝对路径，回车打开");
  return (
    <View class="flex-1">
      <View class="flex-row items-center gap-2 border-b border-border px-4 py-2">
        <Input
          value={path()}
          onChange={(e) => path.set(e.value)}
          onSubmit={() => shown.set(path().trim())}
          placeholder="/Users/…/file.pdf"
          class="flex-1 h-[30px] rounded-[8px] border border-input bg-background px-2 text-[13px] text-foreground"
          testID="pdf-path"
        />
        <Text class="text-[12px] text-muted-foreground">{status()}</Text>
      </View>
      <If when={shown()}>
        {(p) => (
          <Pdf
            path={p()}
            background={colorScheme() === "dark" ? "#0f1416" : "#eef1f2"}
            onLoaded={(e) => status.set(`${e.pages} 页 · ${e.firstLine}`)}
            onError={(e) => status.set(e.message)}
            style={{ flex: 1 }}
          />
        )}
      </If>
    </View>
  );
}
