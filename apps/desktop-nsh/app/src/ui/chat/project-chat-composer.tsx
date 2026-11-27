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
 * On a phone one + holds the clip, plan mode, the consultants and the model (`ComposerPlus`): the
 * row keeps Send, Stop and the microphone, and plan mode and the consultants as chips while they
 * are on.
 *
 * Differences from the Svelte box, from the platform: the line is the shared `ComposerEditor` (an
 * `Input`; no textarea, no `selectionStart`); the card sits under the transcript in the column
 * rather than floating over it (see `ChatStage`); Shift+Tab is a window key while the conversation
 * is mounted, as NSH tells an input nothing of a key it does not take.
 */
import { cleanup, effect, keymap, platform, signal, Text, View } from "nsh";
import type { PasteEvent } from "nsh/types";
import { speechReady, type SessionSummary } from "@real-bot/protocol";
import { justSent } from "../../m/chat/composer-mode";
import { ComposerAttachments as StagedFiles, uploadedShare } from "../../m/chat/composer-attachments.svelte";
import { splitDraggedPaths } from "../../m/chat/attachments";
import type { WorkspaceDragItem } from "../../m/workspace-drag.svelte";
import { ComposerVoice, insertHeardAt, spacedHeard, type Caret } from "../../m/chat/composer-voice.svelte";
import { VoiceRecorder } from "../../m/chat/voice-recorder";
import { copy, runtime } from "../../runtime";
import { SheetItem } from "../BottomSheet";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { ModelSourceMark } from "../ModelSourceMark";
import { shadow } from "../styles";
import { tip } from "../tip";
import { AgentTune } from "./AgentTune";
import { ComposerPlus, Deeper, PlusSwitch } from "./ComposerPlus";
import { ComposerSuggestions, SuggestButton } from "./ComposerSuggestions";
import { suggestTitleOf } from "./composer-state";
import { ConsultChip, ConsultPill, consultNames, type ConsultHandle } from "./ConsultPill";
import { ProjectContextPill } from "./ProjectContextPill";
import { ComposerAttachments } from "./ComposerAttachments";
import { DropVeil, pickInto, stageUris, type ReadUris } from "./composer-drop";
import type { ComposerEditorHandle } from "./ComposerEditor";
import type { SendFlight } from "./send-flight";
import { ComposerEditor } from "../lazy-views";
import { ScrollBottomButton } from "./ScrollBottomButton";
import { SendButton } from "./SendButton";
import { StopMenu } from "./StopMenu";
import { tuneLine, type ShownTuneHandle } from "./TunePicker";
import { VoiceButton } from "./VoiceButton";
import { VoiceStatus } from "./VoiceStatus";
import { WaitingJump } from "./WaitingJump";
import type { HiddenWaiting } from "./waiting-jump";
import { agentModels, agentsStatus, claudeStatus } from "../../m/chat/project-agent-options.svelte";
import type { ProjectState } from "./project-chat-state";
import { settled } from "../workbench/drag-settle";
import { phoneChips } from "../../m/chat/phone-chips";
import { dockedComposerInsets, floatingComposerSafeEdges } from "../../platform/phone-device";

