/**
 * The artifact preview: the file a Bot made, shown by its kind, with the tree of the files beside
 * it, and the pieces around it. The runtime cannot create workspace files (the workspace API only
 * overwrites), so the files are message attachments of a session of this story's own (the way
 * `files-pdf` does), and the preview is the caller: `story-make-<kind>` uploads one and opens it,
 * the others join `siblings`, so the tree lists them. An attachment's copy sits in the workspace
 * (`inbox/`), so saving an edit really overwrites it; `story-read` reads that file back.
 * `story-clean` takes the session away again. One part shows at a time (`story-show-<part>`): preview, workspace, parts.
 * `story-make-project` makes a project session (named "artifacts", so `story-clean` takes it away) on
 * the directory the tests seed (`host.params.projectDir`) and opens its `src/main.py`;
 * `story-read-project` reads that file back; `story-project-target` hangs it on an agent line, as
 * a project session's reply would (ADR 0095 decision 28), to show the annotation gate open;
 * `story-project-elsewhere` opens a file from outside the project (`host.params.elsewhere`) in
 * that preview instead, which keeps the project's tree beside it (decision 29).
 */
import { cleanup, host, Scroll, signal, Text, View, type ViewRef } from "nsh";
import type { Attachment } from "@real-bot/protocol";
import { ShellArtifact } from "../src/m/overlays/shell-artifact.svelte.ts";
import { runtime } from "../src/runtime";
import { WorkspaceDragGhost } from "../src/ui/WorkspaceDragGhost";
import { workspaceDropTarget } from "../src/ui/workspace-drag";
import { ArtifactDirtyDialog } from "../src/ui/overlays/ArtifactDirtyDialog";
import { ArtifactPreview } from "../src/ui/overlays/ArtifactPreview";
import { ArtifactTreeMenu } from "../src/ui/overlays/ArtifactTreeMenu";
import { ShellPreview } from "../src/ui/overlays/ShellPreview";
import { WorkspaceView } from "../src/ui/overlays/WorkspaceView";
import { samplePdf } from "./files-pdf";

const PARTS = ["preview", "workspace", "parts", "shell", "host", "project"] as const;
type Part = (typeof PARTS)[number];

