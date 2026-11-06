/** The spike's panes: a terminal on the runtime's pty, and a PDF from this Mac. */
import { colorScheme, computed, effect, Image, List, signal, Text, View } from "nsh";
import { Documents } from "deskfolk/native";
import { Input } from "nsh/base";
import type { Terminal as TerminalInfo } from "@real-bot/protocol";
import { initialPdf, nativeTerminal } from "./launch";
import { Terminal } from "./native";
import { runtime } from "./runtime";
import { CanvasTerminal } from "./Terminal";

const workspacePath = () => runtime.snapshot.settings.workspace_path;

export function TerminalPane() {
  const terminalId = signal<string | null>(null);
  const error = signal<string | null>(null);
  const ensure = async (cwd: string) => {
    try {
      const client = runtime.client;
      if (!client) return;
      const live = (await client.terminals()).find((t: TerminalInfo) => t.status === "live");
      const terminal = live ?? (await client.openTerminal(cwd, 30, 100));
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
        {(id) =>
          nativeTerminal ? (
            <Terminal
              terminalId={id()}
              fontSize={13}
              dark={colorScheme() === "dark"}
              onExit={() => terminalId.set(null)}
              onError={(e) => error.set(e.message)}
              style={{ flex: 1 }}
            />
          ) : (
            <CanvasTerminal id={id()} onExit={() => terminalId.set(null)} />
          )
        }
      </If>
    </View>
  );
}

/**
 * A PDF from the runtime's files, on every target: hayro (`deskfolk/native`) parses it and renders
 * each page as it scrolls into view.
 */
export function PdfPane() {
  const path = signal(initialPdf);
  const status = signal("输入工作区里或本机的 PDF 路径，回车打开");
  const pages = signal<{ index: number; width: number; height: number }[]>([]);
  const width = signal(0);
  let opened = 0;
  const open = async (file: string) => {
    if (!file) return;
    const id = `pdf-${++opened}`;
    status.set("正在打开…");
    try {
      const client = runtime.client;
      if (!client || client.kind !== "local") throw new Error("not connected");
      const started = Date.now();
      const { origin, token } = client.endpoint;
      const sizes = await Documents.openPdf(id, `${origin}/v1/workspace/file?path=${encodeURIComponent(file)}`, token);
      const list = [];
      for (let i = 0; i < sizes.length; i += 2) list.push({ index: i / 2, width: sizes[i]!, height: sizes[i + 1]! });
      pdfId.set(id);
      pages.set(list);
      status.set(`${list.length} 页 · 打开用了 ${Date.now() - started} ms`);
    } catch (e) {
      status.set(String(e));
    }
  };
  const pdfId = signal("");
  if (initialPdf) void open(initialPdf);
  return (
    <View class="flex-1">
      <View class="flex-row items-center gap-2 border-b border-border px-4 py-2">
        <Input
          value={path()}
          onChange={(e) => path.set(e.value)}
          onSubmit={() => void open(path().trim())}
          placeholder="/Users/…/file.pdf"
          class="flex-1 h-[30px] rounded-[8px] border border-input bg-background px-2 text-[13px] text-foreground"
          testID="pdf-path"
        />
        <Text class="text-[12px] text-muted-foreground" testID="pdf-status">{status()}</Text>
      </View>
      <List
        each={pages()}
        keyExtractor={(p) => `${pdfId()}:${p.index}`}
        class="flex-1 bg-muted"
        contentClass="p-4 gap-4 items-center"
        estimatedItemSize={800}
        onLayout={(e) => width.set(e.bounds.size.width)}
      >
        {(page) => <PdfPage id={pdfId()} page={page()} width={Math.max(200, Math.min(900, width() - 32))} />}
      </List>
    </View>
  );
}

function PdfPage(props: { id: string; page: { index: number; width: number; height: number }; width: number }) {
  const source = computed(() => {
    try {
      const started = Date.now();
      const uri = Documents.renderPdfPage(props.id, props.page.index, props.width * 2);
      if (props.page.index < 3) console.log(`pdf page ${props.page.index}: ${Date.now() - started} ms, ${Math.round(uri.length / 1024)} KB`);
      return uri;
    } catch (e) {
      console.error("pdf page", String(e));
      return "";
    }
  });
  return (
    <Image
      src={source()}
      style={{ width: props.width, height: (props.width * props.page.height) / props.page.width, backgroundColor: "#ffffff" }}
    />
  );
}