const NO_WAITING: HiddenWaiting = { items: [], above: false };

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
  /** The stage owns stick-to-bottom; this draws the jump control on the card. */
  showScrollBottom?: boolean;
  onScrollToBottom?: () => void;
  /** Pending approval or questions scrolled out of sight. */
  hiddenWaiting?: HiddenWaiting;
  onJumpWaiting?: (id: string) => void;
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
  let sentAt: number | null = null;

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
    sentAt = performance.now();
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
  const compact = settled(() => width() > 0 && width() <= 440);
  const edge = () => (width() <= 680 ? 12 : 24);
  const phone = () => narrowWindow();
  /** Active mode chips shown on the phone row (`plan` / `consult`): when on, the editor sits above the chips inside one unified rounded card. */
  const phoneHasChips = () => Boolean((s().caps().plan && s().planning()) || s().consulting());
  /** On a docked phone with no active chips, keep the editor inline beside `+` and Send inside a rounded pill. */
  const inlinePhone = () => docked() && phone() && !phoneHasChips();
  /** On a docked phone with active chips, wrap editor + chip row inside a clearly bounded rounded card. */
  const framedPhoneCard = () => docked() && phone() && phoneHasChips();
  const phonePillButtons = () => inlinePhone() && !platform.desktop;
  const dockedInsets = dockedComposerInsets(width);
  const footerStyle = () => {
    if (docked()) return undefined;
    const safe = floatingComposerSafeEdges();
    return { paddingLeft: edge() + safe.left, paddingRight: edge() + safe.right, paddingTop: 8, paddingBottom: 12 + safe.bottom };
  };
  /** Outer dock padding around a framed 2-row phone card (so the card's internal 6 pt padding lands `+` and Send at the exact corner-safe inset). */
  const framedDockStyle = () => {
    if (!framedPhoneCard()) return undefined;
    if (platform.desktop) return { paddingLeft: 8, paddingRight: 8, paddingTop: 6, paddingBottom: 6 };
    const ins = dockedInsets();
    const sideLeft = ins.cardLeft + ins.rowExtraLeft;
    const sideRight = ins.cardRight + ins.rowExtraRight;
    return {
      paddingLeft: Math.max(6, sideLeft - 6),
      paddingRight: Math.max(6, sideRight - 6),
      paddingTop: 8,
      paddingBottom: ins.cardBottom,
    };
  };
  const cardStyle = () => {
    if (!docked()) return { boxShadow: shadow("raised") };
    if (framedPhoneCard()) return undefined;
    if (platform.desktop) return undefined;
    const ins = dockedInsets();
    return {
      paddingLeft: ins.cardLeft + ins.rowExtraLeft,
      paddingRight: ins.cardRight + ins.rowExtraRight,
      paddingTop: 8,
      paddingBottom: ins.cardBottom,
    };
  };

  // --- ✨ suggestions ---
  const suggestionsShown = () => view().composerSuggestions.length > 0 || Boolean(view().suggestionsEmpty);
  const suggestWaiting = () => s().live();
  const suggestBlocked = () => !view().suggestionsLoading && !suggestionsShown() && (!connected() || suggestWaiting() || Boolean(view().sending));
  const suggestSize = () => (docked() && !platform.desktop ? "w-[40px] h-[40px]" : "w-[34px] h-[34px]");
  /** Send greyed with nothing to send steps aside on a phone row for ✨ or Stop (matches `Composer`). */
  const sendStepsAside = () => docked() && !sendable() && !view().sending && (s().live() || s().stopItems().length > 0 || !suggestBlocked());

  /** One press drafts once; pressing again while drafts are out or on the way puts them away. */
  function toggleSuggestions(): void {
    const current = view();
    if (current.suggestionsLoading || suggestionsShown()) {
      runtime.dismissComposerSuggestions(props.selected.id);
      return;
    }
    if (justSent(sentAt, performance.now())) return;
    void runtime.suggestComposer(props.selected.id);
  }

  function pickSuggestion(prompt: string): void {
    view().draft = prompt;
    sendFailed.set(false);
    setTimeout(() => editor?.focus(), 0);
  }

  // "Nothing to suggest" answers the press; it is not worth keeping on screen.
  effect(() => {
    const current = view();
    if (!current.suggestionsEmpty) return;
    const timer = setTimeout(() => {
      current.suggestionsEmpty = false;
    }, 4000);
    return () => clearTimeout(timer);
  });
  /**
   * A phone: the + holds the clip, plan mode, the consultants and the model. Their sheets are opened
   * through these handles: the model's and the consultants' from inside the +'s sheet, whose content
   * holds them (in the phone e2e a dialog opened from under another one did not show on the web), the consultants'
   * chip's from outside the row.
   */
  const tuneSheet = signal<ShownTuneHandle | null>(null);
  const plusConsult = signal<ConsultHandle | null>(null);
  let chipConsult: ConsultHandle | null = null;
  const consultDetail = () => {
    const names = consultNames(props.selected.project_consult);
    if (!names) return t().project.consultNone;
    return s().consulting() ? names : `${t().project.consultOff} · ${names}`;
  };
  const tuneMark = () => tuneSheet()?.shown().mark ?? null;
  /** The phone row's width and what stands right of its chips, measured: the chips take what is left (`phone-chips.ts`). */
  const rowWidth = signal(0);
  const rightWidth = signal(0);
  const chips = () =>
    phoneChips(
      rowWidth() - rightWidth() - 40 - 3 * 6,
      s().caps().plan && s().planning(),
      s().consulting() ? (props.selected.project_consult?.members.length ?? 0) : 0,
    );
  const refused = () => {
    if (view().sendRefused === "too_many_files") return t().composer.tooManyFiles;
    if (sendFailed() || s().tuneFailed()) return t().project.actionFailed;
    if (s().accountRefused()) return t().project.accountBusy;
    return null;
  };

  /**
   * Plan mode, the session's own: on, it plans and asks before changing anything, where the agent has
   * one (`caps().plan`). Without its word (the phone's chip beside the consultants'), the icon alone.
   */
  const planPill = (words = true) => (
    <View
      role="button"
      testID="project-plan"
      tooltip={tip(s().planning() ? t().project.planOnHint(s().agentName()) : t().project.planOffHint(s().agentName()))}
      accessibilityLabel={t().project.plan}
      accessibilityState={{ selected: s().planning(), disabled: !connected() }}
      disabled={!connected()}
      onPress={s().togglePlan}
      class={`cursor-pointer select-none disabled:cursor-default group shrink-0 flex-row items-center gap-1 ${phone() ? "h-[36px]" : "h-[28px]"} ${words ? "pl-[7px] pr-[9px]" : "px-[7px]"} rounded-full border disabled:opacity-[0.4] ${s().planning() ? "bg-accent-tint border-accent-border" : "border-transparent hover:bg-line-subtle"}`}
    >
      <Icon name="list" size={16} class={s().planning() ? "tint-brand" : "tint-ink-muted group-hover:tint-ink"} />
      <If when={words}>
        <Text class={`text-[12px] font-medium ${s().planning() ? "text-brand" : "text-ink-muted group-hover:text-ink"}`}>{t().project.plan}</Text>
      </If>
    </View>
  );
  /** The consultants' sheet alone, with no pill (the phone's): opened through `onHandle`. */
  const consultPill = (onHandle: (handle: ConsultHandle | null) => void) => (
    <ConsultPill
      pill={false}
      onHandle={onHandle}
      setting={props.selected.project_consult}
      agentName={s().agentName()}
      disabled={!connected()}
      agents={agentsStatus()}
      claude={claudeStatus()}
      client={runtime.client}
      onOpen={s().askConsultOptions}
      onChange={(next) => void s().setConsult(next)}
    />
  );
  /** The account, model and level; bare on a phone, where the + opens its sheet. */
  const agentTune = (bare: boolean) => (
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
      bare={bare}
      onHandle={bare ? (handle) => tuneSheet.set(handle) : undefined}
    />
  );

  /** One editor per conversation, as in `Composer`: undo history, IME state and any late revision stay with the session. */
  const editorNode = () => (
    <Each of={[props.selected.id]} key={(id: string) => id}>
      {() => {
        let mine: ComposerEditorHandle | null = null;
        return (
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
            onHandle={(handle) => {
              if (handle) editor = mine = handle;
              else if (editor === mine) editor = null;
            }}
          />
        );
      }}
    </Each>
  );

  return (
    <View
      testID="project-composer"
      class="w-full min-w-0 items-center"
      style={footerStyle()}
      onLayout={(e) => width.set(e.bounds.size.width)}
    >
      <View class={`w-full min-w-0 ${docked() ? "bg-pane border-t border-line" : "max-w-[800px]"}`}>
        <WaitingJump hidden={props.hiddenWaiting ?? NO_WAITING} onJump={(id) => props.onJumpWaiting?.(id)} />
        <If when={suggestionsShown()}>
          <ComposerSuggestions suggestions={view().composerSuggestions.slice()} docked={docked()} onPickPrompt={pickSuggestion} />
        </If>
        <View class="w-full relative" style={framedDockStyle()}>
        {/* Focused, it keeps its focus border under the pointer, as a Bot's composer does (`Composer`). */}
        <View
          testID="project-composer-card"
          onFileDragEnter={() => fileOver.set(true)}
          onFileDragLeave={() => fileOver.set(false)}
          onFileDrop={(e) => onFileDrop(e.uris, e.mimeTypes)}
          class={`w-full min-w-0 border ${
            framedPhoneCard()
              ? "rounded-[20px] bg-chip border-line px-[6px] pt-[4px] pb-[6px] focus-within:border-field-focus-border"
              : docked()
                ? "border-0 bg-transparent px-2 py-[6px]"
                : "bg-input-bg px-2 py-[6px] rounded-(--radius-xl) border-line hover:border-line-hover focus-within:border-field-focus-border hover:focus-within:border-field-focus-border"
          }`}
          style={cardStyle()}
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
          <If when={!inlinePhone()}>
            <View class={framedPhoneCard() ? "w-full min-w-0 px-[6px]" : "w-full min-w-0"}>{editorNode()}</View>
          </If>
          <View
            testID="project-composer-tool-row"
            class={`flex-row w-full gap-[6px] ${inlinePhone() ? "items-end" : "items-center"}`}
            onLayout={(e) => rowWidth.set(e.bounds.size.width)}
          >
            <If
              when={phone()}
              else={
                <>
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
                  <If when={s().caps().plan}>{planPill()}</If>
                  {/* The consultant switch (ADR 0116), the session's own: on, every line goes to the chosen consultants first. Every agent has it. */}
                  <ConsultPill
                    setting={props.selected.project_consult}
                    agentName={s().agentName()}
                    disabled={!connected()}
                    agents={agentsStatus()}
                    claude={claudeStatus()}
                    client={runtime.client}
                    onOpen={s().askConsultOptions}
                    onChange={(next) => void s().setConsult(next)}
                  />
                  {/* An account changes for the next run: Claude Code keeps the session under the account it ran on. */}
                  <View class="shrink min-w-0 flex-row">{agentTune(false)}</View>
                </>
              }
            >
              <ComposerPlus testID="project-plus" filled={phonePillButtons()} disabled={!connected()}>
                {(close) => (
                  <>
                    {/* The sheets the rows open, held here so they go over this one. */}
                    {agentTune(true)}
                    {consultPill((handle) => plusConsult.set(handle))}
                    <SheetItem
                      role="menuitem"
                      testID="project-plus-attach"
                      icon="paperclip"
                      label={t().composer.attach}
                      disabled={!connected() || Boolean(view().sending)}
                      onPress={() => {
                        close();
                        void pickFiles();
                      }}
                    />
                    <If when={s().caps().plan}>
                      <PlusSwitch
                        testID="project-plus-plan"
                        icon="list"
                        label={t().project.planMode}
                        detail={t().project.planModeDetail(s().agentName())}
                        checked={s().planning()}
                        disabled={!connected()}
                        onChange={() => s().togglePlan()}
                      />
                    </If>
                    <SheetItem
                      role="menuitem"
                      testID="project-plus-consult"
                      icon="users"
                      label={t().project.consult}
                      detail={consultDetail()}
                      active={s().consulting()}
                      disabled={!connected()}
                      onPress={() => plusConsult()?.open()}
                      trailing={<Deeper />}
                    />
                    <SheetItem
                      role="menuitem"
                      testID="project-plus-tune"
                      icon={tuneMark() ? undefined : "sparkle"}
                      leading={tuneMark() ? <ModelSourceMark source={tuneMark()!} tile size={20} /> : undefined}
                      label={t().composer.model}
                      detail={tuneSheet() ? tuneLine(tuneSheet()!.shown()) : undefined}
                      disabled={!connected()}
                      onPress={() => tuneSheet()?.open()}
                      trailing={<Deeper />}
                    />
                  </>
                )}
              </ComposerPlus>
              {/* What changes what Send does stays in sight while it is on: one press turns plan mode off, the consultants' chip opens their sheet.
                  They take the room the row leaves them (`phone-chips.ts`): the consultants' logos give way to their number, then plan mode's
                  word to its icon, so at 360 pt with both on, the microphone and a run's stop menu the row still fits; on a narrower phone
                  the chips give way (clipped) before Send or Stop would leave it. The context ring is in the header on a phone
                  (`ProjectContextTop`). */}
              <If when={phoneHasChips()}>
                <View class="shrink min-w-0 flex-row items-center gap-[6px] overflow-hidden">
                  <If when={s().caps().plan && s().planning()}>{planPill(chips().planWords)}</If>
                  <If when={s().consulting()}>
                    <ConsultChip look={chips().consultLogos ? "logos" : "count"} setting={props.selected.project_consult} agentName={s().agentName()} disabled={!connected()} onPress={() => chipConsult?.open()} />
                  </If>
                </View>
              </If>
            </If>
            <If
              when={inlinePhone()}
              else={<View class="flex-1" />}
            >
              <View testID="project-input-well" class="flex-1 min-w-0 rounded-[20px] bg-chip border border-line px-[10px] focus-within:border-field-focus-border">
                {editorNode()}
              </View>
            </If>
            {/* Right of the spring, measured as one: what the phone's chips leave room for. */}
            <View class="shrink-0 flex-row items-center gap-[6px]" onLayout={(e) => rightWidth.set(e.bounds.size.width)}>
              {/* On a phone the header shows it, where a press opens its figures (`ProjectContextTop`). */}
              <If when={!phone()}>
                <ProjectContextPill context={props.selected.project_context} compact={compact()} />
              </If>
              <If when={voiceOffered() || voice.busy}>
                <VoiceButton voice={voice} disabled={!connected()} filled={phonePillButtons()} />
              </If>
              <If when={!(docked() && (sendable() || suggestBlocked()))}>
                <SuggestButton
                  sizeClass={suggestSize()}
                  label={suggestTitleOf({ suggestionsShown: suggestionsShown(), suggestWaiting: suggestWaiting() }, Boolean(view().suggestionsLoading), t())}
                  disabled={suggestBlocked()}
                  active={suggestionsShown()}
                  loading={Boolean(view().suggestionsLoading)}
                  filled={phonePillButtons()}
                  onPress={toggleSuggestions}
                />
              </If>
              <If when={s().stopItems().length > 0}>
                <StopMenu items={s().stopItems()} disabled={!connected()} onPick={s().pickStop} />
              </If>
              {/* Stop beside Send while the agent works, as in a Bot's direct: a line sent meanwhile goes into the run. */}
              <SendButton
                connected={connected()}
                primaryAction={{ kind: "send", disabled: !sendable() || Boolean(view().sending) || !connected() }}
                directStop={s().live() && s().stopItems().length === 0}
                stepsAside={sendStepsAside()}
                sending={view().sending}
                upload={view().upload}
                onStop={() => void s().stop()}
                onSend={() => void send()}
              />
            </View>
          </View>
          {/* The consultants' chip's sheet: outside the row, so switching them off there takes the chip, not the sheet. */}
          <If when={phone()}>{consultPill((handle) => (chipConsult = handle))}</If>
          <DropVeil shown={dropShown()} testID="project-drop-veil" />
        </View>
        <ScrollBottomButton shown={props.showScrollBottom === true} onScrollToBottom={props.onScrollToBottom} />
        </View>
      </View>
    </View>
  );
}
