/**
 * A project session's composer (the box of `ProjectChat.svelte`): the line on top, the clip, Plan
 * mode, the consultant switch, the account / model / thinking picker, the microphone, Stop and Send under it, as in the
 * agents' own apps. Pictures and files of any type go with a line as in a Bot's composer: pasted
 * (a Finder copy too), dropped from Finder on the conversation, or picked with the clip, staged on
 * the conversation and kept there until the Mac has them (`composer-drop.tsx`); rows dragged from a
 * file tree wait as chips too, and go out as a Bot's composer sends them when they are in the
 * workspace, else as their paths in the line (`splitDraggedPaths`). Typing `/` at the
 * start lists the agent's commands (the box, `ComposerEditor`, owns that list and its keys);
 * Shift+Tab switches plan mode as in the terminal, where the agent has one.
 *
 * Differences from the Svelte box, from the platform: the line is the shared `ComposerEditor` (an
 * `Input`; no textarea, no `selectionStart`); the card sits under the transcript in the column
 * rather than floating over it (see `ChatStage`); Shift+Tab is a window key while the conversation
 * is mounted, as NSH tells an input nothing of a key it does not take.
 */
import { cleanup, keymap, signal, Text, View } from "nsh";
import type { PasteEvent } from "nsh/types";
import { speechReady, type SessionSummary } from "@real-bot/protocol";
import { ComposerAttachments as StagedFiles, uploadedShare } from "../../m/chat/composer-attachments.svelte";
import { splitDraggedPaths } from "../../m/chat/attachments";
import type { WorkspaceDragItem } from "../../m/workspace-drag.svelte";
import { ComposerVoice, insertHeardAt, spacedHeard, type Caret } from "../../m/chat/composer-voice.svelte";
import { VoiceRecorder } from "../../m/chat/voice-recorder";
import { copy, runtime } from "../../runtime";
import { Icon } from "../Icon";
import { shadow } from "../styles";
import { tip } from "../tip";
import { AgentTune } from "./AgentTune";
import { ConsultPill } from "./ConsultPill";
import { ComposerAttachments } from "./ComposerAttachments";
import { DropVeil, pickInto, stageUris, type ReadUris } from "./composer-drop";
import type { ComposerEditorHandle } from "./ComposerEditor";
import type { SendFlight } from "./send-flight";
import { ComposerEditor } from "../lazy-views";
import { SendButton } from "./SendButton";
import { StopMenu } from "./StopMenu";
import { VoiceButton } from "./VoiceButton";
import { VoiceStatus } from "./VoiceStatus";
import { agentModels, agentsStatus } from "../../m/chat/project-agent-options.svelte";
import type { ProjectState } from "./project-chat-state";
import { settled } from "../workbench/drag-settle";

/** How the conversation hands this box files dropped elsewhere on it, and rows dragged from a file tree. */
export type ProjectComposerHandle = {
  takesFiles(): boolean;
  stageFiles(uris: string[], mimeTypes?: string[]): void;
  takesWorkspaceItems(): boolean;
  stageWorkspaceItems(items: WorkspaceDragItem[]): void;
};

