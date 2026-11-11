/** The object the transcript's rows read (`TranscriptStage`), built from the stage's context and handlers: getters stay live, so a row reading one follows the signals behind it. */
import type { Attachment, SessionSummary } from "@real-bot/protocol";
import { focusMode } from "../../m/chat/focus-mode.svelte.ts";
import type { TranscriptStage } from "../../m/chat/transcript-stage.ts";
import type { StageActions } from "./stage-actions";
import type { StageContext } from "./stage-context";

export function buildStage(
  ctx: StageContext,
  actions: StageActions,
  input: {
    selected: () => SessionSummary | null;
    highlightedId: () => string | null;
    onOpenProfile: (botId: string) => void;
    onOpenArtifact: (relpath: string, att?: Attachment, messageId?: string, forceTree?: boolean) => void;
  },
): TranscriptStage {
  const none = () => undefined;
  return {
    get snapshot() {
      return ctx.snapshot();
    },
    get view() {
      return ctx.view();
    },
    get selected() {
      return input.selected();
    },
    get selectedKind() {
      return ctx.selectedKind();
    },
    get botsById() {
      return ctx.botsById();
    },
    get locale() {
      return ctx.locale();
    },
    get connected() {
      return ctx.connected();
    },
    get lockedComposer() {
      return ctx.lockedComposer();
    },
    get fileDrop() {
      return ctx.fileDrop();
    },
    get sidesSayWho() {
      return ctx.sidesSayWho();
    },
    get focus() {
      return focusMode.on;
    },
    get highlightedId() {
      return input.highlightedId();
    },
    get selectedMessageId() {
      return actions.selectedMessageId();
    },
    get copiedMessageId() {
      return actions.copiedMessageId();
    },
    get statusLabels() {
      return ctx.statusLabels();
    },
    get rosterLabels() {
      return ctx.rosterLabels() as TranscriptStage["rosterLabels"];
    },
    get liveTurnsHere() {
      return ctx.liveTurnsHere();
    },
    get announced() {
      return ctx.announced();
    },
    get messageLookup() {
      return ctx.messageLookup();
    },
    get commandHosts() {
      return ctx.commandHosts();
    },
    get annotationIndex() {
      return ctx.annotationIndex();
    },
    get botDmIndex() {
      return ctx.botDmIndex();
    },
    get cardErrors() {
      return actions.cardErrors();
    },
    get versionsShown() {
      return actions.versionsShown();
    },
    get editErrorText() {
      return actions.editErrorText();
    },
    get nowMs() {
      return ctx.nowMs();
    },
    get arriving() {
      return ctx.arriving();
    },
    get approvalKeys() {
      return actions.approvalKeys();
    },
    set approvalKeys(value) {
      actions.approvalKeys.set(value);
    },
    get approvalKeyErrors() {
      return actions.approvalKeyErrors();
    },
    set approvalKeyErrors(value) {
      actions.approvalKeyErrors.set(value);
    },
    get openStepsTurn() {
      return actions.openStepsTurn();
    },
    set openStepsTurn(value) {
      actions.openStepsTurn.set(value);
    },
    get onOpenProfile() {
      return input.onOpenProfile;
    },
    get onOpenArtifact() {
      return input.onOpenArtifact;
    },
    who: ctx.who,
    whoAuthor: ctx.whoAuthor,
    botNameOf: ctx.botNameOf,
    markdownOpts: ctx.markdownOpts,
    messageBody: ctx.messageBody,
    messageShowsAttachments: ctx.messageShowsAttachments,
    loadBodyImage: actions.loadBodyImage,
    // The Svelte's `from` is an element; here the view the picture was pressed in.
    openBodyImage: actions.openBodyImage as TranscriptStage["openBodyImage"],
    openInlineImage: actions.openInlineImage as TranscriptStage["openInlineImage"],
    openInlineFile: actions.openInlineFile,
    openAnnotation: actions.openAnnotation,
    toggleAnnotation: actions.toggleAnnotation,
    annotationSourceLabel: actions.annotationSourceLabel,
    openAnnotationSource: actions.openAnnotationSource,
    editable: actions.editable,
    editingHere: actions.editingHere,
    startEdit: actions.startEdit,
    queuedLine: actions.queuedLine,
    withdrawLine: actions.withdrawLine,
    reEditLine: actions.reEditLine,
    insertLine: actions.insertLine,
    lineBusy: actions.lineBusy,
    insertTitle: actions.insertTitle,
    lineNoteText: actions.lineNoteText,
    toggleVersions: actions.toggleVersions,
    copyMessageBody: actions.copyMessageBody,
    startQuoteReply: actions.startQuoteReply,
    // The groups hear a secondary press themselves (`onContextMenu`), and a touch needs no flag.
    handleMessageMouseDown: none,
    handleMessageTouchStart: none,
    handleMessageContextMenu: none,
    pressControl: actions.pressControl,
    replyAsk: actions.replyAsk,
    showMessageTrace: actions.showMessageTrace,
  };
}
