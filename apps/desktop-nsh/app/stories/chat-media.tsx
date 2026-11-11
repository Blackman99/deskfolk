/**
 * The chat's media pieces: the message menu (desktop menu and phone sheet), the text page, a
 * message's file chips and the picture enlargement they open, the file overlay's frame, and the
 * composer's staged files. The runtime client is faked here (a one-pixel picture for every file)
 * so the enlargement's fetch paths run without a conversation behind them; `remote` makes it
 * answer as a phone's link does, with a smaller copy and an offer of the original.
 */
import { signal, Text, View } from "nsh";
import type { Attachment, Message } from "@real-bot/protocol";
import { rememberBlobOriginalSize } from "../src/m/api.ts";
import type { MessengerApi } from "../src/m/messenger-api.ts";
import type { StagedAttachment, StagedWorkspacePath } from "../src/m/session-view.svelte.ts";
import { Button } from "../src/ui/Button";
import { base64 } from "../src/ui/data-url";
import { ComposerAttachments } from "../src/ui/chat/ComposerAttachments";
import { type ImageOrigin, originOf } from "../src/ui/chat/lightbox-fit";
import { MessageAttachments } from "../src/ui/chat/MessageAttachments";
import { MessageContextMenu } from "../src/ui/chat/MessageContextMenu";
import { MessageFileOverlay } from "../src/ui/chat/MessageFileOverlay";
import { MessageImageLightbox } from "../src/ui/chat/MessageImageLightbox";
import { MessageTextSheet } from "../src/ui/chat/MessageTextSheet";

const PIXEL = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13,
  73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 0, 5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);
const PIXEL_URL = `data:image/png;base64,${base64(PIXEL)}`;

/** The client of a conversation, as far as pictures go. */
function fakeClient(kind: "local" | "remote", requests: string[]): MessengerApi {
  const picture = (what: string, size?: string) => {
    requests.push(`${what}${size ? `:${size}` : ""}`);
    const blob = new Blob([PIXEL], { type: "image/png" });
    // A phone's link is sent a scaled copy: the original's length is what the enlargement offers.
    if (kind === "remote" && size) rememberBlobOriginalSize(blob, 2_400_000);
    return Promise.resolve(blob);
  };
  return {
    kind,
    getAttachmentBlob: (id: string, _progress: unknown, options?: { size?: string }) => picture(`attachment ${id}`, options?.size),
    getWorkspaceFileBlob: (path: string, _progress: unknown, options?: { size?: string }) => picture(`workspace ${path}`, options?.size),
  } as unknown as MessengerApi;
}

const ATTACHMENTS: Attachment[] = [
  { id: "att-chart", message_id: "m-1", workspace_relpath: "images/chart.png", original_filename: "chart.png", created_at: "2026-11-06T09:00:00Z" },
];
const DOC: Attachment[] = [
  { id: "att-plan", message_id: "m-1", workspace_relpath: "notes/plan.md", original_filename: "plan.md", created_at: "2026-11-06T09:00:00Z" },
];
const BUNDLE: Attachment[] = [
  ...ATTACHMENTS,
  ...DOC,
];

const MESSAGE = {
  id: "m-1",
  session_id: "s-1",
  turn_id: null,
  parent_id: null,
  kind: "bot",
  author: "bot-1",
  body: "周报在 `notes/plan.md`，另见 `docs/review.md` 和 `src/index.ts`。",
  source_turn_id: null,
  created_at: "2026-11-06T09:00:00Z",
  attachments: [],
  reactions: [],
} as unknown as Message;

