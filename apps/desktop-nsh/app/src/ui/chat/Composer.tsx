/**
 * The whole message composer (`Composer.svelte`): the box with its @ list, a quote, staged files, the
 * microphone, ✨ suggestions, the stop menu and Send, wired to the runtime. The draft, the quote, the
 * staged files and the send state are the conversation's own (`runtime.sessionView(id)`), so two
 * composers on screen never read one draft. The parts are the ported ones next door; what this adds
 * is the wiring: drafts, sending (the stage's `onSend` goes through here), attachments, the locked
 * state, stop, voice.
 *
 * Differences from the Svelte one, all from the platform: the box is an `Input` (a mention is
 * `@Name ` text, not a chip; `ComposerEditor` owns the @ list, the keys and the input method);
 * files come from the system's image picker (the attach button), a paste (`PasteEvent.files` or a
 * Finder copy's `file:` URLs) and, in the file conversation, a drop (`onFileDrop`); the frosted ring
 * (no backdrop blur) and the file tree's drag-in (the tree is not ported) are left out; the stage
 * places it and reserves its height (`onHeight`). One row up to 480 wide, two rows above, the
 * floating card's margin 12 up to 680, as the container queries say; at 480 and under it is a bar
 * across the bottom rather than a card.
 */
import { cleanup, effect, Picker, platform, signal, Text, View } from "nsh";
import type { PasteEvent } from "nsh/types";
import { speechReady, type PatchBotRequest, type SessionSummary } from "@real-bot/protocol";
import { interfaceBehaviour } from "../../m/interface/behaviour.svelte";
import { formatShortcut } from "../../m/keymap";
import { justSent } from "../../m/chat/composer-mode";
import { ComposerAttachments as StagedFiles, uploadedShare } from "../../m/chat/composer-attachments.svelte";
import { ComposerVoice, insertHeardAt, spacedHeard, type Caret } from "../../m/chat/composer-voice.svelte";
import { conversationStopItems, type StopMenuItem } from "../../m/chat/stop-menu";
import { VoiceRecorder } from "../../m/chat/voice-recorder";
import type { WorkspaceDragItem } from "../../m/workspace-drag.svelte";
import { copy, runtime } from "../../runtime";
import { Icon } from "../Icon";
import { tip } from "../tip";
import { shadow } from "../styles";
import { BotTune } from "./BotTune";
import { ComposerAttachments } from "./ComposerAttachments";
import { ComposerEditor, type ComposerEditorHandle } from "./ComposerEditor";
import { ComposerQuote } from "./ComposerQuote";
import { ComposerSuggestions } from "./ComposerSuggestions";
import { ScrollBottomButton } from "./ScrollBottomButton";
import { SendButton } from "./SendButton";
import { StopMenu } from "./StopMenu";
import { VoiceButton } from "./VoiceButton";
import { VoiceStatus } from "./VoiceStatus";
import { WaitingJump } from "./WaitingJump";
import { deriveComposer, composerHintOf, filesFromUris, lockedNoticeOf, mentionBotsOf, placeholderOf, suggestTitleOf } from "./composer-state";
import type { HiddenWaiting } from "./waiting-jump";
import { settled } from "../workbench/drag-settle";

/** What the owner can do to the composer from outside: a quote reply or a starter chip lands the caret here; the file tree stages what is dragged out of it. */
export type ComposerHandle = {
  focus(): void;
  takesWorkspaceItems(): boolean;
  stageWorkspaceItems(items: WorkspaceDragItem[]): void;
};

/** The conversation's width, up to which the composer is a docked bar (480) and a card with a 12 margin (680). */
const DOCKED = 480;
const PHONE = 680;

const NO_WAITING: HiddenWaiting = { items: [], above: false };