export function ProjectComposer(props: {
  selected: SessionSummary;
  state: ProjectState;
  /** The line went out: the stage goes to the newest one. */
  onSent: () => void;
  /** The microphone's recording, unless a test brings its own. */
  makeRecorder?: () => VoiceRecorder;
  /** Reads the local files a drop or a Finder copy names; by default through `fs`. */
  readFiles?: ReadUris;
  /** Files from Finder are being dragged over the conversation, outside the card. */
  fileDragOver?: boolean;
  /** How the conversation hands files dropped elsewhere on it to this box. */
  onHandle?: (handle: ProjectComposerHandle | null) => void;
  /** The conversation's flight: a line of words alone flies from here into the transcript (`send-flight`). */
  flight?: SendFlight;
}) {
  const t = () => copy();
  const s = () => props.state;
  const view = () => s().view();
  const connected = () => s().connected();
  const sendFailed = signal(false);
  const width = signal(0);
  let editor: ComposerEditorHandle | null = null;

  // --- what goes with your next line ---
  const files = new StagedFiles({
    runtime: () => runtime,
    selected: () => props.selected,
    view,
    lockedComposer: () => false,
    connected,
    fileDrop: () => false,
    editorEl: () => ({ focus: () => editor?.focus() }) as unknown as HTMLDivElement,
  });
  const staged = () => files.pendingAttachments;
  const stagedPaths = () => files.pendingPaths;
  const sendable = () => Boolean(view().draft.trim()) || staged().length > 0 || stagedPaths().length > 0;

  const canStage = () => connected() && !view().sending;
  async function pickFiles(): Promise<void> {
    if (canStage()) await pickInto(files);
  }
  /** A paste with files (or a Finder copy's) stages them; words paste as the box pastes them. */
  function onPaste(event: PasteEvent): void {
    if (event.files.length > 0) files.addFiles(event.files);
    else if (event.uris.length > 0) void stageUris(files, event.uris, undefined, props.readFiles);
  }
  /** Files from Finder over the card itself. */
  const fileOver = signal(false);
  const dropShown = () => (fileOver() || props.fileDragOver === true) && canStage();
  function onFileDrop(uris: string[], mimeTypes?: string[]): void {
    fileOver.set(false);
    if (canStage()) void stageUris(files, uris, mimeTypes, props.readFiles);
  }
  props.onHandle?.({
    takesFiles: canStage,
    stageFiles: onFileDrop,
    takesWorkspaceItems: () => files.takesWorkspaceItems(),
    stageWorkspaceItems: (items) => files.stageWorkspaceItems(items),
  });
  cleanup(() => props.onHandle?.(null));

  async function send(): Promise<void> {
    if (!sendable() || view().sending) return;
    sendFailed.set(false);
    const target = view();
    const rows = [...staged()];
    const pathRows = [...stagedPaths()];
    const { attach, mention } = splitDraggedPaths(pathRows.map((row) => row.path), s().snapshot().settings.workspace_path ?? null);
    // Measured now, while the words are still in the box.
    const landed = props.flight?.arm(editor?.words() ?? null, target.draft, rows.length === 0 && pathRows.length === 0);
    const sent = await runtime.send({
      sessionId: props.selected.id,
      attachments: rows.length > 0 ? rows.map((row) => row.file) : undefined,
      ...(attach.length > 0 ? { paths: attach } : {}),
      ...(mention.length > 0 ? { lines: mention } : {}),
    });
    landed?.(sent);
    sendFailed.set(!sent);
    if (!sent) return;
    // What was staged goes once the Mac has it, as in a Bot's composer.
    const gone = new Set([...rows, ...pathRows].map((row) => row.id));
    target.stagedAttachments = target.stagedAttachments.filter((row) => !gone.has(row.id));
    target.stagedPaths = target.stagedPaths.filter((row) => !gone.has(row.id));
    editor?.focus();
    props.onSent();
  }

  // --- the microphone (ADR 0073): what is heard goes in where the caret was, and nothing is sent until you send it ---
  let voiceCaret: Caret | null = null;
  const voice = new ComposerVoice({
    api: () => runtime.client,
    t: () => copy(),
    sessionId: () => props.selected.id,
    markCaret: () => {
      voiceCaret = (editor as (ComposerEditorHandle & { selection?: () => Caret }) | null)?.selection?.() ?? null;
    },
    insert: (sessionId, heard) => {
      const caret = voiceCaret;
      voiceCaret = null;
      const target = runtime.sessionView(sessionId);
      if (sessionId !== props.selected.id) {
        target.draft = target.draft + spacedHeard(target.draft, heard);
        return;
      }
      const next = insertHeardAt(target.draft, caret, heard);
      target.draft = next.text;
      sendFailed.set(false);
      setTimeout(() => editor?.setSelection(next.caret), 0);
    },
    makeRecorder: () => (props.makeRecorder ? props.makeRecorder() : new VoiceRecorder()),
  });
  cleanup(() => voice.cancel());
  /** Offered once a speech endpoint is ready, as in a Bot's composer. */
  const voiceOffered = () => speechReady(s().snapshot().settings.speech);

  // Shift+Tab switches plan mode, as in the terminal; where there is none it moves the focus as usual.
  const off = keymap.bind("shift+tab", () => s().caps().plan && s().togglePlan(), { when: "always" });
  cleanup(off);

  const docked = settled(() => width() > 0 && width() <= 480);
  const edge = () => (width() <= 680 ? 12 : 24);
  const refused = () => {
    if (view().sendRefused === "too_many_files") return t().composer.tooManyFiles;
    if (sendFailed() || s().tuneFailed()) return t().project.actionFailed;
    if (s().accountRefused()) return t().project.accountBusy;
    return null;
  };

  return (
    <View
      testID="project-composer"
      class="w-full min-w-0 items-center"
      style={docked() ? undefined : { paddingLeft: edge(), paddingRight: edge(), paddingTop: 8, paddingBottom: 12 }}
      onLayout={(e) => width.set(e.bounds.size.width)}
    >
      <View class={`w-full min-w-0 ${docked() ? "bg-input-bg border-t border-line" : "max-w-[800px]"}`}>
        {/* Focused, it keeps its focus border under the pointer, as a Bot's composer does (`Composer`). */}
        <View
          testID="project-composer-card"
          onFileDragEnter={() => fileOver.set(true)}
          onFileDragLeave={() => fileOver.set(false)}
          onFileDrop={(e) => onFileDrop(e.uris, e.mimeTypes)}
          class={`w-full min-w-0 border bg-input-bg px-2 py-[6px] ${docked() ? "border-0" : "rounded-[18px] border-line hover:border-line-hover focus-within:border-field-focus-border hover:focus-within:border-field-focus-border"}`}
          style={docked() ? undefined : { boxShadow: shadow("raised") }}
        >
          <If when={refused()}>
            {(text: () => string) => (
              <Text role="alert" testID="project-refused" class="text-[12px] text-danger px-1 pt-[2px] pb-[6px]">
                {text()}
              </Text>
            )}
          </If>
          <VoiceStatus voice={voice} />
          <If when={staged().length > 0 || stagedPaths().length > 0}>
            <ComposerAttachments
              api={runtime.client}
              pendingAttachments={staged().slice()}
              pendingPaths={stagedPaths().slice()}
              sending={view().sending}
              uploadedPercent={(file) => uploadedShare(view().upload, file)}
              onRemoveAttachment={files.removePendingAttachment}
              onRemovePath={files.removePendingPath}
            />
          </If>
          <ComposerEditor
            testID="project-input"
            value={view().draft}
            onChange={(text) => {
              view().draft = text;
              sendFailed.set(false);
            }}
            placeholder={s().planning() ? t().project.composerPlaceholderPlan(s().agentName()) : s().consulting() ? t().project.composerPlaceholderConsult(s().agentName()) : t().project.composerPlaceholder(s().agentName())}
            editable
            commands={s().caps().commands ? { agentName: s().agentName(), sessionId: props.selected.id } : null}
            onSend={() => void send()}
            onPaste={onPaste}
            onHandle={(handle) => (editor = handle)}
          />
          <View class="flex-row items-center w-full gap-[6px]">
            <View
              role="button"
              testID="project-attach"
              tooltip={tip(t().composer.attach)}
              accessibilityLabel={t().composer.attach}
              disabled={!connected() || Boolean(view().sending)}
              onPress={() => void pickFiles()}
              class="cursor-pointer select-none disabled:cursor-default group shrink-0 w-[34px] h-[34px] items-center justify-center rounded-full active:scale-[0.96] disabled:opacity-[0.4] hover:bg-line-subtle"
            >
              <Icon name="paperclip" size={20} class="tint-ink-muted group-hover:tint-ink" />
            </View>
            {/* Plan mode, the session's own: on, it plans and asks before changing anything. Claude Code's only. */}
            <If when={s().caps().plan}>
              <View
                role="button"
                testID="project-plan"
                tooltip={tip(s().planning() ? t().project.planOnHint(s().agentName()) : t().project.planOffHint(s().agentName()))}
                accessibilityLabel={t().project.plan}
                accessibilityState={{ selected: s().planning(), disabled: !connected() }}
                disabled={!connected()}
                onPress={s().togglePlan}
                class={`cursor-pointer select-none disabled:cursor-default group shrink-0 flex-row items-center gap-1 h-[28px] pl-[7px] pr-[9px] rounded-full border disabled:opacity-[0.4] ${s().planning() ? "bg-accent-tint border-accent-border" : "border-transparent hover:bg-line-subtle"}`}
              >
                <Icon name="list" size={16} class={s().planning() ? "tint-brand" : "tint-ink-muted group-hover:tint-ink"} />
                <Text class={`text-[12px] font-medium ${s().planning() ? "text-brand" : "text-ink-muted group-hover:text-ink"}`}>{t().project.plan}</Text>
              </View>
            </If>
            {/* The consultant switch (ADR 0116), the session's own: on, every line goes to the chosen consultants first. Every agent has it. */}
            <ConsultPill
              setting={props.selected.project_consult}
              agentName={s().agentName()}
              disabled={!connected()}
              agents={agentsStatus()}
              client={runtime.client}
              onOpen={s().askOptions}
              onChange={(next) => void s().setConsult(next)}
            />
            {/* An account changes for the next run: Claude Code keeps the session under the account it ran on. */}
            <View class="shrink min-w-0 flex-row">
              <AgentTune
                testID="project-tune"
                agent={s().agent()}
                agentName={s().agentName()}
                models={s().claudeSession() ? undefined : agentModels(s().agent())}
                tune={{ account: s().account(), model: props.selected.project_model ?? "", effort: props.selected.project_effort ?? "" }}
                accounts={s().accountShown() ? s().accountOptions() : null}
                accountLocked={s().live()}
                disabled={!connected()}
                client={runtime.client}
                onPick={(change) => void s().tune(change)}
                onOpen={s().askOptions}
              />
            </View>
            <View class="flex-1" />
            <If when={voiceOffered() || voice.busy}>
              <VoiceButton voice={voice} disabled={!connected()} />
            </If>
            <If when={s().stopItems().length > 0}>
              <StopMenu items={s().stopItems()} disabled={!connected()} onPick={s().pickStop} />
            </If>
            {/* Stop beside Send while the agent works, as in a Bot's direct: a line sent meanwhile goes into the run. */}
            <SendButton
              connected={connected()}
              primaryAction={{ kind: "send", disabled: !sendable() || Boolean(view().sending) || !connected() }}
              directStop={s().live() && s().stopItems().length === 0}
              stepsAside={false}
              sending={view().sending}
              upload={view().upload}
              onStop={() => void s().stop()}
              onSend={() => void send()}
            />
          </View>
          <DropVeil shown={dropShown()} testID="project-drop-veil" />
        </View>
      </View>
    </View>
  );
}