export default function ChatMedia() {
  const mode = signal<"local" | "remote">("local");
  const requests = signal<string[]>([]);
  const log = signal<string[]>([]);
  const note = (line: string) => log.set([...log(), line]);
  // One client per mode, so the enlargement's fetch key does not change under a press. Each request
  // is listed for the story's reader (and the tests).
  const client = (kind: "local" | "remote") => {
    const seen: string[] = [];
    return new Proxy(fakeClient(kind, seen), {
      get: (target, key) => {
        const value = (target as unknown as Record<string | symbol, unknown>)[key];
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown)(...args);
          requests.set([...requests(), seen[seen.length - 1] ?? ""]);
          return out;
        };
      },
    });
  };
  const clients = { local: client("local"), remote: client("remote") };
  const api = () => clients[mode()];

  const menu = signal<{ sheet: boolean; selected: string | null; edit: boolean } | null>(null);
  const text = signal(false);
  const file = signal<Attachment | null>(null);
  const lightbox = signal<{ att: Attachment; origin: ImageOrigin | null; placeholder: string | null } | null>(null);
  const staged = signal<StagedAttachment[]>([
    { id: "s-1", file: {} as File, name: "screenshot.png", size: 48_000, isImage: true, previewUrl: PIXEL_URL },
    { id: "s-2", file: {} as File, name: "notes.txt", size: 1_300, isImage: false, previewUrl: null },
  ]);
  const paths = signal<StagedWorkspacePath[]>([
    { id: "p-1", path: "images/chart.png", name: "chart.png", isDir: false, isImage: true, previewUrl: PIXEL_URL },
    { id: "p-2", path: "src", name: "src", isDir: true, isImage: false, previewUrl: null },
  ]);
  const sending = signal(false);

  return (
    <View class="flex-1 flex-row gap-6 p-6 bg-bg">
      <View class="flex-1 gap-4 min-w-0">
        <View class="p-4 rounded-(--radius-md) bg-pane border border-line">
          <Text class="text-[13px] text-ink">{MESSAGE.body}</Text>
          <MessageAttachments
            attachments={ATTACHMENTS}
            api={api()}
            onPreview={(att) => note(`preview:${att.workspace_relpath}`)}
            onOpenImage={(att, from) => {
              // What the chip handed over: its thumbnail's view and what it shows (the enlargement's stand-in).
              note(`image:${att.workspace_relpath} from:${from?.view ? "thumb" : "none"}:${from?.shown?.startsWith("data:") ? "shown" : "none"}`);
              void originOf(from?.view).then((origin) => lightbox.set({ att, origin, placeholder: from?.shown ?? null }));
            }}
            onOpenFile={(att) => file.set(att)}
          />
          <MessageAttachments
            attachments={DOC}
            api={api()}
            onPreview={(att) => note(`preview:${att.workspace_relpath}`)}
            onOpenFile={(att) => file.set(att)}
          />
        </View>
        <View class="p-4 rounded-(--radius-md) bg-pane border border-line">
          <MessageAttachments attachments={BUNDLE} api={api()} onPreview={(att) => note(`bundle:${att.workspace_relpath}`)} />
        </View>
        <View class="p-2 rounded-(--radius-md) bg-pane border border-line">
          <ComposerAttachments
            api={api()}
            pendingAttachments={staged()}
            pendingPaths={paths()}
            sending={sending()}
            uploadedPercent={(f) => (f === staged()[0]?.file && sending() ? 40 : null)}
            onRemoveAttachment={(id) => staged.set(staged().filter((row) => row.id !== id))}
            onRemovePath={(id) => paths.set(paths().filter((row) => row.id !== id))}
          />
        </View>
        <Text testID="log" class="text-[12px] text-ink-muted">{log().join(" | ") || "—"}</Text>
        <Text testID="requests" class="text-[12px] text-ink-muted">{requests().join(" | ") || "—"}</Text>
      </View>
      <View class="w-[220px] gap-2">
        <Button testID="open-menu" onPress={() => menu.set({ sheet: false, selected: null, edit: false })}>消息菜单</Button>
        <Button testID="open-menu-edit" onPress={() => menu.set({ sheet: false, selected: null, edit: true })}>可编辑的消息菜单</Button>
        <Button testID="open-menu-sheet" onPress={() => menu.set({ sheet: true, selected: null, edit: false })}>手机菜单</Button>
        <Button testID="open-text" onPress={() => text.set(true)}>选择文字</Button>
        <Button testID="open-file" onPress={() => file.set(DOC[0]!)}>打开文件</Button>
        <Button testID="send" onPress={() => sending.set(!sending())}>切换发送中</Button>
        <Button testID="remote" onPress={() => mode.set("remote")}>远程</Button>
      </View>
      <If when={menu()}>
        {(open: () => { sheet: boolean; selected: string | null; edit: boolean }) => (
          <MessageContextMenu
            message={MESSAGE}
            x={300}
            y={200}
            sheet={open().sheet}
            onClose={() => {
              note("menu-closed");
              menu.set(null);
            }}
            onReply={() => note("reply")}
            onCopy={(value) => note(`copy:${value}`)}
            onOpenFileTree={(path) => note(`tree:${path}`)}
            onShowTrace={() => note("trace")}
            onCopyId={() => note("copy-id")}
            onReaction={(emoji) => note(`react:${emoji}`)}
            onSelectText={open().sheet ? () => note("select-text") : undefined}
            onEdit={open().edit ? () => note("edit") : undefined}
          />
        )}
      </If>
      <If when={text()}>
        <MessageTextSheet subject="Writer · 10:42" onClose={() => text.set(false)}>
          <Text testID="sheet-text" class="text-[14px] text-ink">第一句。第二句要单独复制。</Text>
        </MessageTextSheet>
      </If>
      <If when={file()}>
        {(open: () => Attachment) => (
          <MessageFileOverlay attachment={open()} relpath={open().workspace_relpath} messageId={null} onClose={() => file.set(null)}>
            {(ctx) => <Text testID="file-preview" class="p-4 text-[13px] text-ink">{`preview:${ctx.relpath()}`}</Text>}
          </MessageFileOverlay>
        )}
      </If>
      <If when={lightbox()}>
        {(open: () => { att: Attachment; origin: ImageOrigin | null; placeholder: string | null }) => (
          <MessageImageLightbox attachment={open().att} origin={open().origin} placeholder={open().placeholder} api={api()} onClose={() => lightbox.set(null)} />
        )}
      </If>
    </View>
  );
}
