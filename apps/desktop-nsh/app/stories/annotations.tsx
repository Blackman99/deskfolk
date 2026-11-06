/** The annotation surfaces: the composer, the send bar, the cards and the list, and the four annotators (picture, Markdown, video, HTML page). */
import { batch, colorScheme, signal, Text, View } from "nsh";
import type { Annotation } from "@real-bot/protocol";
import { copy } from "../src/runtime";
import { Button } from "../src/ui/Button";
import { AnnotationCards } from "../src/ui/annotations/AnnotationCards";
import { AnnotationComposer } from "../src/ui/annotations/AnnotationComposer";
import { AnnotationList } from "../src/ui/annotations/AnnotationList";
import { AnnotationSendBar } from "../src/ui/annotations/AnnotationSendBar";
import { HtmlAnnotator, type HtmlAnnotatorHandle } from "../src/ui/annotations/HtmlAnnotator";
import { ImageAnnotator } from "../src/ui/annotations/ImageAnnotator";
import { MarkdownAnnotator } from "../src/ui/annotations/MarkdownAnnotator";
import { MediaAnnotator } from "../src/ui/annotations/MediaAnnotator";

function row(over: Partial<Annotation> & { id: string }): Annotation {
  return {
    status: "open",
    relpath: "docs/weekly.md",
    anchor_kind: "text_range",
    anchor: { start_line: 3, start_col: 1, end_line: 4, end_col: 5, quote: "const x", prefix: "", suffix: "" },
    content_sha256: "0".repeat(64),
    target_message_id: "m1",
    target_session_id: "sess-1",
    target_turn_id: null,
    bot_id: "bot-1",
    session_id: "sess-1",
    message_id: "m2",
    body: "这里换个名字",
    crop_mime: null,
    resolved_by: null,
    resolved_note: null,
    resolved_at: null,
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
    stale: null,
    ...over,
  } as Annotation;
}

const BOTS = new Map([["bot-1", { name: "Writer" }]]);

/** A 400 × 250 plain picture. */
const PICTURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAZAAAAD6CAIAAAAAxYYTAAACfklEQVR42u3UQQkAAAgEwetf0QSCIUxgAGFgEuxjUz0AL0QCwLAADAswLADDAjAswLAADAvAsADDAjAsAMMCDAvAsAAMCzAsAMMCMCzAsAAMC8CwAMMCMCwAwwIMC8CwAAwLMCwAwwIMSwXAsAAMCzAsAMMCMCzAsAAMC8CwAMMCMCwAwwIMC8CwAAwLMCwAwwIwLMCwAAwLwLAAwwIwLADDAgwLwLAADAswLADDAgxLBcCwAAwLMCwAwwIwLMCwAAwLwLAAwwIwLADDAgwLwLAADAswLADDAjAswLAADAvAsADDAjAsAMMCDAvAsAAMCzAsAMMCDAvAsAAMCzAsAMMCMCzAsAAMC8CwAMMCMCwAwwIMC8CwAAwLMCwAwwIwLMCwAAwLwLAAwwIwLADDAgwLwLAADAswLADDAgwLwLAADAswLADDAjAswLAADAvAsADDAjAsAMMCDAvAsAAMCzAsAMMCMCzAsAAMC8CwAMMCMCwAwwIMC8CwAAwLMCwAwwIMC8CwAAwLMCwAwwIwLMCwAAwLwLAAwwIwLADDAgwLwLAADAswLADDAjAswLAADAvAsADDAjAsAMMCDAvAsAAMCzAsAMMCDAvAsAAMCzAsAMMCMCzAsAAMC8CwAMMCMCwAwwIMC8CwAAwLMCwAwwIwLMCwAAwLwLAAwwIwLADDAgwLwLAADAswLADDAgwLwLAADAswLADDAjAswLAADAvAsADDAjAsAMMCDAvAsAAMCzAsAMMCMCzAsAAMC8CwAMMCMCwAwwIMC8CwAAwLMCwAwwIMC8CwAAwLMCwAwwIwLMCwAAwLwLAAwwIwLADDAgwLwLAADAswLADDArgt0wcLh4lXU/cAAAAASUVORK5CYII=";

