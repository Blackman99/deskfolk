/**
 * The pieces every area shares: Markdown with file and Bot chips, file icons, the modal frame, the
 * confirmation. The picture's chip opens the enlargement as a conversation does, growing out of the
 * chip's thumbnail; `opened` says what the chip handed over and where the frame grows from. A right
 * click on a file's chip opens its menu: the files are under `/ws` here, and `opened` says what the
 * system was asked to do with which path.
 */
import { signal, Text, View } from "nsh";
import { Button } from "../src/ui/Button";
import { MarkdownBody } from "../src/ui/MarkdownBody";
import { imageOrigin } from "../src/ui/chat/image-origin";
import { MessageImageLightbox, type ImageOrigin } from "../src/ui/chat/MessageImageLightbox";
import { Modal, ModalAction } from "../src/ui/Modal";
import { DangerDialog } from "../src/ui/overlays/DangerDialog";
import { FileIcon } from "../src/ui/overlays/FileIcon";
import { fileIconFor } from "../src/m/overlays/file-icon.ts";

// The picture's paragraph comes last: the headless runner lays a paragraph out a line tall
// whatever its inline cards (`ApproxTextEngine`), so a block after it would lie over the card's
// middle and take its press; a real window grows the line to the card.
const SOURCE = [
  "## 周报草稿",
  "",
  "已写进 `notes/weekly.md`。请 @Editor 看一下，有问题找 @Nobody。",
  "",
  "- 第一条 **加粗**",
  "- 第二条 [官网](https://example.com)",
  "",
  "> 引用一段话",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "| 列 | 值 |",
  "|---|---|",
  "| a | 1 |",
  "",
  "图表见 `charts/trend.png`。",
].join("\n");

const BOTS = [{ id: "bot-editor", name: "Editor" }];
const PIXEL = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13,
  73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 0, 5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

export default function Shared() {
  const opened = signal("");
  const enlarged = signal<{ path: string; origin: ImageOrigin | null; shown: string | null } | null>(null);
  const modal = signal(false);
  const danger = signal(false);
  const busy = signal(false);
  const option = signal(false);
  return (
    <View class="flex-1 flex-row gap-6 p-6 bg-bg">
      <View class="flex-1 gap-3 min-w-0">
        <View class="p-4 rounded-(--radius-md) bg-pane border border-line">
          <MarkdownBody
            testID="md"
            source={SOURCE}
            copyLabel="复制"
            options={{ mentionBots: BOTS, unresolvedMentionTitle: "不在这个对话里" }}
            onOpenArtifact={(path) => opened.set(`artifact:${path}`)}
            onOpenImage={(path, from) => {
              opened.set(`image:${path} from:${from?.view ? "thumb" : "none"}:${from?.shown?.startsWith("data:") ? "shown" : "none"}`);
              void imageOrigin(from?.view).then((origin) => {
                opened.set(`${opened()} origin:${origin ? `${Math.round(origin.width)}x${Math.round(origin.height)}` : "none"}`);
                enlarged.set({ path, origin, shown: from?.shown ?? null });
              });
            }}
            onOpenProfile={(id) => opened.set(`profile:${id}`)}
            loadArtifactImage={async () => new Blob([PIXEL], { type: "image/png" })}
            files={{
              locate: async (path) => `/ws/${path}`,
              open: async (abs, reveal) => {
                opened.set(`${reveal ? "reveal" : "open"}:${abs}`);
                return true;
              },
            }}
          />
        </View>
        <View class="p-4 rounded-(--radius-md) bg-brand self-end max-w-[420px]">
          <MarkdownBody testID="md-inverted" inverted source={"我的消息，带 `code` 和 `notes/weekly.md`"} copyLabel="复制" />
        </View>
        <Text testID="opened" class="text-[12px] text-ink-muted">{opened() || "—"}</Text>
      </View>
      <View class="w-[260px] gap-3">
        <View class="flex-row gap-2 items-center">
          <FileIcon icon={fileIconFor("a.ts")} />
          <FileIcon icon={fileIconFor("b.py")} />
          <FileIcon icon={fileIconFor("c.md")} />
          <FileIcon icon={fileIconFor("d.png")} />
          <FileIcon icon={fileIconFor("folder", { isDir: true })} />
        </View>
        <Button testID="open-modal" onPress={() => modal.set(true)}>打开对话框</Button>
        <Button testID="open-danger" variant="danger-soft" onPress={() => danger.set(true)}>删除小组</Button>
        <Text testID="danger-state" class="text-[12px] text-ink-muted">{`option:${option() ? "on" : "off"}`}</Text>
      </View>
      <If when={modal()}>
        <Modal
          title="新建 Bot"
          closeLabel="关闭"
          testID="modal"
          onClose={() => modal.set(false)}
          foot={
            <>
              <ModalAction kind="primary" testID="modal-save" onPress={() => modal.set(false)}>创建</ModalAction>
              <ModalAction onPress={() => modal.set(false)}>关闭</ModalAction>
            </>
          }
        >
          <Text class="text-[14px] text-ink">对话框的内容</Text>
        </Modal>
      </If>
      <If when={enlarged()}>
        {(e: () => { path: string; origin: ImageOrigin | null; shown: string | null }) => (
          <MessageImageLightbox relpath={e().path} src={e().shown} origin={e().origin} api={null} onClose={() => enlarged.set(null)} />
        )}
      </If>
      <If when={danger()}>
        <DangerDialog
          copy={{ title: "删除这个小组？", body: "消息会一起删除，无法恢复。", confirm: "删除", cancel: "取消", option: "同时删除文件", busy: "正在删除…" }}
          busy={busy()}
          optionChecked={option()}
          onOptionChange={(v) => option.set(v)}
          onDismiss={() => danger.set(false)}
          onConfirm={() => {
            busy.set(true);
            setTimeout(() => {
              busy.set(false);
              danger.set(false);
            }, 300);
          }}
        />
      </If>
    </View>
  );
}
