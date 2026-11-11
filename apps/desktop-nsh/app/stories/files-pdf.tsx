/**
 * The PDF viewer, the shell's preview column and the workspace host. `ArtifactPreview` (the
 * viewer's caller and the workspace's tree) is a later job, so this story is the caller: it
 * uploads a small PDF to the runtime (a message attachment: the workspace API only overwrites
 * files), points the viewer at its URL, holds the annotation rows, the annotate switch and the
 * pending box, and logs what the viewer reports. One part shows at a time
 * (`story-show-<part>`): viewer, shell, workspace, explorer.
 *
 * Files: `story-make` (three pages, a line of text each: "Page 1 of 3"…), `story-links` (the same
 * with a web link and a link to page 3 on page 1), `story-locked` (one page of text, encrypted;
 * password `open sesame`; its bytes are embedded here, since the module reads them without a fetch),
 * `story-broken`, `story-missing`.
 */
import { Scroll, signal, Text, View } from "nsh";
import type { Annotation, PdfRegionAnchor } from "@real-bot/protocol";
import { ShellArtifact } from "../src/m/overlays/shell-artifact.svelte.ts";
import { runtime } from "../src/runtime";
import { PdfViewer, type PdfSource } from "../src/ui/overlays/PdfViewer";
import { ShellPreview, type ArtifactPane } from "../src/ui/overlays/ShellPreview";
import { WorkspaceExplorer } from "../src/ui/overlays/WorkspaceExplorer";
import { WorkspaceView } from "../src/ui/overlays/WorkspaceView";

/** The password of `LOCKED_PDF`. */
export const LOCKED_PASSWORD = "open sesame";

/** A one-page PDF with "Secret page words", encrypted (40-bit RC4) with `LOCKED_PASSWORD`, in base64 (`cargo test print_locked_fixture -- --ignored --nocapture` in `app/native` makes it). */
const LOCKED_PDF =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gID4+CmVuZG9iago0IDAgb2JqCjw8ICAvTGVuZ3RoIDQ4ID4+CnN0cmVhbQqagLGrH0Rrwrp5vU2gOnk+4jKTmgqXxl2AMvBIfouyHa0eeOc1rBbnA8h5bPJCEFgKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKNiAwIG9iago8PCAvRmlsdGVyIC9TdGFuZGFyZCAvViAxIC9SIDIgL08gPDA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDc+IC9VIDxlMDQ1NDg2NDRkOWFkNjBiNDQ3YmE0N2M5YjQ0NmMwMDljMGU4ZWU4YjJmMTg4NmU5NzgwOGUwM2NkMGYzNGE3PiAvUCAtNCA+PgplbmRvYmoKeHJlZgowIDcKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQyIDAwMDAwIG4gCjAwMDAwMDAzNDEgMDAwMDAgbiAKMDAwMDAwMDQxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDcgL1Jvb3QgMSAwIFIgL0VuY3J5cHQgNiAwIFIgL0lEIFs8MzAzMTMyMzMzNDM1MzYzNzM4Mzk2MTYyNjM2NDY1NjY+IDwzMDMxMzIzMzM0MzUzNjM3MzgzOTYxNjI2MzY0NjU2Nj5dICA+PgpzdGFydHhyZWYKNjA2CiUlRU9GCg==";