/** A one-pixel PNG. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

const SAMPLES: Record<string, { name: string; mime: string; body: BlobPart }> = {
  png: { name: "dot.png", mime: "image/png", body: PNG },
  md: { name: "notes.md", mime: "text/markdown", body: "# Notes\n\nA line of **notes** the Bot wrote.\n\n- first\n- second\n" },
  ts: { name: "sum.ts", mime: "text/plain", body: "export function sum(a: number, b: number): number {\n  return a + b;\n}\n" },
  same: { name: "sum-copy.ts", mime: "text/plain", body: "export function sum(a: number, b: number): number {\n  return a + b;\n}\n" },
  py: { name: "hello.py", mime: "text/plain", body: "def hello():\n    return 'hi'\n" },
  bin: { name: "data.bin", mime: "application/octet-stream", body: "\u0000\u0001\u0002 not text" },
  pdf: { name: "story.pdf", mime: "application/pdf", body: samplePdf([[612, 792], [792, 612]]) },
};
type Sample = "md" | "ts" | "same" | "py" | "bin" | "pdf" | "png";

export default function Artifacts() {
  const part = signal<Part>("preview");
  const state = signal("idle");
  const log = signal<string[]>([]);
  const logLine = (line: string) => log.set([...log(), line]);
  const files = signal<Attachment[]>([]);
  const current = signal<Attachment | null>(null);
  const sheet = signal(false);
  const noTree = signal(false);
  /** The agent line a project's file would hang on; none until the story says so. */
  const projectTarget = signal<{ messageId: string; sessionId: string; turnId: null; botId: null } | null>(null);
  const menu = signal<{ count: number } | null>(null);
  const dialog = signal(false);
  const artifact = new ShellArtifact({
    runtime: () => runtime,
    selected: () => null,
    wide: () => true,
    shellEl: () => null,
    shellWidth: () => 1100,
    workspacePane: () => null,
    previewPane: () => null,
  });
  /** Stands in for the composer: the whole preview takes the paths dragged out of its tree. */
  let dropRef: ViewRef | null = null;
  cleanup(workspaceDropTarget(() => dropRef, { accepts: () => true, drop: (items) => logLine(`drop:${items.map((item) => item.path).join(",")}`) }));

  /** The runtime's own list of this story's sessions: a fresh read, not what this instance remembers. */
  const mine = async () => {
    const client = runtime.client;
    if (!client) return [];
    return (await client.snapshot()).sessions.filter((session) => session.name === "artifacts");
  };

  /** Uploads one sample as a message attachment of a session of its own (reused when there is one) and opens it. */
  const upload = async (which: Sample) => {
    state.set(`uploading:${which}`);
    try {
      const client = runtime.client;
      if (!client || client.kind !== "local") throw new Error("not connected");
      const sample = SAMPLES[which];
      let sessionId = (await mine())[0]?.id;
      if (!sessionId) {
        const created = (await (client as unknown as { post: (p: string, b: unknown) => Promise<{ id: string }> }).post("/v1/sessions", {
          name: "artifacts",
          members: runtime.snapshot.bots.map((bot) => bot.id),
        })) as { id: string };
        sessionId = created.id;
      }
      const message = await client.postMessage(sessionId, sample.name, { attachments: [new File([sample.body], sample.name, { type: sample.mime })] });
      const att = message.attachments?.[0];
      if (!att) throw new Error("no attachment");
      files.set([...files(), att]);
      current.set(att);
      state.set(`opened:${sample.name}`);
    } catch (e) {
      state.set(`error:${String(e)}`);
    }
  };

  /** Takes this story's sessions away again (deleted, or archived when a delete is refused), and says how many are left. */
  const clean = async () => {
    const client = runtime.client;
    files.set([]);
    current.set(null);
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

  /** The workspace copy of the file on screen, read back from the runtime. */
  const read = async () => {
    const att = current();
    const client = runtime.client;
    if (!att || !client) return;
    try {
      const text = await (await client.getWorkspaceFileBlob(att.workspace_relpath)).text();
      state.set(`read:${JSON.stringify(text)}`);
    } catch (e) {
      state.set(`read-error:${String(e)}`);
    }
  };

  /** The project session's file the tests seed, outside the workspace. */
  const projectDir = String((host.params as { projectDir?: string }).projectDir ?? "");
  const projectFile = projectDir ? `${projectDir}/src/main.py` : "";
  /** A file in neither the workspace nor the project, as an agent may cite from `~/Downloads`. */
  const elsewhere = String((host.params as { elsewhere?: string }).elsewhere ?? "");
  /** What the project's preview shows: its own file, or the one from elsewhere. */
  const projectShown = signal("");
  const makeProject = async () => {
    const client = runtime.client;
    if (!client || !projectDir) return;
    try {
      const made = await client.createProjectSession({ dir: projectDir });
      await client.patchSession(made.id, { name: "artifacts" });
      part.set("project");
      state.set("project:made");
    } catch (e) {
      state.set(`error:${String(e)}`);
    }
  };
  const readProject = async () => {
    const client = runtime.client;
    if (!client || !projectFile) return;
    try {
      state.set(`read:${JSON.stringify(await (await client.getWorkspaceFileBlob(projectFile)).text())}`);
    } catch (e) {
      state.set(`read-error:${String(e)}`);
    }
  };

  const button = (id: string, label: string, onPress: () => void) => (
    <View role="button" testID={id} onPress={onPress} class="px-2 py-1 border border-line rounded-(--radius-sm)">
      <Text class="text-[12px] text-ink">{label}</Text>
    </View>
  );

  return (
    <View testID="artifacts" class="flex-1 bg-pane">
      <View class="flex-row flex-wrap gap-1 p-1 border-b border-line">
        {PARTS.map((name) => button(`story-show-${name}`, name, () => part.set(name)))}
        {(Object.keys(SAMPLES) as Sample[]).map((which) => button(`story-make-${which}`, which, () => void upload(which)))}
        {button("story-clean", "clean", () => void clean())}
        {button("story-read", "read", () => void read())}
        {button("story-make-project", "make project", () => void makeProject())}
        {button("story-read-project", "read project", () => void readProject())}
        {button("story-project-elsewhere", "elsewhere", () => {
          projectShown.set(elsewhere);
          part.set("project");
        })}
        {button("story-project-target", "agent line", () => projectTarget.set({ messageId: "agent-line", sessionId: "project", turnId: null, botId: null }))}
        {button("story-sheet", "sheet", () => sheet.set(!sheet()))}
        {button("story-no-tree", "no tree", () => noTree.set(!noTree()))}
        <Text testID="story-state" class="text-[12px] text-ink-muted">{`state:${state()}`}</Text>
        <Text testID="story-current" class="text-[12px] text-ink-muted">{`current:${current()?.original_filename ?? "none"}`}</Text>
        <Text testID="story-path" class="text-[12px] text-ink-muted">{`path:${current()?.workspace_relpath ?? "none"}`}</Text>
        <Text testID="story-log" class="text-[12px] text-ink-muted">{`log:${log().join(" | ")}`}</Text>
      </View>
      <If when={part() === "preview"}>
        <View testID="story-drop" ref={(node) => (dropRef = node)} class="flex-1 min-h-0">
          <If when={current()}>
            {(att) => (
              <ArtifactPreview
                attachment={att()}
                relpath={att().workspace_relpath}
                siblings={files()}
                api={runtime.client}
                workspacePath={runtime.snapshot.settings.workspace_path ?? null}
                forceTree={files().length > 1}
                noTree={noTree()}
                sheet={sheet()}
                onClose={() => logLine("close")}
                onSelect={(next) => {
                  logLine(`select:${next.original_filename ?? next.workspace_relpath}`);
                  current.set(files().find((row) => row.workspace_relpath === next.workspace_relpath) ?? next);
                }}
                onOpenTerminal={(dir) => logLine(`terminal:${dir}`)}
                ref={(pane) => logLine(`pane:${pane ? "up" : "gone"}`)}
              />
            )}
          </If>
          <If when={!current()}>
            <View class="flex-1 items-center justify-center">
              <Text class="text-ink-muted">no file</Text>
            </View>
          </If>
        </View>
      </If>
      <If when={part() === "project"}>
        <View class="flex-1 min-h-0">
          <ArtifactPreview
            relpath={projectShown() || projectFile}
            projectDir={projectDir}
            target={projectTarget()}
            api={runtime.client}
            workspacePath={runtime.snapshot.settings.workspace_path ?? null}
            sheet
            onClose={() => logLine("project-close")}
            onSelect={(next) => {
              logLine(`project-select:${next.workspace_relpath}`);
              projectShown.set(next.workspace_relpath);
            }}
            onOpenTerminal={(dir) => logLine(`terminal:${dir}`)}
          />
        </View>
      </If>
      <If when={part() === "workspace"}>
        <View class="flex-1 min-h-0">
          <ArtifactPreview
            mode="workspace"
            relpath=""
            api={runtime.client}
            workspacePath={runtime.snapshot.settings.workspace_path ?? null}
            sheet={sheet()}
            onClose={() => logLine("workspace-close")}
            onSelectWorkspacePath={(path) => logLine(`workspace-select:${path}`)}
            onOpenTerminal={(dir) => logLine(`terminal:${dir}`)}
          />
        </View>
      </If>
      <If when={part() === "parts"}>
        <Scroll class="flex-1">
          <View class="flex-row flex-wrap gap-1 p-2">
            {button("story-menu-one", "menu one", () => menu.set({ count: 1 }))}
            {button("story-menu-many", "menu three", () => menu.set({ count: 3 }))}
            {button("story-dirty", "dirty dialog", () => dialog.set(true))}
          </View>
          <If when={menu()}>
            {(m) => (
              <ArtifactTreeMenu
                x={120}
                y={140}
                count={m().count}
                title={m().count > 1 ? null : "notes.md"}
                onOpen={() => logLine("menu-open")}
                onReveal={() => logLine("menu-reveal")}
                onOpenTerminal={() => logLine("menu-terminal")}
                onCopyPath={() => logLine("menu-copy-path")}
                onCopyAbsPath={() => logLine("menu-copy-abs")}
                onTrash={() => logLine(`menu-trash:${m().count}`)}
                onClose={() => menu.set(null)}
              />
            )}
          </If>
          <If when={dialog()}>
            <ArtifactDirtyDialog
              saving={false}
              onCancel={() => {
                logLine("dirty-cancel");
                dialog.set(false);
              }}
              onDiscard={() => {
                logLine("dirty-discard");
                dialog.set(false);
              }}
              onSave={() => {
                logLine("dirty-save");
                dialog.set(false);
              }}
            />
          </If>
        </Scroll>
      </If>
      <If when={part() === "shell"}>
        <View class="flex-1 flex-row min-h-0">
          <View class="w-[200px] items-center justify-center">
            {button("story-shell-open", "open in shell", () => artifact.openArtifactPath(current()?.workspace_relpath ?? ""))}
          </View>
          <ShellPreview wide={!sheet()} locale="zh" botsById={new Map()} artifact={artifact} onPane={(pane) => logLine(`shell-pane:${pane ? "up" : "gone"}`)}>
            {(p) => (
              <ArtifactPreview
                attachment={p.attachment}
                relpath={p.relpath}
                siblings={p.siblings}
                api={p.api}
                workspacePath={p.workspacePath}
                forceTree={p.forceTree}
                taskId={p.taskId}
                projectDir={p.projectDir}
                target={p.target}
                sheet={p.sheet}
                annotations={p.annotations}
                annotationFocusId={p.annotationFocusId}
                annotationFileKey={p.annotationFileKey}
                bots={p.bots}
                locale={p.locale}
                sessions={p.sessions}
                viewedSessionId={p.viewedSessionId}
                onLoadAnnotations={p.onLoadAnnotations}
                onCreateAnnotation={p.onCreateAnnotation}
                onPatchAnnotation={p.onPatchAnnotation}
                onDeleteAnnotation={p.onDeleteAnnotation}
                onSendAnnotations={p.onSendAnnotations}
                onOpenTerminal={p.onOpenTerminal}
                onClose={p.onClose}
                onSelect={p.onSelect}
                onSelectWorkspacePath={p.onSelectWorkspacePath}
                ref={p.ref}
              />
            )}
          </ShellPreview>
        </View>
      </If>
      <If when={part() === "host"}>
        <View class="flex-1 min-h-0">
          <WorkspaceView
            api={runtime.client}
            workspacePath={runtime.snapshot.settings.workspace_path ?? null}
            selected=""
            onClose={() => logLine("host-close")}
            onSelect={(path) => logLine(`host-select:${path}`)}
          >
            {(p) => (
              <ArtifactPreview
                mode="workspace"
                api={p.api}
                workspacePath={p.workspacePath}
                relpath={p.relpath}
                onClose={p.onClose}
                onSelectWorkspacePath={p.onSelectWorkspacePath}
                onOpenTerminal={p.onOpenTerminal}
                ref={p.ref}
              />
            )}
          </WorkspaceView>
        </View>
      </If>
      <WorkspaceDragGhost />
    </View>
  );
}