const MARKDOWN = ["# 周报", "", "本周完成了 **登录改版**，见 [设计稿](https://example.com/d)。", "", "- 下周：接入支付", "- 风险：人手不足"].join("\n");

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Demo</title></head><body><main><h1>Title</h1><p id="intro">An intro line.</p></main></body></html>`;

const KINDS = ["list", "cards", "composer", "sendbar", "image", "markdown", "media", "html"] as const;
type Kind = (typeof KINDS)[number];

export default function Annotations() {
  const kind = signal<Kind>("list");
  const log = signal<string[]>([]);
  const note = (line: string) => log.set([...log(), line]);
  const rows = signal<Annotation[]>([
    row({ id: "d", status: "draft", message_id: null, body: "草稿的意见" }),
    row({ id: "o", body: "待处理的意见" }),
    row({ id: "r", status: "resolved", resolved_by: "bot-1", resolved_note: "改名为 picked", body: "已处理的意见" }),
  ]);
  const imageRows = signal<Annotation[]>([
    row({ id: "i1", relpath: "pic.png", anchor_kind: "image_region", anchor: { x: 0.1, y: 0.2, w: 0.3, h: 0.4, natural_width: 400, natural_height: 250 }, body: "这个圈偏了" }),
  ]);
  const mdRows = signal<Annotation[]>([
    row({ id: "m1", anchor: { start_line: 3, start_col: 9, end_line: 3, end_col: 13, quote: "登录改版", prefix: "", suffix: "", view: "rendered" } as never, body: "改版范围写清楚" }),
  ]);
  const mediaRows = signal<Annotation[]>([
    row({ id: "v1", relpath: "clip.mp4", anchor_kind: "media_time", anchor: { start_ms: 30_000, duration_ms: 120_000 }, body: "这里卡了一下" }),
  ]);
  const htmlRows = signal<Annotation[]>([
    row({
      id: "h1",
      relpath: "site/index.html",
      anchor_kind: "html_element",
      anchor: { selector: "body > main > h1", tag: "h1", text: "Title", outer_html: "<h1>Title</h1>", rect: { x: 0, y: 0, w: 1, h: 0.1 } },
      body: "标题换一个",
    }),
  ]);
  const pendingImage = signal<{ x: number; y: number; w: number; h: number; natural_width: number; natural_height: number } | null>(null);
  const pendingMedia = signal<{ start_ms: number; end_ms?: number; duration_ms: number } | null>(null);
  const pendingHtml = signal<import("@real-bot/protocol").HtmlElementAnchor | null>(null);
  const annotating = signal(true);
  const focus = signal<string | null>(null);
  const focusSeq = signal(0);
  const sending = signal(false);
  let handle = null as HtmlAnnotatorHandle | null;
  const html = () => copy().stream.annotHtml;

  /** What the page would say, for a story with no page to click in. */
  const say = (message: (channel: string) => unknown) => {
    const channel = handle?.channel();
    if (channel) handle!.receive(JSON.stringify(message(channel)));
  };

  return (
    <View class="flex-1 gap-3 p-4 bg-bg min-w-0">
      <View class="flex-row flex-wrap gap-2">
        {KINDS.map((k) => (
          <Button testID={`story-${k}`} size="sm" variant={kind() === k ? "primary" : "secondary"} onPress={() => kind.set(k)}>
            {k}
          </Button>
        ))}
      </View>
      <View class="flex-1 min-h-0 min-w-0 border border-line rounded-(--radius-md) bg-pane overflow-hidden">
        <If when={kind() === "list"}>
          <AnnotationList
            annotations={rows()}
            locale="zh"
            bots={BOTS}
            focusId={focus()}
            onReveal={(r) => note(`reveal:${r.id}`)}
            onEdit={(r, body) => {
              note(`edit:${r.id}:${body}`);
              rows.set(rows().map((x) => (x.id === r.id ? { ...x, body } : x)));
            }}
            onDelete={(r) => {
              note(`delete:${r.id}`);
              rows.set(rows().filter((x) => x.id !== r.id));
            }}
            onToggleStatus={(r, status) => {
              note(`status:${r.id}:${status}`);
              rows.set(rows().map((x) => (x.id === r.id ? { ...x, status } : x)));
            }}
            onClose={() => note("close")}
          />
        </If>
        <If when={kind() === "cards"}>
          <AnnotationCards
            annotations={[row({ id: "c1" }), row({ id: "c2", status: "resolved", resolved_by: "user", stale: { kind: "changed" } })]}
            locale="zh"
            bots={BOTS}
            onOpen={(r) => note(`open:${r.id}`)}
            onToggleStatus={(r, status) => note(`status:${r.id}:${status}`)}
            sourceLabel="来自 Writer ↔ Editor 的那条消息"
            onOpenSource={() => note("source")}
          />
        </If>
        <If when={kind() === "composer"}>
          <AnnotationComposer position="第 3 行" busy={false} error={null} onSave={(body) => note(`save:${body}`)} onCancel={() => note("cancel")} />
        </If>
        <If when={kind() === "sendbar"}>
          <AnnotationSendBar
            count={3}
            destination="将发到你和 Writer 的私聊"
            sending={sending()}
            error={null}
            onSend={async (summary) => {
              note(`send:${summary}`);
              return true;
            }}
            onClear={() => note("clear")}
          />
        </If>
        <If when={kind() === "image"}>
          <ImageAnnotator
            src={PICTURE}
            alt="pic.png"
            isSvg={false}
            naturalSize={{ width: 400, height: 250 }}
            annotations={imageRows()}
            focusId={focus()}
            focusSeq={focusSeq()}
            active={annotating()}
            enabled
            labels={copy().stream.annotImage}
            pending={pendingImage()}
            onPendingChange={(a) => pendingImage.set(a as never)}
            onDraft={(d) => {
              note(`draft:${d.anchor.w > 0 ? "box" : "point"}`);
              pendingImage.set(d.anchor as never);
            }}
            onPick={(id) => note(`pick:${id}`)}
            onCancel={() => {
              note("cancel");
              pendingImage.set(null);
            }}
          />
        </If>
        <If when={kind() === "markdown"}>
          <MarkdownAnnotator
            source={MARKDOWN}
            annotations={mdRows()}
            focusId={focus()}
            focusSeq={focusSeq()}
            active={annotating()}
            enabled
            labels={copy().stream.annotMarkdown}
            copyLabel="复制"
            copiedLabel="已复制"
            onDraft={(d) => note(`draft:${d.anchor.start_line}-${d.anchor.end_line}`)}
            onPick={(id) => note(`pick:${id}`)}
            onCancel={() => note("cancel")}
          />
        </If>
        <If when={kind() === "media"}>
          <MediaAnnotator
            src=""
            kind="video"
            annotations={mediaRows()}
            focusId={focus()}
            focusSeq={focusSeq()}
            enabled
            durationSeconds={120}
            labels={copy().stream.annotMedia}
            pending={pendingMedia()}
            onPendingChange={(a) => pendingMedia.set(a as never)}
            onDraft={(d) => {
              note(`draft:${d.anchor.start_ms}`);
              pendingMedia.set(d.anchor as never);
            }}
            onPick={(id) => note(`pick:${id}`)}
            onCancel={() => pendingMedia.set(null)}
          />
        </If>
        <If when={kind() === "html"}>
          <HtmlAnnotator
            html={PAGE}
            scheme={colorScheme()}
            title="site/index.html"
            annotations={htmlRows()}
            focusId={focus()}
            focusSeq={focusSeq()}
            active={annotating()}
            enabled
            labels={html()}
            pending={pendingHtml()}
            readyWaitMs={300}
            handle={(h) => {
              handle = h;
            }}
            onDraft={(d) => {
              note(`draft:${d.anchor.selector}`);
              pendingHtml.set(d.anchor);
            }}
            onPendingChange={(a) => {
              note(`move:${a.selector}`);
              pendingHtml.set(a);
            }}
            onPick={(id) => note(`pick:${id}`)}
            onCancel={() => {
              note("cancel");
              pendingHtml.set(null);
              annotating.set(false);
            }}
            onMissing={(ids) => note(`missing:${ids.join(",")}`)}
          />
        </If>
      </View>
      <View class="flex-row flex-wrap items-center gap-2">
        <Button testID="story-annotating" size="sm" onPress={() => annotating.set(!annotating())}>
          {annotating() ? "annotating" : "viewing"}
        </Button>
        <Button testID="story-focus" size="sm" onPress={() =>
            batch(() => {
              focus.set(kind() === "html" ? "h1" : kind() === "media" ? "v1" : kind() === "image" ? "i1" : "m1");
              focusSeq.set(focusSeq() + 1);
            })
          }>
          focus
        </Button>
        <If when={kind() === "html"}>
          <Button testID="sim-ready" size="sm" onPress={() => say((channel) => ({ channel, type: "ready" }))}>page: ready</Button>
          <Button
            testID="sim-pick"
            size="sm"
            onPress={() =>
              say((channel) => ({
                channel,
                type: "pick",
                anchor: { selector: "body > main > p#intro", tag: "p", text: "An intro line.", outer_html: '<p id="intro">An intro line.</p>', rect: { x: 0, y: 0.1, w: 1, h: 0.05 } },
              }))
            }
          >
            page: pick
          </Button>
          <Button testID="sim-cancel" size="sm" onPress={() => say((channel) => ({ channel, type: "cancel" }))}>page: cancel</Button>
          <Button testID="sim-forged" size="sm" onPress={() => say(() => ({ channel: "0".repeat(32), type: "pick" }))}>page: forged</Button>
          <Button testID="sim-content" size="sm" onPress={() => { const vc = handle?.viewportChannel(); if (vc) handle!.receive(JSON.stringify({ channel: vc, type: "content", width: 1200 })); }}>page: content</Button>
          <Text testID="html-sent" class="text-[12px] text-ink-muted">{`sent:${(log(), (handle as HtmlAnnotatorHandle | null)?.sent().length ?? 0)}`}</Text>
          <Button
            testID="sim-missing"
            size="sm"
            onPress={() => {
              const h = handle as HtmlAnnotatorHandle | null;
              const marks = [...(h?.sent() ?? [])].reverse().map((w) => JSON.parse(w).rbPicker).find((m) => m.type === "marks");
              if (marks) say((channel) => ({ channel, type: "missing", ns: [1], rev: marks.rev }));
            }}
          >
            page: missing
          </Button>
          <Text testID="html-sent-types" class="text-[12px] text-ink-muted">{`types:${(handle as HtmlAnnotatorHandle | null)?.sent().map((w) => JSON.parse(w).rbPicker.type).join(",") ?? ""}`}</Text>
        </If>
      </View>
      <Text testID="events" class="text-[12px] text-ink-muted">{log().length ? log().join(" | ") : "—"}</Text>
    </View>
  );
}