/** A PDF whose pages are the given sizes (points), each with a line of text; ASCII, so a character is a byte. With `links`, page 1 carries a web link over its text and a link to page 3. */
export function samplePdf(sizes: [number, number][], links = false): string {
  const objs: string[] = [];
  const kids = sizes.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${sizes.length} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  sizes.forEach(([w, h], i) => {
    // A second word to the right of the page's middle, for a box drawn down and right from the middle.
    const text = `BT /F1 24 Tf 72 ${h - 100} Td (Page ${i + 1} of ${sizes.length}) Tj ET BT /F1 24 Tf ${w / 2 + 60} ${h / 2 - 30} Td (Middle) Tj ET`;
    const annots = links && i === 0 ? ` /Annots [${4 + sizes.length * 2} 0 R ${5 + sizes.length * 2} 0 R]` : "";
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >>${annots} >>`);
    objs.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  });
  if (links) {
    objs.push("<< /Type /Annot /Subtype /Link /Rect [72 672 200 712] /A << /S /URI /URI (https://example.com/linked) >> >>");
    objs.push(`<< /Type /Annot /Subtype /Link /Rect [72 600 200 640] /A << /S /GoTo /D [${4 + (sizes.length - 1) * 2} 0 R /Fit] >> >>`);
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

const PARTS = ["viewer", "shell", "workspace", "explorer"] as const;
type Part = (typeof PARTS)[number];

const row = (id: string, status: Annotation["status"], page: number, x: number, y: number, body: string, stale = false): Annotation =>
  ({
    id,
    status,
    relpath: "story.pdf",
    anchor_kind: "pdf_region",
    anchor: { page, x, y, w: 0.3, h: 0.1 },
    body,
    stale: stale ? { kind: "changed" } : null,
  }) as unknown as Annotation;

const ROWS = [
  row("m1", "open", 1, 0.1, 0.1, "open remark"),
  row("m2", "draft", 1, 0.1, 0.4, "draft remark"),
  row("m3", "resolved", 2, 0.3, 0.3, "resolved remark"),
  row("m4", "open", 2, 0.5, 0.6, "stale remark", true),
  row("m5", "open", 9, 0.1, 0.1, "page that is gone"),
];

export default function FilesPdf() {
  const part = signal<Part>("viewer");
  const source = signal<PdfSource | null>(null);
  const state = signal("idle");
  const annotations = signal<Annotation[]>([]);
  const active = signal(false);
  const enabled = signal(true);
  const pending = signal<PdfRegionAnchor | null>(null);
  const focusId = signal<string | null>(null);
  const focusSeq = signal(0);
  const log = signal<string[]>([]);
  const logLine = (line: string) => log.set([...log(), line]);
  const dark = signal(false);
  const unset = signal(false);
  let handle: { handleEscape: () => boolean; openFind: () => void } | null = null;

  const artifact = new ShellArtifact({
    runtime: () => runtime,
    selected: () => null,
    wide: () => true,
    shellEl: () => null,
    shellWidth: () => 1100,
    workspacePane: () => null,
    previewPane: () => null,
  });
  const pane: ArtifactPane = {
    requestCloseFromParent: (after) => {
      artifact.closeArtifactPreview();
      after?.();
    },
    closeFind: () => false,
    blocksClose: () => false,
  };

  /** The runtime's own list of this story's sessions: a fresh read, not what this instance remembers. */
  const mine = async () => {
    const client = runtime.client;
    if (!client) return [];
    return (await client.snapshot()).sessions.filter((session) => session.name === "files-pdf");
  };

  /** Uploads `content` as a message attachment of a session of its own (reused when there is one), and points the viewer at it. */
  const upload = async (name: string, content: string) => {
    state.set("uploading");
    try {
      const client = runtime.client;
      if (!client || client.kind !== "local") throw new Error("not connected");
      let sessionId = (await mine())[0]?.id;
      if (!sessionId) {
        const created = (await (client as unknown as { post: (p: string, b: unknown) => Promise<{ id: string }> }).post("/v1/sessions", {
          name: "files-pdf",
          members: runtime.snapshot.bots.map((bot) => bot.id),
        })) as { id: string };
        sessionId = created.id;
      }
      const message = await client.postMessage(sessionId, name, { attachments: [new File([content], name, { type: "application/pdf" })] });
      const id = message.attachments?.[0]?.id;
      if (!id) throw new Error("no attachment");
      const { origin, token } = client.endpoint;
      source.set({ url: `${origin}/v1/attachments/${id}/content`, token });
      state.set("source");
    } catch (e) {
      state.set(`error:${String(e)}`);
    }
  };

  const button = (id: string, label: string, onPress: () => void) => (
    <View role="button" testID={id} onPress={onPress} class="px-2 py-1 border border-line rounded-(--radius-sm)">
      <Text class="text-[12px] text-ink">{label}</Text>
    </View>
  );

  /** Takes this story's sessions away again (deleted, or archived when a delete is refused), and says how many are left. */
  const clean = async () => {
    const client = runtime.client;
    source.set(null);
    if (!client) return;
    for (const session of await mine()) {
      try {
        await client.deleteSession(session.id);
      } catch {
        await client.archiveSession(session.id).catch(() => undefined);
      }
    }
    const left = (await mine()).filter((session) => !session.archived_at);
    state.set(`clean:${left.length}`);
  };

  return (
    <View testID="files-pdf" class="flex-1 bg-pane">
      <View class="flex-row flex-wrap gap-1 p-1 border-b border-line">
        {PARTS.map((name) => button(`story-show-${name}`, name, () => part.set(name)))}
        {button("story-make", "make", () => void upload("story.pdf", samplePdf([[612, 792], [792, 612], [612, 792]])))}
        {button("story-links", "links", () => void upload("links.pdf", samplePdf([[612, 792], [792, 612], [612, 792]], true)))}
        {button("story-locked", "locked", () => {
          state.set("source");
          source.set({ base64: LOCKED_PDF });
        })}
        {button("story-find", "find", () => handle?.openFind())}
        {button("story-broken", "broken", () => void upload("broken.pdf", "this is not a pdf"))}
        {button("story-missing", "missing", () => {
          const client = runtime.client;
          if (client && client.kind === "local") source.set({ url: `${client.endpoint.origin}/v1/attachments/none/content`, token: client.endpoint.token });
        })}
        {button("story-clean", "clean", () => void clean())}
        {button("story-marks", "marks", () => annotations.set(ROWS))}
        {button("story-annotate", "annotate", () => active.set(!active()))}
        {button("story-disable", "disable", () => enabled.set(!enabled()))}
        {button("story-pending", "pending", () => pending.set({ page: 1, x: 0.2, y: 0.2, w: 0.3, h: 0.1 }))}
        {button("story-focus", "focus", () => {
          focusId.set("m3");
          focusSeq.set(focusSeq() + 1);
        })}
        {button("story-unset", "unset", () => unset.set(!unset()))}
        {button("story-dark", "dark", () => dark.set(!dark()))}
        {button("story-escape", "escape", () => logLine(`escape:${handle?.handleEscape()}`))}
        {button("story-open-preview", "open preview", () => artifact.openArtifactPath("notes/story.md"))}
        <Text testID="story-width" class="text-[12px] text-ink-muted">{`width:${artifact.previewWidth}`}</Text>
        <Text testID="story-state" class="text-[12px] text-ink-muted">{`state:${state()}`}</Text>
        <Text testID="story-log" class="text-[12px] text-ink-muted">{`log:${log().join(" | ")}`}</Text>
      </View>
      <If when={part() === "viewer"}>
        <View class="flex-1 min-h-0 p-2">
          <PdfViewer
            source={source()}
            theme={dark() ? "dark" : "light"}
            annotations={annotations()}
            focusId={focusId()}
            focusSeq={focusSeq()}
            active={active()}
            enabled={enabled()}
            pending={pending()}
            onDraft={(draft) => {
              logLine(`draft:${JSON.stringify(draft.anchor)}`);
              void draft.crop?.().then((crop) => logLine(crop ? `crop:${crop.mime}:${crop.base64.length}` : "crop:none"));
              pending.set(draft.anchor);
            }}
            onPick={(id) => logLine(`pick:${id}`)}
            onPendingChange={(anchor) => {
              logLine(`pending:${JSON.stringify(anchor)}`);
              pending.set(anchor);
            }}
            onCancel={() => {
              logLine("cancel");
              pending.set(null);
              active.set(false);
            }}
            onHandle={(h) => {
              handle = h;
            }}
          />
        </View>
      </If>
      <If when={part() === "shell"}>
        <View class="flex-1 flex-row min-h-0">
          <View class="flex-1 items-center justify-center"><Text class="text-ink-muted">conversation</Text></View>
          <ShellPreview wide locale="zh" botsById={new Map()} artifact={artifact}>
            {(preview) => (
              <View testID="story-artifact-preview" class="w-[420px] p-2">
                <Text testID="story-preview-path">{`preview:${preview.relpath}:${preview.sheet ? "sheet" : "column"}`}</Text>
                {button("story-pane", "pane", () => preview.ref(pane))}
              </View>
            )}
          </ShellPreview>
        </View>
      </If>
      <If when={part() === "workspace"}>
        <View class="flex-1 min-h-0">
          <WorkspaceView
            api={runtime.client}
            workspacePath={unset() ? null : (runtime.snapshot.settings.workspace_path ?? null)}
            selected="notes/a.md"
            onClose={() => logLine("workspace-close")}
            onSelect={(path) => logLine(`select:${path}`)}
            onOpenSettings={() => logLine("open-settings")}
          >
            {(preview) => (
              <View testID="story-workspace-preview" class="p-2">
                <Text testID="story-workspace-path">{`workspace:${preview.relpath}`}</Text>
                {button("story-pick", "pick", () => preview.onSelectWorkspacePath("notes/b.md"))}
              </View>
            )}
          </WorkspaceView>
        </View>
      </If>
      <If when={part() === "explorer"}>
        <WorkspaceExplorer
          api={runtime.client}
          workspacePath="/tmp/workspace"
          selected="notes/a.md"
          onClose={() => {
            logLine("explorer-close");
            part.set("viewer");
          }}
          onSelect={(path) => logLine(`select:${path}`)}
        >
          {(preview) => (
            <Scroll class="flex-1">
              <Text testID="story-explorer-path">{`explorer:${preview.relpath}`}</Text>
              {button("story-explorer-pane-close", "close", preview.onClose)}
            </Scroll>
          )}
        </WorkspaceExplorer>
      </If>
    </View>
  );
}