export function Composer(props: {
  selected: SessionSummary | null;
  /** The stage owns scrolling, so sending goes back through it. True when the line went out. */
  onSend: (files: File[], paths: string[]) => Promise<boolean>;
  /** A suggestion fills the draft. */
  onPickPrompt: (prompt: string) => void;
  /** The stage owns stick-to-bottom; this only draws the jump control on the card. */
  showScrollBottom?: boolean;
  onScrollToBottom?: () => void;
  /** ↑ in an empty box: open your newest line here for changing (ADR 0063). True when one opened. */
  onEditLast?: () => boolean;
  /** Approvals and questions waiting here whose card is scrolled out of sight (`hiddenWaiting`); the stage measures. */
  hiddenWaiting?: HiddenWaiting;
  onJumpWaiting?: (id: string) => void;
  onHandle?: (handle: ComposerHandle | null) => void;
  /** The composer's height, for the stage to reserve room for it. */
  onHeight?: (height: number) => void;
  /** Where the microphone's recording comes from (the recorder, unless a test brings its own). */
  makeRecorder?: () => VoiceRecorder;
  /** Reads the local files a drop or a Finder copy names (`file:` URLs) into `File`s; by default `fetch`, which a host that lets the app read local files makes work. */
  readFiles?: (uris: readonly string[]) => Promise<File[]>;
}) {
  const MOD_ENTER = formatShortcut(["mod", "Enter"]);
  const snapshot = () => runtime.snapshot;
  /** This conversation's own draft, reply, staged files. Never the runtime's forwards. */
  const view = () => (props.selected ? runtime.sessionView(props.selected.id) : null);
  const botsById = () => new Map(snapshot().bots.map((bot) => [bot.id, bot] as const));
  const visibleBots = () => snapshot().bots.filter((bot) => !bot.archived_at);
  const connected = () => runtime.connection === "connected";
  const width = signal(0);
  const docked = settled(() => width() > 0 && width() <= DOCKED);
  const wide = settled(() => width() > DOCKED);

  let editor: ComposerEditorHandle | null = null;
  const tuneFailedFor = signal<string | null>(null);
  let sentAt: number | null = null;

  const d = () =>
    deriveComposer({
      snapshot: snapshot(),
      connected: connected(),
      session: props.selected,
      view: view(),
      botsById: botsById(),
      staged: files.pendingAttachments.length + files.pendingPaths.length,
    });

  // --- staged files ---
  const files = new StagedFiles({
    runtime: () => runtime,
    selected: () => props.selected,
    view,
    lockedComposer: () => d().locked,
    connected,
    fileDrop: () => d().fileDrop,
    // No DOM box to focus: the editor's own handle does it.
    editorEl: () => ({ focus: () => editor?.focus() }) as unknown as HTMLDivElement,
  });
  const canStage = () => Boolean(props.selected) && !d().locked && connected() && !view()?.sending;

  async function pickFiles(): Promise<void> {
    if (!canStage()) return;
    try {
      const picked = await Picker.pickImages({ multiple: true });
      if (picked.length > 0) files.addFiles(picked.map((row) => row.file));
    } catch {
      // The picker was refused or is not here: nothing to stage.
    }
  }

  const readFiles = (uris: readonly string[]) => (props.readFiles ?? filesFromUris)(uris);

  /** Files a paste carries; the text goes into the box by the input itself. */
  function onPaste(event: PasteEvent): void {
    if (d().locked || !props.selected) return;
    if (event.files.length > 0) files.addFiles(event.files);
    else if (event.uris.length > 0) void readFiles(event.uris).then((read) => read.length > 0 && files.addFiles(read));
  }

  /** The file conversation takes files dropped on it from the desktop; no other does. */
  function onFileDrop(uris: string[]): void {
    if (!d().fileDrop || !canStage() || uris.length === 0) return;
    void readFiles(uris).then((read) => read.length > 0 && files.addFiles(read));
  }

  // --- the microphone (ADR 0073): what is heard goes in where the caret was, in the conversation it was recorded for ---
  let voiceCaret: Caret | null = null;
  const voice = new ComposerVoice({
    api: () => runtime.client,
    t: () => copy(),
    sessionId: () => props.selected?.id ?? null,
    markCaret: () => {
      voiceCaret = editor?.selection() ?? null;
    },
    insert: (sessionId, heard) => {
      const caret = voiceCaret;
      voiceCaret = null;
      const target = runtime.sessionView(sessionId);
      if (props.selected?.id === sessionId) {
        const next = insertHeardAt(target.draft, caret, heard);
        target.draft = next.text;
        setTimeout(() => editor?.setSelection(next.caret), 0);
        return;
      }
      target.draft = target.draft + spacedHeard(target.draft, heard);
    },
    makeRecorder: () => (props.makeRecorder ? props.makeRecorder() : new VoiceRecorder()),
  });
  cleanup(() => voice.cancel());
  /** Offered once a speech endpoint is ready, wherever you can type. */
  const voiceOffered = () => speechReady(snapshot().settings.speech) && Boolean(props.selected) && !d().locked;

  // --- stop, tune, suggestions ---
  /**
   * A group's stop menu: the group, each Bot at work in it, this job, every Bot (ADR 0040 P2). Only
   * once the daemon has stops, and only while someone in it is at work. A direct has no menu.
   */
  const stopItems = (): StopMenuItem[] => {
    const session = props.selected;
    const snap = snapshot();
    return session?.kind === "group" && snap.holdsOn && !d().locked
      ? conversationStopItems({ session, turns: snap.turns, bots: botsById(), holds: snap.holds, t: copy().control, deleted: copy().top.deleted, sessions: snap.sessions })
      : [];
  };
  /** A refusal comes back for the menu to say. */
  function pickStop(item: StopMenuItem): Promise<unknown> | void {
    if (!props.selected) return;
    return runtime.stopScope(item.choice.scope, item.choice.id, props.selected.id, { liftOnNext: item.choice.liftOnNext });
  }

  /**
   * A direct with a Bot you can write to picks the Bot's model on the tool row, as a project
   * session's composer does. A refusal says so under the box, in that Bot's direct only.
   */
  const tuneBot = () => {
    const state = d();
    return state.kind === "you-bot" && !state.locked && !state.fileDrop && state.peerBot && !state.peerBot.archived_at ? state.peerBot : null;
  };
  async function tuneModel(botId: string, change: PatchBotRequest): Promise<void> {
    const failure = await runtime.patchBot(botId, change);
    tuneFailedFor.set(failure ? botId : tuneFailedFor() === botId ? null : tuneFailedFor());
  }

  /** One press drafts once; pressing again while drafts are out or on the way puts them away. */
  function toggleSuggestions(): void {
    const current = view();
    if (!props.selected || !current) return;
    if (current.suggestionsLoading || d().suggestionsShown) {
      runtime.dismissComposerSuggestions(props.selected.id);
      return;
    }
    if (justSent(sentAt, performance.now())) return;
    void runtime.suggestComposer(props.selected.id);
  }
  function stopDirect(): void {
    if (justSent(sentAt, performance.now())) return;
    void runtime.stopTurn(props.selected?.id);
  }

  /** Send greyed with nothing to send steps aside, where the composer is narrow, for what can be pressed instead. */
  const sendStepsAside = () => {
    const state = d();
    return docked() && state.primary.kind === "send" && !state.hasContent && !view()?.sending && (state.directStop || stopItems().length > 0 || (state.canSuggest && !state.suggestBlocked));
  };

  // "Nothing to suggest" answers the press; it is not worth keeping on screen.
  effect(() => {
    const current = view();
    if (!current?.suggestionsEmpty) return;
    const timer = setTimeout(() => {
      current.suggestionsEmpty = false;
    }, 4000);
    return () => clearTimeout(timer);
  });

  const quoteTarget = () => {
    const id = view()?.replyingToId;
    return id ? (snapshot().messages.find((message) => message.id === id) ?? null) : null;
  };

  /**
   * What was staged stays staged until the Mac has it: a send that failed (a phone's link dropping
   * mid-upload) must not take the files and the words with it.
   */
  async function send(): Promise<void> {
    const state = d();
    const target = view();
    if (state.primary.kind !== "send" || state.primary.disabled || !target) return;
    const staged = [...files.pendingAttachments];
    const stagedPaths = [...files.pendingPaths];
    if (!(await props.onSend(staged.map((row) => row.file), stagedPaths.map((row) => row.path)))) return;
    sentAt = performance.now();
    for (const row of [...staged, ...stagedPaths]) if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
    const sent = new Set([...staged, ...stagedPaths].map((row) => row.id));
    target.stagedAttachments = target.stagedAttachments.filter((row) => !sent.has(row.id));
    target.stagedPaths = target.stagedPaths.filter((row) => !sent.has(row.id));
  }

  props.onHandle?.({
    focus: () => editor?.focus(),
    takesWorkspaceItems: () => files.takesWorkspaceItems(),
    stageWorkspaceItems: (items) => files.stageWorkspaceItems(items),
  });
  cleanup(() => props.onHandle?.(null));

  const hint = () =>
    composerHintOf({
      session: props.selected,
      liveTurn: d().liveTurn,
      pending: d().pending,
      modSends: interfaceBehaviour().send_key === "mod_enter",
      modEnter: MOD_ENTER,
      turnInbox: snapshot().turnInbox,
      linesInOrder: snapshot().linesInOrder,
      t: copy(),
    });
  const tool = () => (docked() && !platform.desktop ? "w-[40px] h-[40px]" : "w-[34px] h-[34px]");
  const edge = () => (width() <= PHONE ? 12 : 24);
  const toolRow = () => !d().locked;

  /** A round tool button, as the Svelte's `.attach-btn` / `.suggest-btn`. */
  const ToolButton = (p: { testID: string; icon: "paperclip" | "sparkles" | "spinner"; label: string; disabled?: boolean; active?: boolean; busy?: boolean; onPress: () => void }) => (
    <View
      role="button"
      testID={p.testID}
      tooltip={tip(p.label)}
      accessibilityLabel={p.label}
      accessibilityState={{ disabled: p.disabled, selected: p.active, busy: p.busy }}
      disabled={p.disabled}
      onPress={p.onPress}
      class={`group shrink-0 items-center justify-center rounded-full active:scale-[0.96] disabled:opacity-[0.4] ${tool()} ${p.active ? "bg-accent-tint" : "hover:bg-line-subtle"}`}
    >
      <Icon name={p.icon} size={p.icon === "paperclip" ? 20 : 16} class={`${p.icon === "spinner" ? "animate-spin " : ""}${p.active || p.busy ? "tint-brand" : "tint-ink-muted group-hover:tint-ink"}`} />
    </View>
  );

  /**
   * The text on a line of its own above the tool row: always where the composer is wide, and where
   * it is docked (a phone) too once the row carries the Bot's model, as the Svelte's `.has-tune`
   * row wraps the editor to the top; a docked row without one keeps the text between its buttons.
   */
  const editorAbove = () => wide() || Boolean(tuneBot());
  const editorBox = () => (
    <View class={editorAbove() ? "w-full min-w-0" : "flex-1 min-w-0"}>
      <ComposerEditor
        value={view()?.draft ?? ""}
        onChange={(text) => {
          const current = view();
          if (current) current.draft = text;
        }}
        placeholder={placeholderOf(props.selected, d().peerBot, copy())}
        editable={Boolean(props.selected) && !d().locked}
        fileDrop={d().fileDrop}
        isGroup={props.selected?.kind === "group"}
        mentionBots={mentionBotsOf(props.selected, botsById(), visibleBots())}
        onSend={() => void send()}
        onEditLast={props.onEditLast}
        onPaste={onPaste}
        onHandle={(handle) => (editor = handle)}
      />
    </View>
  );

  return (
    <View
      testID="composer-footer"
      class="w-full min-w-0 items-center"
      style={docked() ? undefined : { paddingLeft: edge(), paddingRight: edge(), paddingTop: 10, paddingBottom: 12 }}
      onLayout={(e) => {
        width.set(e.bounds.size.width);
        props.onHeight?.(Math.ceil(e.bounds.size.height));
      }}
    >
      <View class={`w-full min-w-0 ${docked() ? "bg-input-bg border-t border-line" : "max-w-[760px]"}`}>
        <WaitingJump hidden={props.hiddenWaiting ?? NO_WAITING} onJump={(id) => props.onJumpWaiting?.(id)} />
        <If when={d().canSuggest && view() && d().suggestionsShown}>
          <View role="group" accessibilityLabel={copy().chat.suggestNext} class="self-start max-w-full min-w-0">
            <ComposerSuggestions suggestions={view()!.composerSuggestions.slice()} onPickPrompt={props.onPickPrompt} />
          </View>
        </If>

        <View class="w-full relative">
          <View
            testID="composer-card"
            onFileDrop={(e) => onFileDrop(e.uris)}
            class={`w-full min-w-0 border bg-input-bg ${d().locked ? "bg-sidebar-bg border-dashed px-[14px] py-[10px]" : docked() ? "px-2 py-[6px]" : "px-2 py-[6px]"} ${docked() ? "border-0" : d().locked ? "rounded-[18px] border-line" : "rounded-[18px] border-line hover:border-line-hover focus-within:border-field-focus-border"}`}
            style={docked() ? undefined : { boxShadow: shadow("raised") }}
          >
            <If when={quoteTarget()}>{(message) => <ComposerQuote message={message()} botsById={botsById()} onCancel={() => { const current = view(); if (current) current.replyingToId = null; }} />}</If>
            <If when={d().locked}>
              <View testID="composer-locked" class="flex-row items-center justify-center gap-1 py-1">
                <Icon name="lock" class="tint-ink-muted" />
                <Text class="text-[13px] font-medium text-ink-muted">{lockedNoticeOf(props.selected, botsById(), copy())}</Text>
              </View>
            </If>
            <If when={!d().locked}>
              <VoiceStatus voice={voice} />
            </If>
            <If
              when={view()?.sendRefused}
              else={
                <If when={tuneBot() && tuneFailedFor() === tuneBot()!.id}>
                  <Text role="alert" testID="composer-refused" class="text-[12px] text-danger px-1 pt-[2px] pb-[6px]">{copy().composer.tuneFailed}</Text>
                </If>
              }
            >
              <Text role="alert" testID="composer-refused" class="text-[12px] text-danger px-1 pt-[2px] pb-[6px]">
                {view()?.sendRefused === "too_many_files" ? copy().composer.tooManyFiles : copy().composer.sendRefused}
              </Text>
            </If>
            <If when={files.pendingAttachments.length > 0 || files.pendingPaths.length > 0}>
              <ComposerAttachments
                api={runtime.client}
                pendingAttachments={files.pendingAttachments.slice()}
                pendingPaths={files.pendingPaths.slice()}
                sending={view()?.sending}
                uploadedPercent={(file) => uploadedShare(view()?.upload, file)}
                onRemoveAttachment={files.removePendingAttachment}
                onRemovePath={files.removePendingPath}
              />
            </If>

            <If when={toolRow() && editorAbove()}>{editorBox()}</If>
            <If when={toolRow()}>
              <View class="flex-row items-center w-full gap-2">
                <ToolButton
                  testID="attach-button"
                  icon="paperclip"
                  label={copy().composer.attach}
                  disabled={!connected() || !props.selected || d().locked || Boolean(view()?.sending)}
                  onPress={() => void pickFiles()}
                />
                <If when={tuneBot()}>
                  <View class="min-w-0 flex-row">
                    <BotTune bot={tuneBot()!} disabled={!connected()} onPick={(change) => void tuneModel(tuneBot()!.id, change)} />
                  </View>
                </If>
                <If when={editorAbove()} else={editorBox()}>
                  <View class="flex-1" />
                </If>
                <If when={voiceOffered() || voice.busy}>
                  <VoiceButton voice={voice} disabled={!connected()} />
                </If>
                <If when={d().canSuggest && !(docked() && (d().hasContent || d().suggestBlocked))}>
                  <ToolButton
                    testID="suggest-button"
                    icon={view()?.suggestionsLoading ? "spinner" : "sparkles"}
                    label={suggestTitleOf(d(), Boolean(view()?.suggestionsLoading), copy())}
                    disabled={d().suggestBlocked}
                    active={d().suggestionsShown}
                    busy={Boolean(view()?.suggestionsLoading)}
                    onPress={toggleSuggestions}
                  />
                </If>
                <If when={stopItems().length > 0}>
                  <StopMenu items={stopItems()} disabled={!connected()} onPick={pickStop} />
                </If>
                <SendButton
                  connected={connected()}
                  primaryAction={d().primary}
                  directStop={d().directStop}
                  stepsAside={sendStepsAside()}
                  sending={view()?.sending}
                  upload={view()?.upload}
                  onStop={stopDirect}
                  onSend={() => void send()}
                />
              </View>
            </If>
          </View>
          <ScrollBottomButton shown={props.showScrollBottom === true} onScrollToBottom={props.onScrollToBottom} />
        </View>
        <If when={!d().locked}>
          <View accessible={false} class="w-[1px] h-[1px] overflow-hidden">
            <Text role="text" testID="composer-hint" class="text-[1px] opacity-0">{hint()}</Text>
          </View>
        </If>
      </View>
    </View>
  );
}
